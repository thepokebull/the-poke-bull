// Fair round-robin airdrops of pulled cards to coin holders.
//
// Eligibility: wallets holding between AIRDROP_MIN_PCT and AIRDROP_MAX_PCT of
// supply (default 0.5%–3%). After each pull we pick a RANDOM eligible holder who
// hasn't received a card THIS round, send the card there, and record them. When
// every eligible holder has one, the round resets and starts over.
//
// State persists to airdrop-state.json so restarts never double-airdrop within a
// round. Activates as soon as COIN_MINT is set.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

function stateFile() { return process.env.AIRDROP_STATE || new URL("../airdrop-state.json", import.meta.url).pathname; }
function readState() {
  try { return JSON.parse(readFileSync(stateFile(), "utf8")); }
  catch { return { round: 1, airdropped: {}, history: [] }; }
}
function writeState(s) { writeFileSync(stateFile(), JSON.stringify(s, null, 2)); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// RPC POST with retry/backoff so a transient 429/5xx never silently truncates the
// holder list (which would let ineligible wallets slip through / miss real holders).
async function rpcPost(rpc, body, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status >= 500) { last = new Error(`RPC ${res.status}`); await sleep(400 * (i + 1)); continue; }
      return await res.json();
    } catch (e) { last = e; await sleep(400 * (i + 1)); }
  }
  throw last || new Error("RPC request failed");
}

// Wallets never eligible: the bot's own wallet + any configured LP/program excludes.
function excludeSet() {
  const ex = new Set((process.env.AIRDROP_EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (process.env.WALLET_ADDRESS) ex.add(process.env.WALLET_ADDRESS.trim());
  return ex;
}

// --- Fetch all holders and keep those within the % band ---
// Cache the eligible-holder snapshot briefly so a cycle opening many packs doesn't
// re-fetch every holder for each one (that would blow the RPC rate limit).
let _holdersCache = { key: "", value: null, at: 0 };
// Returns eligible holders each tagged with a `weight`:
//   pct >= `full`  -> weight 1   (default full tier)
//   `floor` <= pct < `full` -> weight 0.5 (half-weight tier)
// `floor` defaults to `min` and `full` defaults to `min`, so the legacy call
// getEligibleHolders(mint,{min,max}) is unchanged: one tier, all weight 1.
export async function getEligibleHolders(mint, { min = 0.005, max = 0.04, floor, full, ttlMs = 45000 } = {}) {
  const lo = floor ?? min;          // eligibility floor (lowest % that qualifies at all)
  const fullPct = full ?? min;      // >= this = full weight (1); between lo and this = 0.5
  const cacheKey = `${mint}:${lo}:${fullPct}:${max}`;
  if (_holdersCache.value && _holdersCache.key === cacheKey && Date.now() - _holdersCache.at < ttlMs) {
    return _holdersCache.value;
  }
  const rpc = process.env.RPC_URL;
  const conn = new Connection(rpc, "confirmed");
  const supply = await conn.getTokenSupply(new PublicKey(mint));
  const rawTotal = Number(supply.value.amount);
  if (!rawTotal) return [];

  // Helius DAS getTokenAccounts → sum raw balances per owner (paginated).
  const balances = {};
  let page = 1;
  while (page <= 50) {
    const j = await rpcPost(rpc, { jsonrpc: "2.0", id: "ta", method: "getTokenAccounts", params: { mint, page, limit: 1000 } });
    const accts = j?.result?.token_accounts || [];
    for (const a of accts) balances[a.owner] = (balances[a.owner] || 0) + Number(a.amount);
    if (accts.length < 1000) break;
    page++;
  }

  const ex = excludeSet();
  const result = Object.entries(balances)
    .map(([owner, amt]) => ({ owner, amount: amt, pct: amt / rawTotal }))
    .filter((h) => !ex.has(h.owner) && h.pct >= lo && h.pct <= max)
    .map((h) => ({ ...h, weight: h.pct >= fullPct ? 1 : 0.5 }))
    .sort((a, b) => b.pct - a.pct);
  _holdersCache = { key: cacheKey, value: result, at: Date.now() };
  return result;
}

// --- Round-robin pick: random eligible holder not yet airdropped this round ---
// opts.holders (array of {owner,pct}) bypasses the on-chain fetch (used for tests).
export async function pickRecipient(mint, opts = {}) {
  const eligible = opts.holders || await getEligibleHolders(mint, opts);
  if (!eligible.length) return { recipient: null, eligibleCount: 0, reason: "no eligible holders in band" };

  let state = readState();
  let remaining = eligible.filter((h) => !state.airdropped[h.owner]);
  let roundReset = false;
  if (remaining.length === 0) {                 // everyone covered → new round
    state.round += 1; state.airdropped = {}; writeState(state);
    remaining = eligible; roundReset = true;
  }
  const pick = remaining[Math.floor(Math.random() * remaining.length)];
  return {
    recipient: pick.owner, pct: pick.pct, round: state.round,
    eligibleCount: eligible.length, remainingInRound: remaining.length, roundReset,
  };
}

// The COMMITTED next recipient (shown as "next airdrop" and used by the loop).
// Returns the stored next if still valid; otherwise picks + stores a fresh one.
export async function ensureNext(mint, opts = {}) {
  const eligible = opts.holders || await getEligibleHolders(mint, opts);
  const s = readState();
  if (!eligible.length) {
    if (s.nextRecipient) { s.nextRecipient = null; writeState(s); }
    return { recipient: null, eligibleCount: 0 };
  }
  const valid = s.nextRecipient && eligible.some((h) => h.owner === s.nextRecipient) && !s.airdropped[s.nextRecipient];
  if (valid) return { recipient: s.nextRecipient, round: s.round, eligibleCount: eligible.length };

  let remaining = eligible.filter((h) => !s.airdropped[h.owner]);
  let roundReset = false;
  if (remaining.length === 0) { s.round += 1; s.airdropped = {}; remaining = eligible; roundReset = true; }
  s.nextRecipient = remaining[Math.floor(Math.random() * remaining.length)].owner;
  writeState(s);
  return { recipient: s.nextRecipient, round: s.round, eligibleCount: eligible.length, remainingInRound: remaining.length, roundReset };
}

// Mark a wallet as airdropped in the current round (call AFTER a successful send).
export function recordAirdrop(recipient, cardMint, signature) {
  const s = readState();
  s.airdropped[recipient] = { cardMint, signature, ts: Date.now() };
  s.history.push({ recipient, cardMint, signature, round: s.round, ts: Date.now() });
  if (s.nextRecipient === recipient) s.nextRecipient = null; // consumed → recommit later
  writeState(s);
  return s;
}

export function airdropStatus() {
  const s = readState();
  return { round: s.round, airdroppedThisRound: Object.keys(s.airdropped).length, totalAirdrops: s.history.length };
}

// --- Send the pulled card from the bot wallet to `recipient` ---
// Collector Crypt issues cards in TWO standards: Metaplex Core assets (current) and
// token-metadata (p)NFTs (older). We detect via DAS `interface` and use the matching
// transfer program, so either kind airdrops correctly.
export async function sendCard({ keypair, cardMint, recipient, dryRun = true }) {
  if (dryRun) return { dryRun: true };
  if (!cardMint) throw new Error("sendCard: no cardMint (card not identified from the pull)");

  const rpc = process.env.RPC_URL;
  const asset = (await rpcPost(rpc, { jsonrpc: "2.0", id: "a", method: "getAsset", params: { id: cardMint } }))?.result;
  if (asset?.compression?.compressed) {
    throw new Error("Card is a compressed cNFT — compressed transfer not wired yet.");
  }

  const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
  const { keypairIdentity, publicKey } = await import("@metaplex-foundation/umi");
  const umi = createUmi(rpc);
  const umiKp = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
  umi.use(keypairIdentity(umiKp));

  let res;
  if (asset?.interface === "MplCoreAsset") {
    // ── Metaplex Core transfer ── (single account; pass the collection if any)
    const { transferV1, mplCore } = await import("@metaplex-foundation/mpl-core");
    umi.use(mplCore());
    const collection = asset?.grouping?.find((g) => g.group_key === "collection")?.group_value;
    const args = { asset: publicKey(cardMint), newOwner: publicKey(recipient), ...(collection ? { collection: publicKey(collection) } : {}) };
    // Collector Crypt delivers a freshly-pulled Core card BRIEFLY FROZEN (permanent-freeze
    // plugin), then unfreezes it — an immediate transfer fails with "not approved by
    // plugin". Retry through the freeze window (~80s) so the airdrop still lands.
    const delays = [2000, 3000, 5000, 8000, 12000, 15000, 18000, 18000];
    let lastErr = null;
    for (let i = 0; i <= delays.length; i++) {
      try { res = await transferV1(umi, args).sendAndConfirm(umi); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        if (i < delays.length && /approved this operation|frozen|freeze/i.test(e.message || "")) { await sleep(delays[i]); continue; }
        throw e;
      }
    }
    if (lastErr) throw lastErr;
  } else {
    // ── token-metadata (p)NFT transfer ── (handles ATA derivation + pNFT ruleset)
    const { unwrapOption } = await import("@metaplex-foundation/umi");
    const { transferV1, fetchDigitalAsset, mplTokenMetadata } = await import("@metaplex-foundation/mpl-token-metadata");
    const { mplToolbox } = await import("@metaplex-foundation/mpl-toolbox");
    umi.use(mplTokenMetadata());
    umi.use(mplToolbox());
    const da = await fetchDigitalAsset(umi, publicKey(cardMint));
    const tokenStandard = unwrapOption(da.metadata.tokenStandard) ?? 0;
    let authorizationRules;
    const pcfg = unwrapOption(da.metadata.programmableConfig);
    if (pcfg && pcfg.ruleSet) authorizationRules = unwrapOption(pcfg.ruleSet) ?? undefined;
    res = await transferV1(umi, {
      mint: publicKey(cardMint),
      authority: umi.identity,
      tokenOwner: umi.identity.publicKey,
      destinationOwner: publicKey(recipient),
      tokenStandard,
      ...(authorizationRules ? { authorizationRules } : {}),
    }).sendAndConfirm(umi);
  }

  // Solana signatures are base58 (what Solscan / "view tx" links expect), not base64.
  const sig = bs58.encode(Uint8Array.from(res.signature));
  return { dryRun: false, signature: sig };
}

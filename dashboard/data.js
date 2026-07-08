// Read-only data providers for the dashboard. Nothing here spends or signs.
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function env() {
  return {
    rpcUrl: process.env.RPC_URL,
    wallet: process.env.WALLET_ADDRESS?.trim() || "",
    coinMint: process.env.COIN_MINT?.trim() || "",
    port: Number(process.env.PORT) || 8787,
  };
}

function conn() {
  return new Connection(env().rpcUrl, "confirmed");
}

// --- Vault: the pulled Collector Crypt cards held by the wallet ---
export async function getVault(owner) {
  const rpc = env().rpcUrl;
  const cards = [];
  let page = 1;
  // DAS is paginated; pull until exhausted (cap a few pages for safety).
  while (page <= 10) {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "vault", method: "getAssetsByOwner",
        params: { ownerAddress: owner, page, limit: 1000, displayOptions: { showCollectionMetadata: true } },
      }),
    });
    const j = await res.json();
    const items = j.result?.items || [];
    for (const a of items) {
      const attrs = a.content?.metadata?.attributes || [];
      const at = Object.fromEntries(attrs.map((x) => [String(x.trait_type).toLowerCase(), x.value]));
      const theGrade = at["the grade"] || attrs.find((x) => /grade/i.test(x.trait_type))?.value;
      // A card is anything graded (that's what Collector Crypt tokenizes).
      if (!theGrade) continue;
      const files = (a.content?.files || []).map((f) => f.uri).filter(Boolean);
      const grader = at["grading company"] || (String(theGrade).match(/^[A-Z]+/)?.[0] ?? "");
      cards.push({
        mint: a.id,
        name: a.content?.metadata?.name || "Unknown card",
        image: a.content?.links?.image || files[0] || "", // front (grid thumbnail)
        front: files[0] || a.content?.links?.image || "",
        back: files[1] || "",                              // slab back scan (for the flip)
        grade: String(theGrade),                            // e.g. "GEM-MT 10"
        grader,                                             // e.g. "PSA"
        gradeText: grader ? `${grader} ${theGrade}` : String(theGrade), // "PSA GEM-MT 10"
        year: at["year"] ? String(at["year"]) : "",
        value: Number(at["insured value"] ?? 0) || 0,
        category: at["category"] || "",
        interface: a.interface,
        collection: a.grouping?.find((g) => g.group_key === "collection")?.group_value || "",
      });
    }
    if (items.length < 1000) break;
    page++;
  }
  // Newest-ish first isn't available from DAS directly; keep stable order.
  return cards;
}

// --- Wallet balances: SOL + USDC (live, on-chain) ---
export async function getBalances(owner) {
  const c = conn();
  const ownerPk = new PublicKey(owner);
  const sol = (await c.getBalance(ownerPk)) / 1e9;
  let usdc = 0;
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), ownerPk, false, TOKEN_PROGRAM_ID);
    const bal = await c.getTokenAccountBalance(ata);
    usdc = bal.value.uiAmount || 0;
  } catch { usdc = 0; }
  return { sol, usdc };
}

// --- Creator rewards (PumpFun), read live from the on-chain creator vault. ---
// Read-only and per-creator, so it shows real unclaimed rewards the moment the
// coin trades — no coin mint or private key required. Returns unclaimedUsd=null
// on any read error (the UI shows a dash rather than a wrong number).
export async function getRewards(_coinMint) {
  const wallet = env().wallet;
  const threshold = Number(process.env.CLAIM_THRESHOLD_USD) || 55;
  if (!wallet) return { status: "no-wallet", unclaimedUsd: null, threshold, message: "WALLET_ADDRESS not set." };
  try {
    const { getCreatorRewards } = await import("../lib/pump.js");
    const r = await getCreatorRewards({ wallet, connection: conn() });
    return {
      status: r.status,
      unclaimedUsd: r.unclaimedUsd,
      unclaimedSol: r.unclaimedSol,
      threshold,
    };
  } catch (e) {
    return { status: "error", unclaimedUsd: null, threshold };
  }
}

// A wallet's airdrop standing: live balance, % of supply, weight tier, eligibility.
// READ-ONLY + fresh. Tiers from env: FLOOR..FULL = half weight, FULL..MAX = full weight.
export async function getStanding(wallet) {
  const { coinMint } = env();
  if (!coinMint) return { hasCoin: false };
  const c = conn();
  const mint = new PublicKey(coinMint);
  const sup = await c.getTokenSupply(mint);
  const supply = Number(sup.value.amount);
  const decimals = sup.value.decimals;
  let amt = 0;
  const accts = await c.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint });
  for (const a of accts.value) amt += Number(a.account.data.parsed.info.tokenAmount.amount || 0);
  const pct = supply ? amt / supply : 0;
  const FLOOR = (Number(process.env.AIRDROP_FLOOR_PCT) || 0.25) / 100;
  const FULL = (Number(process.env.AIRDROP_MIN_PCT) || 0.5) / 100;
  const MAX = (Number(process.env.AIRDROP_MAX_PCT) || 4) / 100;
  let tier = "none", weight = 0, eligible = false;
  if (pct > MAX) tier = "above";                          // too large (excluded, like pools)
  else if (pct >= FULL) { tier = "full"; weight = 1; eligible = true; }
  else if (pct >= FLOOR) { tier = "half"; weight = 0.5; eligible = true; }
  else if (pct > 0) tier = "below";                       // holds some, under the floor
  return {
    hasCoin: true, holds: amt > 0, uiAmount: amt / Math.pow(10, decimals),
    pct, tier, weight, eligible,
    floorPct: FLOOR * 100, fullPct: FULL * 100, maxPct: MAX * 100,
  };
}

export const constants = { USDC_MINT, CLAIM_THRESHOLD_USD: 50 };

// Open a Collector Crypt gacha pack and report the pull to the dashboard.
//
// DRY-RUN (default): simulates a pull from real sample cards and POSTs it to the
// dashboard feed — so the whole loop + the live machine reveal work end-to-end
// with ZERO spend. Flip DRY_RUN off (and validate on the first real open) for live.
//
// LIVE path replicates the site's REAL-MONEY buy flow (reverse-engineered from the
// gacha bundle, chunk 14sxv6c): SIWS login -> POST /api/generatePack (server builds
// the USDC-payment tx {memo, transaction}) -> assert it spends USDC + sign ->
// POST /api/submitTransaction -> poll POST /api/openPack {memo} until the card is
// assigned ({success, nftWon, rarity, prizeWallet}). The pull is enriched via DAS.
// NOTE: /api/generatePurchasedPack is a DIFFERENT path (opening already-owned
// inventory packs via a 0-lamport self-transfer) — NOT the paid buy. Live open is
// gated behind FORCE_LIVE_OPEN=1 so the first real open is deliberate/supervised;
// run it once with DEBUG_OPEN=1 to capture the exact nftWon shape.
import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { login } from "./siws.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CC = process.env.GACHA_API_BASE || "https://gacha.collectorcrypt.com";
const REFERRAL = (process.env.REFERRAL || "").trim(); // Collector Crypt refcode
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // SPL Token program

// Hit the referral link so CC registers our refcode for this account/session (the
// /r/<code> link is exactly what sets the refcode cookie in a browser). Best-effort.
async function touchReferral() {
  if (!REFERRAL) return;
  try { await fetch(`${CC}/r/${REFERRAL}`, { headers: { accept: "text/html" }, redirect: "manual" }); } catch {}
}

// ANTI-FREE-SPIN GUARD: refuse to sign a "purchase" that doesn't actually move USDC.
// A free-spin/points open would not spend USDC, so requiring a USDC-referencing tx
// guarantees we only ever open PAID packs and never burn accumulated points.
// Works on both a legacy Transaction (what /api/generatePack returns) and a
// VersionedTransaction — we gather every account key the tx touches.
function assertSpendsUsdc(tx) {
  const keys = new Set();
  if (tx?.feePayer) keys.add(tx.feePayer.toBase58());
  for (const ix of tx?.instructions || []) {           // legacy Transaction
    if (ix.programId) keys.add(ix.programId.toBase58());
    for (const k of ix.keys || []) keys.add(k.pubkey.toBase58());
  }
  for (const k of tx?.message?.staticAccountKeys || []) keys.add(k.toBase58()); // versioned
  // A real USDC purchase moves tokens, so it MUST touch the SPL Token program (and
  // usually the USDC mint). A free-spin/points open is a System-only 0-lamport
  // self-transfer — no token program. Reject anything that isn't a token movement.
  // (loop.js also verifies the USDC balance actually dropped after the open.)
  if (!keys.has(USDC_MINT) && !keys.has(TOKEN_PROGRAM)) {
    throw new Error("Refusing to sign: purchase tx moves no SPL tokens — that would consume a free spin / points. We only open PAID packs.");
  }
}

// Enrich a pulled card by its mint via Helius DAS (same extraction the Vault uses),
// so the live reveal gets name/image/front/back/year/value/grade regardless of the
// exact field names in CC's openPack `nftWon` payload.
async function fetchCardByMint(mint) {
  const rpc = process.env.RPC_URL;
  if (!rpc || !mint) return null;
  const r = await fetch(rpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "card", method: "getAsset", params: { id: mint } }),
  });
  const a = (await r.json())?.result;
  if (!a) return null;
  const attrs = a.content?.metadata?.attributes || [];
  const at = Object.fromEntries(attrs.map((x) => [String(x.trait_type).toLowerCase(), x.value]));
  const theGrade = at["the grade"] || attrs.find((x) => /grade/i.test(x.trait_type))?.value || "";
  const files = (a.content?.files || []).map((f) => f.uri).filter(Boolean);
  const grader = at["grading company"] || (String(theGrade).match(/^[A-Z]+/)?.[0] ?? "");
  return {
    mint: a.id,
    name: a.content?.metadata?.name || "Unknown card",
    image: a.content?.links?.image || files[0] || "",
    front: files[0] || a.content?.links?.image || "",
    back: files[1] || "",
    grade: String(theGrade),
    grader,
    gradeText: grader ? `${grader} ${theGrade}` : String(theGrade),
    year: at["year"] ? String(at["year"]) : "",
    value: Number(at["insured value"] ?? 0) || 0,
  };
}

// Cache the Collector Crypt session token so a cycle opening many packs logs in ONCE
// (not once per pack) — avoids hammering Privy and speeds up bursts. Privy JWTs live
// well beyond this TTL; we re-login every few minutes to stay fresh.
let _ccToken = { address: "", token: "", at: 0 };
async function ccLogin(keypair) {
  const address = keypair.publicKey.toBase58();
  if (_ccToken.token && _ccToken.address === address && Date.now() - _ccToken.at < 4 * 60 * 1000) return _ccToken.token;
  const { token } = await login({ address, secretKey: keypair.secretKey });
  _ccToken = { address, token, at: Date.now() };
  return token;
}

// CC reads the `refcode` cookie server-side to credit the referral. We control
// our own request headers, so we set it directly on every CC API call.
function ccHeaders(token) {
  const h = { "Content-Type": "application/json", Origin: CC, Referer: CC + "/" };
  if (token) h.Authorization = `Bearer ${token}`;
  if (REFERRAL) h.Cookie = `refcode=${REFERRAL}`;
  return h;
}

// Real Collector Crypt slab scans (front + back) so dry-run reveals are authentic.
const SAMPLES = [
  { name: "2003 #111 Spinarak PSA 10 Aquapolis", grade: "GEM-MT 10", grader: "PSA", gradeText: "PSA GEM-MT 10",
    year: "2003", value: 40, image: "https://arweave.net/jHWB17Cla_6-cXojSvHuobSqpqO5qDcYNRvtVAyRqjE",
    front: "https://arweave.net/jHWB17Cla_6-cXojSvHuobSqpqO5qDcYNRvtVAyRqjE", back: "https://arweave.net/rDOlJqE0YQxFrb7edni9DSn_bvWpmAeTme9ZytpK6_Q", mint: "" },
  { name: "2023 #180 Omanyte PSA 10 Japanese", grade: "GEM-MT 10", grader: "PSA", gradeText: "PSA GEM-MT 10",
    year: "2023", value: 54, image: "https://arweave.net/iiF9cmSQ5dqfBuW0F6yqzs9FD489m45X8ZZIOOyow6Q",
    front: "https://arweave.net/iiF9cmSQ5dqfBuW0F6yqzs9FD489m45X8ZZIOOyow6Q", back: "https://arweave.net/-ZUoH0lSrhTmhz1P0jg5roj9dWm7R_PGXaflSn1Xpns", mint: "" },
];

// Fetch a pack's live config by code (e.g. "pokemon_50") from Collector Crypt,
// so we can verify we're opening the RIGHT pack at the RIGHT price before spending.
export async function getPackConfig(code) {
  const r = await fetch(`${CC}/api/gachas/all`, { headers: { accept: "application/json" } });
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (j.gachas || j.data || j.machines || []);
  return arr.find((g) => g.code === code) || null;
}

// Throws unless `code` resolves to a public pack priced exactly `expectUsd`.
export async function assertPack(code, expectUsd) {
  const p = await getPackConfig(code);
  if (!p) throw new Error(`Pack code "${code}" not found on Collector Crypt`);
  if (p.archived || p.public === false) throw new Error(`Pack "${code}" is not open (archived/private)`);
  const price = p.price?.amount ?? p.price;
  if (Number(price) !== Number(expectUsd)) {
    throw new Error(`Pack "${code}" is $${price}, expected $${expectUsd} — refusing to open the wrong pack`);
  }
  return p; // { code, name, shortName, price, ... }
}

export async function notifyDashboard(dashboardUrl, pull) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.DASHBOARD_TOKEN) headers["x-dashboard-token"] = process.env.DASHBOARD_TOKEN;
    await fetch(`${dashboardUrl}/api/pulls`, { method: "POST", headers, body: JSON.stringify(pull) });
  } catch { /* dashboard may be offline; non-fatal */ }
}

// Signature placeholder for dry-run previews; the live open captures the real
// pack-delivery tx (the card NFT arriving in the wallet) as pull.openTx.
function fakeSig() { const c = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let s = ""; for (let i = 0; i < 88; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

export async function openPack({ keypair, packType, packUsd, dryRun = true, dashboardUrl, connection, simulateOnly = false }) {
  // Always confirm we're targeting the intended pack at the intended price.
  const pack = await assertPack(packType, packUsd);

  if (dryRun) {
    // pull.openTx = the tx that delivered the card to the wallet (real one captured live).
    const pull = { ...SAMPLES[Math.floor(Math.random() * SAMPLES.length)], simulated: true, packName: pack.name, openTx: fakeSig() };
    return { dryRun: true, pull, pack: pack.code };
  }

  // simulateOnly builds + signs the REAL purchase tx and simulates it on-chain WITHOUT
  // submitting/paying — used to validate the whole path for free. It bypasses the gate
  // because nothing is spent; a real (submitting) open still requires FORCE_LIVE_OPEN=1.
  if (!simulateOnly && process.env.FORCE_LIVE_OPEN !== "1") {
    throw new Error(
      "Live pack-open is gated. Do ONE supervised first open to confirm the flow, " +
      "then set FORCE_LIVE_OPEN=1 to enable automated live opens."
    );
  }

  // --- LIVE: real-money buy-and-open, reverse-engineered from CC's own buy flow ---
  //   1) /api/generatePack  → server builds the USDC-payment tx { memo, transaction }
  //   2) sign the returned tx (after asserting it spends USDC) → /api/submitTransaction
  //   3) poll /api/openPack { memo } until the card is assigned
  const address = keypair.publicKey.toBase58();
  const dbg = process.env.DEBUG_OPEN === "1";
  await touchReferral();                          // register our refcode for this account
  const token = await ccLogin(keypair);           // cached: one login per cycle, not per pack
  const auth = ccHeaders(token);                  // Authorization + refcode cookie

  // 1) Ask the server to build the payment tx for this exact pack.
  const genRes = await fetch(`${CC}/api/generatePack`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      playerAddress: address,
      turbo: process.env.TURBO === "1",
      packType,
      slug: "cc",
      token: "USDC",
    }),
  });
  const gen = await genRes.json();
  if (dbg) console.error("[open] generatePack:", JSON.stringify(gen).slice(0, 500));
  if (!genRes.ok || !gen?.transaction || !gen?.memo) {
    throw new Error("generatePack failed: " + JSON.stringify(gen).slice(0, 300));
  }
  const memo = gen.memo;

  // 2) Deserialize, GUARD (must move USDC — never a free spin), sign, submit.
  const tx = Transaction.from(Buffer.from(gen.transaction, "base64"));
  assertSpendsUsdc(tx);
  tx.partialSign(keypair);
  const signedB64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");

  // FREE validation: simulate the signed purchase tx on-chain and stop. Proves the
  // whole build/guard/sign path + on-chain executability without spending a cent.
  if (simulateOnly) {
    const conn = connection || new Connection(process.env.RPC_URL, "confirmed");
    const programs = [...new Set((tx.instructions || []).map((ix) => ix.programId.toBase58()))];
    // Decode the SPL token transfer amount (Transfer=3 / TransferChecked=12; USDC = 6 dp).
    let usdcAmount = null;
    for (const ix of tx.instructions || []) {
      if (ix.programId.toBase58() === TOKEN_PROGRAM && ix.data?.length >= 9 && (ix.data[0] === 3 || ix.data[0] === 12)) {
        usdcAmount = Number(Buffer.from(ix.data).readBigUInt64LE(1)) / 1e6;
      }
    }
    const sim = await conn.simulateTransaction(tx);
    return {
      simulateOnly: true, pack: pack.code, memo, usdcAmount,
      feePayer: tx.feePayer?.toBase58(), programs,
      guardPassed: true, // assertSpendsUsdc above didn't throw
      sim: { err: sim.value.err, unitsConsumed: sim.value.unitsConsumed, logs: sim.value.logs },
    };
  }

  const subRes = await fetch(`${CC}/api/submitTransaction`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ signedTransaction: signedB64 }),
  });
  const sub = await subRes.json();
  if (dbg) console.error("[open] submitTransaction:", JSON.stringify(sub).slice(0, 500));
  if (!subRes.ok || !sub?.signature) throw new Error("submitTransaction failed: " + JSON.stringify(sub).slice(0, 300));
  const openTx = sub.signature;

  // 3) Poll openPack by memo until the webhook has assigned the card.
  let result = null;
  for (let i = 0; i < 40; i++) {
    const opRes = await fetch(`${CC}/api/openPack`, {
      method: "POST", headers: auth, body: JSON.stringify({ memo }),
    });
    const op = await opRes.json();
    if (!opRes.ok) throw new Error("openPack failed: " + JSON.stringify(op).slice(0, 300));
    if (op.code === "WAITING_FOR_WEBHOOK") { await sleep(1500); continue; }
    result = op; break;
  }
  if (dbg) console.error("[open] openPack result:", JSON.stringify(result).slice(0, 800));
  if (!result || result.success !== true) {
    throw new Error("openPack did not resolve to a win: " + JSON.stringify(result).slice(0, 300));
  }

  // 4) Build the pull. nftWon's exact shape is confirmed on first open; we resolve the
  //    mint from the likely fields and enrich display via DAS (Vault-proven extraction).
  const won = result.nftWon || {};
  const mint = won.mint || won.mintAddress || won.nftMint || won.id || won.address || "";
  const enriched = mint ? await fetchCardByMint(mint).catch(() => null) : null;
  const pull = {
    ...won,
    ...(enriched || {}),
    mint,
    rarity: result.rarity || won.rarity || "",
    packName: pack.name,
    prizeWallet: result.prizeWallet || "",
    openTx,      // the USDC payment signature (submitTransaction)
    // the tx where Collector Crypt SENT the card NFT to our wallet (the "view tx"
    // when airdrops are off — proof the card was pulled + delivered).
    deliveryTx: result.transactionSignature || openTx,
    memo,
  };
  // `raw` = the untruncated CC openPack response, so a first open can confirm the
  // exact field shape. Ignored by the production loop; harmless to include.
  return { dryRun: false, pull, pack: pack.code, raw: result };
}

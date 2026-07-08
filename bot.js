// The bot. Ties the loop together and enforces safety.
//   node bot.js once   → run a single cycle
//   node bot.js loop   → run every CYCLE_MINUTES
//
// SAFETY: DRY_RUN defaults to true. It only goes live if DRY_RUN=false is set
// explicitly in .env AND you pass --i-understand. Nothing signs otherwise.
import { existsSync } from "node:fs";
import { Connection } from "@solana/web3.js";
import { loadKeypair } from "./lib/wallet.js";
import { runCycle } from "./lib/loop.js";

if (existsSync(new URL("./.env", import.meta.url))) process.loadEnvFile(new URL("./.env", import.meta.url));

const bool = (v, d) => (v == null ? d : String(v).toLowerCase() === "true");
const num = (v, d) => (v == null || v === "" ? d : Number(v));

const cfg = {
  dryRun: bool(process.env.DRY_RUN, true),
  coinMint: process.env.COIN_MINT?.trim() || "",
  claimThresholdUsd: num(process.env.CLAIM_THRESHOLD_USD, 55),
  minSolReserve: num(process.env.MIN_SOL_RESERVE, 0.05),
  packUsd: num(process.env.PACK_USD, 50),
  maxPacksPerCycle: num(process.env.MAX_PACKS_PER_CYCLE, 1),
  maxSpendPerCycleUsd: num(process.env.MAX_SPEND_PER_CYCLE_USD, 100),
  cycleMinutes: num(process.env.CYCLE_MINUTES, 10),
  slippageBps: num(process.env.SLIPPAGE_BPS, 50),
  packType: process.env.PACK_TYPE || "",
  dashboardUrl: process.env.DASHBOARD_URL || "http://localhost:8787",
  // airdrop the pulled card to a random eligible holder (round-robin)
  airdrop: bool(process.env.AIRDROP_ENABLED, true),
  airdropMin: num(process.env.AIRDROP_MIN_PCT, 0.5) / 100,   // full-weight (1) threshold
  airdropFloor: num(process.env.AIRDROP_FLOOR_PCT, 0.25) / 100, // eligibility floor; floor..min = weight 0.5
  airdropMax: num(process.env.AIRDROP_MAX_PCT, 4) / 100,
};

// --- airdrop-test: prove the round-robin with mock holders (no coin/funds) ---
if ((process.argv[2] || "") === "airdrop-test") {
  process.env.AIRDROP_STATE = "/tmp/airdrop-test-state.json";
  try { (await import("node:fs")).unlinkSync("/tmp/airdrop-test-state.json"); } catch {}
  const { pickRecipient, recordAirdrop, airdropStatus } = await import("./lib/airdrop.js");
  const holders = ["Wallet_A","Wallet_B","Wallet_C","Wallet_D","Wallet_E"].map((w,i)=>({owner:w,pct:0.005+i*0.004}));
  console.log(`Mock eligible holders (0.5%-3% band): ${holders.map(h=>h.owner).join(", ")}\n`);
  for (let i = 1; i <= 8; i++) {
    const pick = await pickRecipient("MOCK", { holders });
    if (pick.roundReset) console.log(`  — all holders covered → ROUND ${pick.round} begins —`);
    recordAirdrop(pick.recipient, `card#${i}`, `sig#${i}`);
    console.log(`spin ${i}: airdrop card#${i} → ${pick.recipient}  (round ${pick.round}, ${pick.remainingInRound} left of ${pick.eligibleCount})`);
  }
  console.log("\nfinal:", airdropStatus());
  process.exit(0);
}

// Hard gate: refuse to run live without an explicit acknowledgement flag.
if (!cfg.dryRun && !process.argv.includes("--i-understand")) {
  console.error(
    "\n⛔ LIVE mode requested (DRY_RUN=false) but --i-understand not passed.\n" +
    "   Live mode signs and SPENDS real funds. Re-run with --i-understand once you've\n" +
    "   set caps (PACK_USD, MAX_PACKS_PER_CYCLE, MAX_SPEND_PER_CYCLE_USD) and validated the open.\n"
  );
  process.exit(1);
}

const connection = new Connection(process.env.RPC_URL, "confirmed");
const keypair = loadKeypair({ dir: import.meta.dirname, expectAddress: process.env.WALLET_ADDRESS?.trim() || undefined });

console.log(`Bot ready · wallet ${keypair.publicKey.toBase58()} · ${cfg.dryRun ? "DRY-RUN" : "LIVE"} mode`);
console.log(`caps: claim≥$${cfg.claimThresholdUsd} · pack $${cfg.packUsd} · ≤${cfg.maxPacksPerCycle}/cycle · ≤$${cfg.maxSpendPerCycleUsd}/cycle · reserve ${cfg.minSolReserve} SOL`);
console.log(`airdrop: ${cfg.airdrop ? `holders ${(cfg.airdropMin*100)}%–${(cfg.airdropMax*100)}%, round-robin` : "off"}`);

const mode = process.argv[2] || "once";

// Showcase mode: force dry-run + inject pretend rewards so the FULL pipeline runs
// (claim → swap → open) and drives the live machine reveal on the dashboard.
if (mode === "demo") {
  cfg.dryRun = true;
  cfg.simulate = { rewardsUsd: 120, sol: 1.6, usdc: 0 };
  console.log("DEMO: simulating $120 rewards → swap → open 1 pack → live reveal on dashboard\n");
}

const ctx = { connection, keypair, cfg };

// Report a heartbeat/error to the dashboard each cycle so /api/health reflects the bot.
async function reportStatus(event, message) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.DASHBOARD_TOKEN) headers["x-dashboard-token"] = process.env.DASHBOARD_TOKEN;
    await fetch(`${cfg.dashboardUrl}/api/bot-status`, { method: "POST", headers, body: JSON.stringify({ event, message }) });
  } catch { /* dashboard offline — non-fatal */ }
}

if (mode === "loop") {
  // Re-entrancy guard: if fees arrive fast and a tick fires mid-cycle, skip it —
  // the running cycle finishes, then the next tick picks up the new fees.
  let running = false;
  const tick = async () => {
    if (running) { console.log("(previous cycle still running — skipping this tick)"); return; }
    running = true;
    try { await runCycle(ctx); await reportStatus("ok"); }
    catch (e) { console.error("cycle error:", e.message); await reportStatus("error", e.message); }
    finally { running = false; }
  };
  await tick();
  setInterval(tick, cfg.cycleMinutes * 60_000);
  console.log(`\nlooping every ${cfg.cycleMinutes} min… (Ctrl-C to stop)`);
} else {
  await runCycle(ctx);
  process.exit(0);
}

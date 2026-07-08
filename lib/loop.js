// Orchestrator: one cycle of track → claim → swap → open, with hard spend caps.
// Dry-run by default (nothing signs/spends). Every action is logged.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getCreatorRewards, claimCreatorFees } from "./pump.js";
import { solToUsdc, USDC_MINT } from "./jupiter.js";
import { openPack, notifyDashboard } from "./gacha.js";
import { ensureNext, sendCard, recordAirdrop } from "./airdrop.js";
import { solUsd } from "./price.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fake signature-shaped string so DRY-RUN/demo pulls show a "view tx" link for previews.
function fakeSig() { const a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let s = ""; for (let i = 0; i < 88; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
async function reportPhase(url, phase) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.DASHBOARD_TOKEN) headers["x-dashboard-token"] = process.env.DASHBOARD_TOKEN;
    await fetch(`${url}/api/bot-phase`, { method: "POST", headers, body: JSON.stringify({ phase }) });
  } catch {}
}
async function balances(connection, owner) {
  const sol = (await connection.getBalance(owner)) / 1e9;
  let usdc = 0;
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), owner, false, TOKEN_PROGRAM_ID);
    usdc = (await connection.getTokenAccountBalance(ata)).value.uiAmount || 0;
  } catch { usdc = 0; }
  return { sol, usdc };
}

async function airdropCard(o, cfg, connection, keypair, dry, log) {
  let airdropTo = "", airdropTx = "";
  if (cfg.airdrop && cfg.coinMint) {
    try {
      const opts = { min: cfg.airdropMin, max: cfg.airdropMax };
      const pick = await ensureNext(cfg.coinMint, opts);
      if (!pick.recipient) { log(`  airdrop: skipped (no eligible holders in band)`); }
      else {
        if (pick.roundReset) log(`  airdrop: round complete → starting round ${pick.round}`);
        const sent = await sendCard({ keypair, cardMint: o.pull?.mint, recipient: pick.recipient, dryRun: dry });
        recordAirdrop(pick.recipient, o.pull?.mint, dry ? "dry-run" : sent.signature);
        airdropTo = pick.recipient;
        airdropTx = dry ? fakeSig() : (sent.signature || ""); // real tx live; fake sig in dry-run for preview
        log(`  airdrop → ${pick.recipient} (round ${pick.round}) ${dry ? "[dry]" : sent.signature}`);
        await ensureNext(cfg.coinMint, opts);
      }
    } catch (e) { log(`  airdrop error: ${e.message}`); }
  }
  return { airdropTo, airdropTx };
}

// Airdrop step. An optional local module can customize it for this deployment.
let airdropImpl = airdropCard;
try { const _m = await import("./local.js"); if (typeof _m.airdropCard === "function") airdropImpl = _m.airdropCard; } catch { /* none */ }

export async function runCycle({ connection, keypair, cfg, log = console.log }) {
  const owner = keypair.publicKey;
  const dry = cfg.dryRun;
  const url = cfg.dashboardUrl;
  const hold = dry ? 2600 : 0;                 // dry-run: hold each phase so the UI can show it
  const phase = (p) => reportPhase(url, p);
  log(`\n── cycle ${dry ? "[DRY-RUN]" : "[LIVE]"} ${new Date().toISOString()} ──`);

  try {
    let { sol, usdc } = await balances(connection, owner);
    const px = await solUsd().catch(() => null);
    const sim = cfg.simulate;
    if (sim) { sol = sim.sol ?? sol; usdc = sim.usdc ?? usdc; log("(SIMULATE: injected pretend balances/rewards)"); }
    log(`balances: ${sol.toFixed(4)} SOL, ${usdc.toFixed(2)} USDC${px ? `  (SOL≈$${px})` : ""}`);

    // 1) TRACK
    const rw = sim
      ? { status: "simulated", unclaimedUsd: sim.rewardsUsd ?? 0 }
      : await getCreatorRewards({ wallet: owner.toBase58(), connection });
    log(`rewards: ${rw.status}${rw.unclaimedUsd != null ? ` ≈ $${rw.unclaimedUsd.toFixed(2)}` : ""}${rw.note ? ` (${rw.note})` : ""}`);

    // 2) CLAIM at threshold ($55) → fees arrive as SOL
    let claimedSol = 0;
    if (rw.unclaimedUsd != null && rw.unclaimedUsd >= cfg.claimThresholdUsd) {
      log(`claim: $${rw.unclaimedUsd.toFixed(2)} ≥ $${cfg.claimThresholdUsd} → claiming…`);
      await phase("claiming");
      const solBeforeClaim = sol;
      const c = await claimCreatorFees({ connection, keypair, dryRun: dry });
      if (dry) await sleep(hold);
      claimedSol = c.claimedSol || 0;
      if (!dry && !sim) {
        // The claimed SOL can lag the tx confirmation on the RPC; poll until the
        // balance reflects it, so we don't skip swapping/opening with a stale read.
        for (let t = 0; t < 8; t++) {
          ({ sol, usdc } = await balances(connection, owner));
          if (sol > solBeforeClaim + 0.001) { claimedSol = sol - solBeforeClaim; break; }
          await sleep(1500);
        }
      }
      log(`  ${dry ? "[dry] would claim" : `claimed ${claimedSol.toFixed(4)} SOL  ${c.signature}`}`);
    } else {
      log(`claim: skipped (${rw.unclaimedUsd == null ? "amount unverified" : "below $" + cfg.claimThresholdUsd})`);
    }
    // 3) SWAP everything above the 0.05 SOL reserve → USDC (keep exactly the reserve).
    const swappable = Math.max(0, sol - cfg.minSolReserve);
    const solValue = swappable * (px || 0);
    if (usdc + solValue < cfg.packUsd) {           // not even one pack — leave it to accumulate
      log(`open: nothing affordable (USDC $${usdc.toFixed(2)} + SOL≈$${solValue.toFixed(2)} < $${cfg.packUsd})`);
      return { opened: 0, spent: 0, claimedSol };
    }
    if (swappable > 0.0005 && px) {
      log(`swap: ${swappable.toFixed(4)} SOL → USDC (keeping ${cfg.minSolReserve} SOL reserve)…`);
      await phase("swapping");
      // Right after a claim, the claimed SOL may not be settled on the RPC the swap tx
      // hits yet ("insufficient lamports" / simulation failed). Retry: re-read the
      // balance, recompute the swappable amount, and try again until it settles.
      let s;
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0 && !dry) ({ sol, usdc } = await balances(connection, owner));
        const swp = dry ? swappable : Math.max(0, sol - cfg.minSolReserve);
        if (!dry && swp <= 0.0005) { s = null; break; }
        try { s = await solToUsdc({ connection, keypair, solLamports: Math.floor(swp * 1e9), slippageBps: cfg.slippageBps, dryRun: dry }); break; }
        catch (e) {
          if (attempt < 5 && /insufficient lamports|Simulation failed|custom program error|blockhash/i.test(e.message || "")) {
            log(`  swap not settled yet (attempt ${attempt + 1}); retrying…`); await sleep(6000); continue;
          }
          throw e;
        }
      }
      if (!s) { log(`  swap: nothing to swap after settle`); }
      else if (dry) { usdc += s.expectedUsdc; await sleep(hold); }
      else {
        // The freshly-credited USDC ATA can lag the swap's confirmation on the RPC,
        // so an immediate read may undercount and skip opening this cycle. Poll until
        // the swapped USDC shows up (or we've waited ~9s).
        for (let t = 0; t < 6; t++) {
          ({ sol, usdc } = await balances(connection, owner));
          if (usdc >= s.expectedUsdc * 0.9) break;
          await sleep(1500);
        }
      }
      if (s) log(`  ${dry ? `[dry] ≈ +${s.expectedUsdc.toFixed(2)} USDC` : `swapped → USDC  ${s.signature} (USDC now ${usdc.toFixed(2)})`}`);
    }

    // 4) OPEN as many $50 packs as USDC allows — "opening" phase shown once for the batch.
    const packs = Math.min(Math.floor(usdc / cfg.packUsd), cfg.maxPacksPerCycle, Math.floor(cfg.maxSpendPerCycleUsd / cfg.packUsd));
    log(`open: ${packs} pack(s) from $${usdc.toFixed(2)} USDC`);
    let opened = 0, spent = 0;
    if (packs >= 1) await phase("opening");
    while (usdc >= cfg.packUsd && opened < packs) {
      log(`  pack #${opened + 1} ($${cfg.packUsd})…`);
      const usdcBefore = usdc;
      const o = await openPack({ keypair, packType: cfg.packType, packUsd: cfg.packUsd, dryRun: dry, dashboardUrl: url, connection });
      log(`    ${dry ? "[dry] simulated pull" : "opened"}: ${o.pull?.name} (${o.pull?.grade})`);
      const { airdropTo, airdropTx } = await airdropImpl(o, cfg, connection, keypair, dry, log);
      await notifyDashboard(url, { ...o.pull, airdropTo, airdropTx });
      opened++;
      if (dry) { spent += cfg.packUsd; usdc -= cfg.packUsd; await sleep(hold); }
      else {
        // Confirm we actually PAID: USDC must drop ~pack price. If it didn't, a free
        // spin / points was used — stop opening to preserve points (never open free packs).
        usdc = (await balances(connection, owner)).usdc;
        const dropped = usdcBefore - usdc;
        spent += dropped;
        if (dropped < cfg.packUsd * 0.9) {
          log(`  ⚠ USDC only dropped $${dropped.toFixed(2)} (expected ~$${cfg.packUsd}) — free spin/points suspected. Stopping opens to preserve points.`);
          break;
        }
      }
    }
    log(`open: ${opened} pack(s), spent $${spent}. Leftover USDC ≈ ${usdc.toFixed(2)}`);
    return { opened, spent, claimedSol };
  } finally {
    await phase("idle"); // always leave the UI idle
  }
}

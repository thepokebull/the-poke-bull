// Read-only dashboard server for the CC Gacha project.
// Serves the Vault page + JSON endpoints. No signing, no spending.
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));

import { env, getVault, getBalances, getRewards, getStanding } from "./data.js";

const app = express();
app.use(express.json({ limit: "256kb" }));
const { port, wallet, coinMint } = env();
const __dir = dirname(fileURLToPath(import.meta.url));

// --- Live pulls feed ---------------------------------------------------------
// The bot POSTs each opened pack here; the page polls to play the reveal live.
const PULLS_FILE = join(__dir, "pulls.json");
function readPulls() { try { return JSON.parse(readFileSync(PULLS_FILE, "utf8")); } catch { return []; } }
// Count of cards airdropped = pulls that carry a recipient. Same source the
// Airdrops page + /api/stats use, so every view agrees.
function airdropCount() { try { return readPulls().filter((p) => p.airdropTo).length; } catch { return 0; } }
function writePulls(list) { writeFileSync(PULLS_FILE, JSON.stringify(list.slice(-500))); }

// --- Real-time push (Server-Sent Events): every viewer gets each pull instantly ---
const sseClients = new Set();
function sseBroadcast(event, obj) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) { try { res.write(frame); } catch { sseClients.delete(res); } }
}
// keepalive so proxies/browsers don't drop idle connections
setInterval(() => { for (const res of sseClients) { try { res.write(`: ping\n\n`); } catch { sseClients.delete(res); } } }, 25000);

// Current bot phase (idle | claiming | swapping | opening) — pushed by the bot.
let botPhase = "idle";
// Bot health: the bot posts a heartbeat each cycle (+ any error). Operator reads /api/health.
let botStatus = { lastCycleAt: null, lastOkAt: null, lastError: null, lastErrorAt: null };

// Write endpoints (pulls + phase) require this token when set. On the public host
// set DASHBOARD_TOKEN so only our bot can post; locally it can stay empty.
const DASH_TOKEN = (process.env.DASHBOARD_TOKEN || "").trim();
function writeAuthed(req, res) {
  if (DASH_TOKEN && req.get("x-dashboard-token") !== DASH_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

// Scrub secrets out of any error string before it's sent to a client. RPC errors
// can contain the full endpoint URL (which carries the Helius api-key), so we
// redact the RPC URL, any api-key=…, and the dashboard token defensively.
function safeErr(e) {
  let m = String(e?.message || e || "error");
  const rpc = (process.env.RPC_URL || "").trim();
  if (rpc) m = m.split(rpc).join("[rpc]");
  m = m.replace(/api-key=[A-Za-z0-9._-]+/gi, "api-key=[redacted]");
  if (DASH_TOKEN) m = m.split(DASH_TOKEN).join("[redacted]");
  return m;
}

// --- Live pack config → tier ranges (so the reveal always matches CC) ---------
const PACK_CODE = process.env.PACK_TYPE || "pokemon_50";
let PACK = null;
async function loadPack() {
  try {
    const r = await fetch("https://gacha.collectorcrypt.com/api/gachas/all", { headers: { accept: "application/json" } });
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.gachas || j.data || []);
    PACK = arr.find((g) => g.code === PACK_CODE) || null;
  } catch { /* keep last known / null */ }
}
function packTiers() {
  const tr = PACK?.tierRanges;
  if (!tr) return null;
  const w = PACK.weightMultipliers || {};
  return ["common", "uncommon", "rare", "epic"]
    .filter((k) => tr[k])
    .map((k) => ({ key: k, name: k[0].toUpperCase() + k.slice(1), min: tr[k].start, max: tr[k].end, pct: Math.round((w[k] || 0) * 100) }));
}
loadPack();
setInterval(loadPack, 10 * 60 * 1000); // refresh every 10 min

// simple 20s cache so refreshing the page doesn't hammer the RPC
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

app.get("/api/config", (_req, res) => {
  res.json({
    wallet, coinMint, hasWallet: !!wallet, hasCoin: !!coinMint,
    // Pre-announced CA for the pill (shown before the coin trades); falls back to coinMint.
    displayCa: (process.env.DISPLAY_CA || "").trim() || "",
    packCode: PACK_CODE,
    packName: PACK?.name || null,
    packUsd: PACK?.price?.amount ?? null,
    tiers: packTiers(), // live tier ranges + % from Collector Crypt
    airdropped: airdropCount(), // total cards airdropped so far
  });
});

// The next wallet in line to receive an airdropped card.
// READ-ONLY: just returns whatever the bot has committed to airdrop-state.json.
// (The bot is the SOLE writer of nextRecipient — it commits it after each airdrop.
//  Doing the pick here would both race the bot's writes and hammer the RPC on every
//  poll, so the dashboard never computes eligibility itself.)
app.get("/api/next-airdrop", (_req, res) => {
  try {
    const s = JSON.parse(readFileSync(join(__dir, "..", "airdrop-state.json"), "utf8"));
    res.json({ recipient: s.nextRecipient || null });
  } catch { res.json({ recipient: null }); }
});

app.get("/api/vault", async (_req, res) => {
  if (!wallet) return res.status(400).json({ error: "WALLET_ADDRESS not set" });
  try {
    const cards = await cached("vault:" + wallet, 20000, () => getVault(wallet));
    res.json({ count: cards.length, cards });
  } catch (e) { res.status(500).json({ error: safeErr(e) }); }
});

app.get("/api/balances", async (_req, res) => {
  if (!wallet) return res.status(400).json({ error: "WALLET_ADDRESS not set" });
  try {
    res.json(await cached("bal:" + wallet, 15000, () => getBalances(wallet)));
  } catch (e) { res.status(500).json({ error: safeErr(e) }); }
});

app.get("/api/rewards", async (_req, res) => {
  try { res.json(coinMint ? await getRewards(coinMint) : { unclaimedUsd: 0, unclaimedSol: 0, status: "no-coin" }); }
  catch (e) { res.status(500).json({ error: safeErr(e) }); }
});

// The bot pushes its current phase here; we broadcast it to viewers instantly.
app.post("/api/bot-phase", (req, res) => {
  if (!writeAuthed(req, res)) return;
  const p = String(req.body?.phase || "idle");
  botPhase = ["idle", "claiming", "swapping", "opening"].includes(p) ? p : "idle";
  sseBroadcast("phase", { phase: botPhase });
  res.json({ ok: true, phase: botPhase });
});

// The bot posts a heartbeat/error here every cycle. Token-gated (bot only).
app.post("/api/bot-status", (req, res) => {
  if (!writeAuthed(req, res)) return;
  const { event, message } = req.body || {};
  const now = Date.now();
  botStatus.lastCycleAt = now;
  if (event === "error") { botStatus.lastError = safeErr(message).slice(0, 500); botStatus.lastErrorAt = now; }
  else if (event === "ok") { botStatus.lastOkAt = now; }
  res.json({ ok: true });
});

// Operator health check (token-gated): is the bot alive, and what last went wrong?
app.get("/api/health", (req, res) => {
  if (!writeAuthed(req, res)) return;
  const now = Date.now();
  res.json({
    phase: botPhase,
    secsSinceCycle: botStatus.lastCycleAt ? Math.round((now - botStatus.lastCycleAt) / 1000) : null,
    lastOkAt: botStatus.lastOkAt,
    lastError: botStatus.lastError,
    lastErrorAt: botStatus.lastErrorAt,
    alive: botStatus.lastCycleAt != null && (now - botStatus.lastCycleAt) < 15 * 60_000,
  });
});

// Aggregate on-chain stats for the Transparency page.
app.get("/api/stats", async (_req, res) => {
  try {
    const pulls = readPulls();
    const balances = wallet ? await cached("bal:" + wallet, 5000, () => getBalances(wallet)) : { sol: 0, usdc: 0 };
    let round = 1;
    try { round = JSON.parse(readFileSync(join(__dir, "..", "airdrop-state.json"), "utf8")).round || 1; } catch {}
    // Everything derives from the same pulls list so the numbers are always consistent:
    // each pull = 1 pack opened; a pull carries a recipient once airdropped; value = that card's value.
    const airdropped = pulls.filter((p) => p.airdropTo);
    const valueUsd = airdropped.reduce((s, p) => s + (Number(p.value) || 0), 0);
    res.json({
      wallet, balances,
      packs: pulls.length,           // packs opened (1 card each)
      airdrops: airdropped.length,   // cards airdropped — equals packs when every card is sent
      valueUsd,                      // sum of the airdropped cards' individual values
      round,
      lastPullTs: pulls.length ? pulls[pulls.length - 1].ts : null,
    });
  } catch (e) { res.status(500).json({ error: safeErr(e) }); }
});

// Combined live snapshot the dashboard polls every ~3s (cached to spare the RPC).
app.get("/api/live", async (_req, res) => {
  try {
    const [rewards, balances] = await Promise.all([
      cached("rewards", 4000, () => coinMint ? getRewards(coinMint) : { unclaimedUsd: 0, unclaimedSol: 0, status: "no-coin" }),
      wallet ? cached("bal:" + wallet, 4000, () => getBalances(wallet)) : Promise.resolve({ sol: 0, usdc: 0 }),
    ]);
    res.json({ rewards, balances, phase: botPhase });
  } catch (e) { res.status(500).json({ error: safeErr(e) }); }
});

// Bot ingests an opened pack: { mint, name, image, grade, grader }
app.post("/api/pulls", (req, res) => {
  if (!writeAuthed(req, res)) return;
  const p = req.body || {};
  if (!p.mint && !p.name) return res.status(400).json({ error: "need mint or name" });
  const pull = {
    ts: Date.now(),
    mint: p.mint || "", name: p.name || "Unknown card",
    image: p.image || p.front || "", front: p.front || p.image || "", back: p.back || "",
    grade: p.grade || "", grader: p.grader || "", gradeText: p.gradeText || "",
    year: p.year || "", value: Number(p.value) || 0, category: p.category || "",
    rarity: p.rarity || "", // CC's own tier when a real pull supplies it
    airdropTo: p.airdropTo || "", // recipient wallet for the airdrop announcement
    airdropTx: p.airdropTx || "", // on-chain signature of the card transfer (for "view tx")
  };
  const list = readPulls(); list.push(pull); writePulls(list);
  sseBroadcast("pull", pull); // push to every connected viewer at once
  res.json({ ok: true, pull });
});

// Real-time stream: viewers receive each new pull the instant it happens.
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // don't let proxies buffer the stream
  });
  res.write("retry: 3000\n\n");   // tell EventSource to reconnect after 3s
  res.write(": connected\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Fallback poll (older clients / reconnect gaps).
app.get("/api/pulls", (req, res) => {
  const after = Number(req.query.after) || 0;
  res.json({ pulls: readPulls().filter((p) => p.ts > after) });
});

app.get("/how", (_req, res) => res.sendFile(join(__dir, "public", "how.html")));
app.get("/transparency", (_req, res) => res.sendFile(join(__dir, "public", "transparency.html")));
app.get("/airdrops", (_req, res) => res.sendFile(join(__dir, "public", "airdrops.html")));
app.get("/hall", (_req, res) => res.sendFile(join(__dir, "public", "hall.html")));
app.get("/eligibility", (_req, res) => res.sendFile(join(__dir, "public", "eligibility.html")));

// A wallet's airdrop eligibility (weight tier, cards received). READ-ONLY.
app.get("/api/eligibility", async (req, res) => {
  const wallet = String(req.query.wallet || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return res.status(400).json({ error: "Enter a valid Solana wallet address." });
  try {
    const s = await getStanding(wallet);
    const received = readPulls().filter((p) => p.airdropTo === wallet).length;
    res.json({ ...s, wallet, received });
  } catch (e) { res.status(500).json({ error: safeErr(e) }); }
});

// Hall of Fame: every pulled card ranked by insured value (highest first). This view
// is purely the card leaderboard — it deliberately omits the recipient wallet and the
// airdrop tx (they're never sent to the client here).
app.get("/api/hall", (_req, res) => {
  const cards = readPulls()
    .filter((p) => Number(p.value) > 0)
    .map((p) => ({
      mint: p.mint, name: p.name, image: p.image || p.front || "",
      grade: p.grade, grader: p.grader, gradeText: p.gradeText,
      year: p.year, value: Number(p.value) || 0, rarity: p.rarity || "",
    }))
    .sort((a, b) => b.value - a.value);
  res.json({ cards });
});

app.use(express.static(join(__dir, "public")));

// Optional local extension module, loaded if present.
try {
  const ext = await import("./local.js");
  ext.register?.(app, { readPulls, writePulls, sseBroadcast });
} catch { /* none */ }

app.listen(port, () => {
  console.log(`\n  CC Gacha dashboard → http://localhost:${port}`);
  console.log(`  wallet : ${wallet || "(not set — edit .env)"}`);
  console.log(`  coin   : ${coinMint || "(not created yet)"}\n`);
});

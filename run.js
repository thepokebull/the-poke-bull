// POC runner. Usage:
//   node run.js login     -> headless SIWS login, prints the Privy session token
//   node run.js balance   -> read the wallet's on-chain USDC balance
//   node run.js all        -> both (default)
//
// Reads the throwaway keypair from wallet.json (run `npm run gen-key` first).

import { existsSync } from "node:fs";
import { login } from "./lib/siws.js";
import { readUsdcBalance, fetchGachaWalletPubkeys } from "./lib/balance.js";
import { decodeTx } from "./lib/decode.js";
import { loadKeypair } from "./lib/wallet.js";

// Load .env if present (RPC_URL, WALLET_ADDRESS) — optional for `decode`.
if (existsSync(new URL("./.env", import.meta.url))) process.loadEnvFile(new URL("./.env", import.meta.url));

function loadWallet() {
  try {
    return loadKeypair({ dir: import.meta.dirname, expectAddress: process.env.WALLET_ADDRESS?.trim() || undefined });
  } catch (e) {
    console.error(String(e.message || e));
    console.error("(or run `npm run gen-key` for a throwaway wallet)");
    process.exit(1);
  }
}

function decodeJwt(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function doLogin(kp) {
  const address = kp.publicKey.toBase58();
  console.log("\n=== STEP 1: Headless SIWS login ===");
  console.log("wallet:", address);
  const result = await login({ address, secretKey: kp.secretKey });

  if (!result.token) {
    console.log("⚠  Login returned no token. Full auth response for inspection:");
    console.dir(result.authResponse, { depth: 6 });
    return null;
  }

  console.log("✅ Logged in. Privy session token (JWT):");
  console.log(result.token.slice(0, 60) + "…");
  const claims = decodeJwt(result.token);
  if (claims) {
    console.log("   token claims:", {
      sub: claims.sub, iss: claims.iss, aud: claims.aud,
      exp: claims.exp && new Date(claims.exp * 1000).toISOString(),
    });
  }
  if (result.user) console.log("   privy user id:", result.user.id);
  return result.token;
}

async function doBalance(kp) {
  const address = kp.publicKey.toBase58();
  console.log("\n=== STEP 2: Read on-chain USDC balance ===");
  const bal = await readUsdcBalance(address);
  console.log("wallet USDC:", bal.uiAmount, `(ATA ${bal.ata}, exists=${bal.exists})`);
  if (!bal.exists) console.log("   (fresh wallet has no USDC ATA yet — expected; read path works)");

  console.log("\n--- Bonus: gacha machine wallets (probable funding destinations) ---");
  try {
    const pk = await fetchGachaWalletPubkeys();
    console.log(`getGachaWalletPubkeys -> HTTP ${pk.status}`);
    console.dir(pk.json, { depth: 4 });
  } catch (e) {
    console.log("probe failed:", String(e.message || e));
  }
}

const cmd = process.argv[2] || "all";

try {
  if (cmd === "decode") {
    // No wallet needed — a tx signature is public.
    const sig = process.argv[3];
    if (!sig) { console.error("Usage: node run.js decode <tx-signature>"); process.exit(1); }
    console.log("\n=== FUNDING TRACE: decoding deposit tx ===");
    const out = await decodeTx(sig);
    console.dir(out, { depth: 6 });
    const gacha = out.tokenTransfers.find((t) => t.isKnownGachaWallet);
    if (gacha) {
      console.log(`\n➡  USDC went to a KNOWN gacha machine wallet: ${gacha.tokenAccountOwner}`);
      console.log(`   amount=${gacha.amount} mint=${gacha.mint}`);
    }
    if (out.memos.length) console.log(`➡  Memo/reference on the tx:`, out.memos);
    else console.log(`➡  No memo instruction — deposit is likely tagged by sender address or an API call.`);
  } else {
    const kp = loadWallet();
    if (cmd === "login") await doLogin(kp);
    else if (cmd === "balance") await doBalance(kp);
    else { await doLogin(kp); await doBalance(kp); }
  }
  console.log("\nDone.");
} catch (e) {
  console.error("\n❌ Error:", e.message || e);
  process.exit(1);
}

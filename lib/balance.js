// Read the on-chain USDC balance the exact way the gacha frontend does:
// derive the associated token account (ATA) for (owner, USDC mint) and call
// getTokenAccountBalance. The site polls this every 5s as "your balance".

import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { config } from "../config.js";

export async function readUsdcBalance(ownerBase58, { allowOwnerOffCurve = false } = {}) {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const owner = new PublicKey(ownerBase58);
  const mint = new PublicKey(config.usdcMint);

  // allowOwnerOffCurve mirrors the bundle's `true` flag — needed only when the
  // owner is a PDA/off-curve deposit account (the funding trace will tell us if
  // Collector Crypt uses one). For a plain wallet, false is correct.
  const ata = await getAssociatedTokenAddress(
    mint, owner, allowOwnerOffCurve, TOKEN_PROGRAM_ID
  );

  try {
    const res = await conn.getTokenAccountBalance(ata, "confirmed");
    return { ata: ata.toBase58(), uiAmount: res.value.uiAmount, raw: res.value.amount, exists: true };
  } catch (e) {
    // No ATA yet => zero balance (expected for a fresh throwaway wallet).
    return { ata: ata.toBase58(), uiAmount: 0, raw: "0", exists: false, note: String(e.message || e) };
  }
}

// Probe the (apparently unauthenticated) endpoint that lists the gacha machine
// wallets — the likely USDC funding destinations. Helps the later funding trace.
export async function fetchGachaWalletPubkeys() {
  const res = await fetch(`${config.gachaApiBase}/api/getGachaWalletPubkeys`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, json };
}

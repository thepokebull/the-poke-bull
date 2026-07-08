// PumpFun creator rewards: read accrued fees + claim them.
//
// CLAIM uses PumpPortal's non-custodial "Local" API: it returns an unsigned tx
// for action=collectCreatorFee, which we sign locally and send. We never hand
// anyone the key.
//
// READ (getCreatorRewards) is the ONE piece we can't fully verify until the coin
// exists — pump.fun's public shape for "claimable creator fee" isn't guaranteed.
// So it is best-effort and, crucially, returns unclaimedUsd=null when unsure. The
// loop treats null as "don't claim", so we never claim blindly. Validate this
// against the real coin once it's live. [[collaborate-when-unsure]]
import { VersionedTransaction, PublicKey, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { solUsd } from "./price.js";

const PUMPPORTAL = process.env.PUMPPORTAL_BASE || "https://pumpportal.fun/api";
// pump.fun bonding-curve program. Creator rewards accrue to a per-creator PDA under it.
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
// PumpSwap AMM program — AFTER a coin graduates, creator fees accrue here (as WSOL)
// in a token account owned by the ["creator_vault", creator] PDA.
const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
// Rent-exempt minimum for the 0-data creator vault (system-owned SOL holder).
const VAULT_RENT_LAMPORTS = 890880;

// The per-creator "creator-vault" PDA where pump.fun accrues unclaimed rewards (as SOL).
// Verified on-chain: seeds ["creator-vault", creator], program 6EF8… . Not coin-specific.
export function creatorVaultPda(creator) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), new PublicKey(creator).toBuffer()],
    PUMP_PROGRAM,
  )[0];
}

// The PumpSwap creator-vault authority PDA (holds post-graduation creator fees as WSOL).
export function pumpswapCreatorVaultAuthority(creator) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), new PublicKey(creator).toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
}

// Read unclaimed creator rewards straight from chain. READ-ONLY: no coin mint,
// no private key. Sums BOTH sources so it works before AND after graduation:
//   • bonding-curve creator-vault (pre-migration) — SOL held in the pump PDA
//   • PumpSwap creator-vault WSOL token account (post-migration) — fees as WSOL
export async function readCreatorVault({ connection, creator }) {
  const conn = connection || new Connection(process.env.RPC_URL, "confirmed");
  // 1) pre-migration bonding-curve vault
  const pda = creatorVaultPda(creator);
  const lamports = await conn.getBalance(pda);
  const bcSol = Math.max(0, lamports - VAULT_RENT_LAMPORTS) / 1e9;
  // 2) post-migration PumpSwap creator fees (WSOL in the authority's token account)
  let ammSol = 0;
  try {
    const ata = await getAssociatedTokenAddress(WSOL, pumpswapCreatorVaultAuthority(creator), true);
    ammSol = (await conn.getTokenAccountBalance(ata)).value.uiAmount || 0;
  } catch { /* ATA absent (not migrated / no fees yet) */ }
  return { pda: pda.toBase58(), lamports, sol: bcSol + ammSol, bcSol, ammSol };
}

export async function getCreatorRewards({ wallet, connection }) {
  if (!wallet) return { status: "no-wallet", unclaimedUsd: null, unclaimedSol: null };
  try {
    const { sol, lamports } = await readCreatorVault({ connection, creator: wallet });
    const px = await solUsd().catch(() => null);
    return {
      status: "ok",
      unclaimedSol: sol,
      unclaimedUsd: px != null ? sol * px : null,
      lamports,
      solPrice: px,
      source: "creator-vault",
    };
  } catch (e) {
    // Never claim on an unreadable balance — null tells the loop to skip claiming.
    return { status: "error", unclaimedUsd: null, unclaimedSol: null, note: e.message };
  }
}

// Claim ALL accrued creator fees to the wallet (as SOL). Returns SOL delta.
export async function claimCreatorFees({ connection, keypair, dryRun = true, priorityFee = 0.000001 }) {
  if (dryRun) return { dryRun: true, note: "would POST collectCreatorFee to PumpPortal, sign, send" };

  const before = await connection.getBalance(keypair.publicKey);
  const r = await fetch(`${PUMPPORTAL}/trade-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: keypair.publicKey.toBase58(),
      action: "collectCreatorFee",
      priorityFee,
    }),
  });
  if (!r.ok) throw new Error(`PumpPortal collectCreatorFee failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([keypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");
  const after = await connection.getBalance(keypair.publicKey);
  return { dryRun: false, signature: sig, claimedSol: Math.max(0, (after - before) / 1e9) };
}

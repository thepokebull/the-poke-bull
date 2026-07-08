// SOL -> USDC swap via Jupiter (lite-api, no key needed).
import { VersionedTransaction } from "@solana/web3.js";

const BASE = process.env.JUPITER_BASE || "https://lite-api.jup.ag/swap/v1";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export async function getQuote({ inputMint = SOL_MINT, outputMint = USDC_MINT, amount, slippageBps = 50 }) {
  const url = `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const r = await fetch(url);
  const q = await r.json();
  if (!q?.outAmount) throw new Error("Jupiter quote failed: " + JSON.stringify(q).slice(0, 200));
  return q;
}

async function buildSwapTx({ quote, userPublicKey }) {
  const r = await fetch(`${BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  const j = await r.json();
  if (!j?.swapTransaction) throw new Error("Jupiter swap build failed: " + JSON.stringify(j).slice(0, 200));
  return j.swapTransaction; // base64 VersionedTransaction
}

// Swap `solLamports` of SOL into USDC. dryRun => quote only, no signing/sending.
export async function solToUsdc({ connection, keypair, solLamports, slippageBps = 50, dryRun = true }) {
  const quote = await getQuote({ amount: solLamports, slippageBps });
  const expectedUsdc = Number(quote.outAmount) / 1e6;
  if (dryRun) return { dryRun: true, expectedUsdc, priceImpactPct: quote.priceImpactPct };

  const b64 = await buildSwapTx({ quote, userPublicKey: keypair.publicKey.toBase58() });
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([keypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");
  return { dryRun: false, signature: sig, expectedUsdc };
}

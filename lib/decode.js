// Decode a deposit transaction from its signature to reverse-engineer the
// funding recipe: token transfers (source/dest/amount/mint), memo/reference,
// and every program invoked. A tx signature is public, so this needs nothing
// sensitive from the user.

import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";

const MEMO_PROGRAMS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);
const KNOWN_GACHA_WALLETS = new Set([
  "coMiCPLD4P8NV9Q6VDhwYUn9pkkgPwp74VyWdU7kMpA",
  "PoP8747uHUq6ckFstUTPCTqZHZT1vZBTpiwPinFjvUM",
  "boXnWdYJDJrKyjKdTDGnVBHqvLy3B6NCrUU2YRUwykD",
  "BbaLLq9ZCFG1Jv3UThK1Jb4aXzpog7MGDU8Djcu82HP8",
  "FBLLkV4QYk9NifMS4HT2U4rK9h6CXe3soTjKsXS5Cf5w",
  "BsBLLQUsLg5etS8N3SuTcsjrEq3bJfj2hjV8fq3JMAuo",
  "SCCrBX1SbuGKaJMf66tVqsWAopcTUTYBvHeQiqaBdUU",
  "YugienwXYWnTQmAkRgBMc556ZLvidV7bTn1f2q8pGEs",
  "SPidzaLP6YtyVSG2hGZB1Y86ymHeR9zPJfToRDgmzjd",
]);

export async function decodeTx(signature) {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const tx = await conn.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) throw new Error("Transaction not found (wrong cluster? try RPC_URL=<mainnet>).");

  const msg = tx.transaction.message;
  const ixs = [
    ...msg.instructions,
    ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) || []),
  ];

  const programs = new Set();
  const memos = [];
  const tokenTransfers = [];
  const solTransfers = [];

  for (const ix of ixs) {
    const prog = ix.programId?.toBase58?.() || ix.programId;
    programs.add(prog);

    if (MEMO_PROGRAMS.has(prog)) {
      memos.push(ix.parsed ?? ix.data ?? "(unparsed memo)");
    }
    const p = ix.parsed;
    if (!p) continue;
    if (p.type === "transferChecked" || p.type === "transfer") {
      if (p.info?.mint || p.info?.tokenAmount || ix.program === "spl-token") {
        tokenTransfers.push({
          type: p.type,
          source: p.info.source,
          destination: p.info.destination,
          authority: p.info.authority || p.info.multisigAuthority,
          mint: p.info.mint,
          amount: p.info.tokenAmount?.uiAmountString ?? p.info.amount,
        });
      } else if (p.info?.lamports != null) {
        solTransfers.push({ source: p.info.source, destination: p.info.destination, lamports: p.info.lamports });
      }
    }
  }

  // Resolve the OWNER behind each destination token account (ATA -> owner),
  // and flag if it's one of the known gacha machine wallets.
  const resolved = [];
  for (const t of tokenTransfers) {
    let ownerInfo = null;
    try {
      const acc = await conn.getParsedAccountInfo(new PublicKey(t.destination));
      const owner = acc.value?.data?.parsed?.info?.owner;
      ownerInfo = {
        tokenAccountOwner: owner,
        isKnownGachaWallet: owner ? KNOWN_GACHA_WALLETS.has(owner) : false,
      };
    } catch { /* ignore */ }
    resolved.push({ ...t, ...ownerInfo });
  }

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime && new Date(tx.blockTime * 1000).toISOString(),
    programs: [...programs],
    memos,
    tokenTransfers: resolved,
    solTransfers,
  };
}

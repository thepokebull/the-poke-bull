// Local, flexible keypair loader. Reads the signing key from a gitignored file
// on YOUR machine — the secret never passes through chat, git, or memory.
//
// Accepted files (first that exists wins), all gitignored:
//   wallet.key   -> a base58 secret key string (what Phantom "Export Private Key" gives)
//                   OR a base64 secret key string
//   wallet.json  -> a JSON array of 64 bytes (what `solana-keygen` writes)
//
// Put your key in place WITHOUT exposing it to shell history, e.g. on macOS:
//   copy the base58 key to your clipboard, then:   pbpaste > ~/cc-gacha-poc/wallet.key
//
import { readFileSync, existsSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function fromSecretBytes(bytes) {
  const u8 = Uint8Array.from(bytes);
  if (u8.length === 64) return Keypair.fromSecretKey(u8);
  if (u8.length === 32) return Keypair.fromSeed(u8); // some tools export the 32-byte seed
  throw new Error(`Unexpected secret key length: ${u8.length} (want 64, or 32 seed)`);
}

function parseString(raw) {
  const s = raw.trim();
  // JSON array?
  if (s.startsWith("[")) return fromSecretBytes(JSON.parse(s));
  // base58 (Phantom export) — bs58 alphabet has no 0 O I l, so try it first
  try { return fromSecretBytes(bs58.decode(s)); } catch { /* fall through */ }
  // base64 fallback
  try { return fromSecretBytes(Buffer.from(s, "base64")); } catch { /* fall through */ }
  throw new Error("Could not parse key file as JSON array, base58, or base64.");
}

// Returns a Keypair, or throws with a clear message if no key file is present.
export function loadKeypair({ dir = process.cwd(), expectAddress } = {}) {
  const candidates = [
    process.env.KEYFILE,
    `${dir}/wallet.key`,
    `${dir}/wallet.json`,
  ].filter(Boolean);

  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      "No key file found. Put your base58 private key in wallet.key " +
      "(e.g.  pbpaste > wallet.key ) or a 64-byte array in wallet.json."
    );
  }

  const kp = parseString(readFileSync(path, "utf8"));

  // Safety: make sure the loaded key matches the wallet you intend to use.
  if (expectAddress && kp.publicKey.toBase58() !== expectAddress) {
    throw new Error(
      `Key in ${path} is for ${kp.publicKey.toBase58()}, but expected ${expectAddress}. ` +
      "Wrong key file?"
    );
  }
  return kp;
}

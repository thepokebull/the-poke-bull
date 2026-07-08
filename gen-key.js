// Generate a throwaway Solana keypair for the POC and save it as wallet.json
// (same format as `solana-keygen` — a JSON array of 64 secret-key bytes).
import { writeFileSync, existsSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { config } from "./config.js";

const path = config.keyfilePath;
if (existsSync(path)) {
  console.error(`Refusing to overwrite existing ${path}. Delete it first if intentional.`);
  process.exit(1);
}

const kp = Keypair.generate();
writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
console.log("Generated throwaway wallet:");
console.log("  address :", kp.publicKey.toBase58());
console.log("  keyfile :", path);
console.log("\nThis wallet holds nothing. It only proves the headless SIWS login works.");

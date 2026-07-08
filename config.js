// Static values reverse-engineered from gacha.collectorcrypt.com's JS bundles.
// If Collector Crypt rotates any of these, re-extract from the site.

export const config = {
  // Privy app that fronts Collector Crypt's auth (from the gacha bundle).
  privyAppId: "cmdgt21w400lgky0mkn069jui",
  privyBaseUrl: "https://auth.privy.io",

  // The site the SIWS message is scoped to. Privy verifies domain/uri, so these
  // must match what the real frontend sends.
  siteHost: "gacha.collectorcrypt.com",
  siteOrigin: "https://gacha.collectorcrypt.com",

  // Solana. The bundle uses a private Helius RPC; a public endpoint is fine for
  // read-only balance checks. Override with RPC_URL env var if you have Helius.
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",

  // USDC (Solana mainnet) mint, referenced verbatim in the bundle.
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

  // Collector Crypt's own backend (for the funding-destination probe).
  gachaApiBase: "https://gacha.collectorcrypt.com",

  // Where the keypair lives. NEVER commit this file. Use a throwaway wallet.
  keyfilePath: process.env.KEYFILE || "./wallet.json",
};

// The exact Solana SIWS message template Privy's client builds, lifted from the
// bundle. Field order and wording matter — Privy re-derives and compares.
export function buildSiwsMessage({ host, origin, address, nonce, issuedAt }) {
  return (
    `${host} wants you to sign in with your Solana account:\n` +
    `${address}\n` +
    `\n` +
    `You are proving you own ${address}.\n` +
    `\n` +
    `URI: ${origin}\n` +
    `Version: 1\n` +
    `Chain ID: mainnet\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}\n` +
    `Resources:\n` +
    `- https://privy.io`
  );
}

# The Poke Bull ($TAUROS)

An automated pipeline that turns a Pump.fun token's **creator rewards** into real, graded
Pokémon cards — opened live on [Collector Crypt](https://gacha.collectorcrypt.com/) and
**airdropped to $TAUROS holders** — with a live web dashboard that reveals every pull in real time.
Live at [thepokebull.xyz](https://thepokebull.xyz).

```
creator rewards → auto-claim → swap to USDC → open Pokémon gacha packs → airdrop to a holder → live reveal
```

## How it works

1. **Track** — the token earns creator rewards on every trade.
2. **Claim** — once claimable rewards pass the threshold, they're claimed non-custodially (PumpPortal).
3. **Swap** — all SOL above a small gas reserve is swapped to USDC (Jupiter).
4. **Open** — the USDC opens the $50 Elite Pokémon Gacha Pack on Collector Crypt (each pull is a graded, tokenized card).
5. **Airdrop** — every card is airdropped to an eligible holder (holding 0.5%–4% of supply).
6. **Reveal** — every pull is pushed live to the dashboard (Server-Sent Events).

## Project layout

```
bot.js                 # entry point: `once` | `loop` | `demo`
lib/
  loop.js              # the cycle orchestrator (track → claim → swap → open → airdrop)
  pump.js              # read + claim creator rewards
  jupiter.js           # SOL → USDC swap
  gacha.js             # open a Collector Crypt pack (Privy SIWS auth)
  airdrop.js           # eligible-holder selection + pNFT transfer
  siws.js              # headless Sign-In-With-Solana
  wallet.js            # local keypair loader
  price.js             # SOL/USD
dashboard/
  server.js            # Express API + static host + live SSE feed
  public/              # the site (home, how, airdrops, transparency)
```

## Setup

Requires Node 18+.

```bash
npm install
cp .env.example .env          # then fill in the values (see below)
```

Provide the signing key locally (never commit it). Export the base58 private key from your
wallet and save it as `wallet.key`:

```bash
pbpaste > wallet.key          # macOS: copy the key to clipboard first
```

## Configuration (`.env`)

| Variable | What it is |
|---|---|
| `RPC_URL` | Solana RPC (Helius recommended — DAS methods needed for holders/cards) |
| `WALLET_ADDRESS` | The project wallet (public address) |
| `COIN_MINT` | The token mint — leave empty until the coin exists |
| `CLAIM_THRESHOLD_USD` | Claim once rewards reach this (default 55) |
| `PACK_USD` | Pack price (50) |
| `MIN_SOL_RESERVE` | SOL kept for gas (0.05) |
| `MAX_PACKS_PER_CYCLE` / `MAX_SPEND_PER_CYCLE_USD` | Safety caps per cycle |
| `AIRDROP_MIN_PCT` / `AIRDROP_MAX_PCT` | Eligible holder band (0.5 / 3) |
| `AIRDROP_EXCLUDE` | Comma-separated wallets to never airdrop (LP/pools) |
| `REFERRAL` | Collector Crypt referral code |
| `DRY_RUN` | `true` by default — nothing signs or spends |

## Running

```bash
npm run dashboard     # the live site at http://localhost:8787
npm run bot           # one cycle (dry-run by default)
npm run bot:loop      # run continuously
npm run bot:demo      # simulate a full cycle to preview the live reveal
```

**Safety:** `DRY_RUN=true` is the default and nothing signs or spends. Going live requires
`DRY_RUN=false` **and** passing `--i-understand`, with spend caps set.

## Security

- **Never commit `.env` or `wallet.key`** — both are gitignored. `.env.example` holds placeholders only.
- The signing key stays on the machine that runs the bot; it is loaded locally by `lib/wallet.js`.

## Assets

The brand/media assets (the gacha machine video, card art, sprites, and logos) are **not included**
in this repository for licensing reasons. The app and API run fine without them; the visuals simply
won't render until you drop your own files into `dashboard/public/` — e.g. `machine.webm`,
`machine-mask.png`, `tauros.png`, `wordmark.png`, and a `sprites/` folder.

## Disclaimer

This is an independent project. Pokémon and the trading cards are the property of their
respective owners; Collector Crypt, Pump.fun, and Jupiter are third-party services. Not affiliated
with or endorsed by any of them. Use at your own risk.

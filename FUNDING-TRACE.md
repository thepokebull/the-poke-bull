# Funding trace plan

Goal: with **one small real USDC deposit**, resolve the last unknown in the auto-loop
— exactly how Collector Crypt's gacha balance gets funded — so we can reproduce it headlessly.

## Wallet model (decided)
**One wallet, lean + auto-sweep.** The creator wallet creates the coin, receives fees,
auto-claims, swaps to USDC, logs into CC, funds, and opens packs. Because its key is hot
on the server, the loop **sweeps profit + pulled NFTs to a separate cold vault** and keeps
only a small operating float at rest. Do the trace below with THIS wallet.

## Four questions the trace must answer
1. **Destination** — one of the 9 machine wallets, a per-user PDA, or elsewhere?
2. **Tagging** — is there a memo/reference binding the deposit to your account?
3. **Program** — plain SPL transfer, or a Collector Crypt deposit instruction?
4. **Balance semantics** — which token account changes, and how fast the UI updates.

## Do this (≈5 min, nothing sensitive leaves your machine)
1. Log into gacha.collectorcrypt.com with the wallet. Open DevTools → Network → tick
   "Preserve log".
2. Click **Deposit**, send **$5–10 USDC**, approve in the wallet.
3. Copy the **transaction signature**.
4. *(optional but ideal)* Network → "Save all as HAR", or screenshot the payloads of any
   `/api/*` calls that fired (`/api/coinflow/*`, a possible `/api/deposit`, `submitTransaction`).
5. Note how long until the on-screen balance updated.

## Then (instant)
```bash
cd ~/cc-gacha-poc
node run.js decode <transaction-signature>
```
Prints: destination + resolved owner (auto-flags the 9 known machine wallets), memo/reference,
amount, mint, and every program invoked. That answers Q1–Q3 on its own; the HAR/API capture
and the balance-update timing answer Q4.

## Output → the reusable recipe
From the decode we write the exact headless deposit:
`build USDC transfer to <dest ATA> for <amount> [+ memo <reference>] → sign → submit`,
which becomes the "fund gacha balance" step of the loop.

## Only-if-needed follow-up
If there's NO memo and the destination is a shared machine wallet, funding is likely tagged
by an `/api/*` call (sender address + an API notify). In that case we also capture that call's
request/response from the HAR — hence grabbing it during the deposit is worthwhile.

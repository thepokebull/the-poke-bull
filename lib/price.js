// SOL/USD spot price (for valuing rewards and enforcing USD spend caps).
// Cached ~60s and serves the last good value if the (rate-limit-prone free)
// CoinGecko API blips, so a transient 429 never stalls a claim/swap cycle.
let _cache = { price: 0, at: 0 };
export async function solUsd() {
  const now = Date.now();
  if (_cache.price && now - _cache.at < 60_000) return _cache.price;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    const p = j?.solana?.usd;
    if (!p) throw new Error("price field missing");
    _cache = { price: p, at: now };
    return p;
  } catch (e) {
    if (_cache.price) return _cache.price; // serve stale rather than fail the cycle
    throw new Error("Could not read SOL price: " + (e.message || e));
  }
}

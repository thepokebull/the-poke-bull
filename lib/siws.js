// Headless Sign-In-With-Solana against Privy (the auth layer Collector Crypt uses).
//
// Flow (all reverse-engineered from the gacha bundle):
//   1) POST /api/v1/siws/init  { address }            -> { nonce, ... }
//   2) build the exact SIWS message, sign it (ed25519) with the wallet key
//   3) POST /api/v1/siws/authenticate { message, signature, ... } -> { token, user, ... }
//
// The returned `token` is a Privy access-token JWT — the same session the website
// holds after you click "Sign in with wallet". No browser, no popup.

import nacl from "tweetnacl";
import bs58 from "bs58";
import { config, buildSiwsMessage } from "../config.js";

const clientHeader = process.env.PRIVY_CLIENT || "react-auth:2.13.0";

function privyHeaders() {
  return {
    "Content-Type": "application/json",
    "privy-app-id": config.privyAppId,
    "privy-client": clientHeader,
    // Privy checks the request origin against the app's allowlist.
    Origin: config.siteOrigin,
    Referer: config.siteOrigin + "/",
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: privyHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

// Step 1: ask Privy for a login nonce tied to this address.
export async function initSiws(address) {
  const url = `${config.privyBaseUrl}/api/v1/siws/init`;
  const { ok, status, json } = await postJson(url, { address });
  if (!ok) {
    throw new Error(`siws/init failed (${status}): ${JSON.stringify(json)}`);
  }
  return json; // expected: { nonce, address, expires_at }
}

// Step 3: submit the signed message and receive the session token.
export async function authenticateSiws({ message, signatureB64 }) {
  const url = `${config.privyBaseUrl}/api/v1/siws/authenticate`;
  const body = {
    message,
    signature: signatureB64,
    // The bundle logs in via the injected Solana wallet adapter. These two
    // fields tell Privy how the wallet connected; adjust if it 400s.
    walletClientType: "phantom",
    connectorType: "solana_adapter",
    mode: "login-or-sign-up",
  };
  const { ok, status, json } = await postJson(url, body);
  if (!ok) {
    throw new Error(`siws/authenticate failed (${status}): ${JSON.stringify(json)}`);
  }
  return json; // expected: { token, privy_access_token, identity_token, user, ... }
}

// Sign a UTF-8 message with an ed25519 secret key (64-byte solana secretKey).
function signMessage(message, secretKey) {
  const msgBytes = new TextEncoder().encode(message);
  const sig = nacl.sign.detached(msgBytes, secretKey);
  return Buffer.from(sig).toString("base64");
}

// Full login. Returns { token, user, message, initResponse, authResponse }.
export async function login({ address, secretKey }) {
  const initResponse = await initSiws(address);
  const nonce = initResponse.nonce;
  if (!nonce) throw new Error(`No nonce in init response: ${JSON.stringify(initResponse)}`);

  const issuedAt = new Date().toISOString();
  const message = buildSiwsMessage({
    host: config.siteHost,
    origin: config.siteOrigin,
    address,
    nonce,
    issuedAt,
  });

  const signatureB64 = signMessage(message, secretKey);
  const authResponse = await authenticateSiws({ message, signatureB64 });

  const token =
    authResponse.token ||
    authResponse.privy_access_token ||
    authResponse.access_token ||
    null;

  return { token, user: authResponse.user, message, initResponse, authResponse };
}

export { signMessage, bs58 };

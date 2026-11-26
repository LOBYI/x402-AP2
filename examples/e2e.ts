/**
 * End-to-end demo over real HTTP (localhost), human-not-present flow:
 *
 *   1. User issues open checkout + open payment mandates to their shopping agent.
 *   2. Agent GETs a paid resource → merchant answers 402 with an AP2 checkout inside x402 PaymentRequired.
 *   3. Agent checks the checkout against the user's constraints, derives closed mandates,
 *      signs an EIP-3009 authorization whose nonce = keccak256(payment mandate), retries.
 *   4. Merchant verifies mandates + binding + x402 (LocalFacilitator), settles, serves the content.
 *
 * Run: npm run example
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Ap2X402Client,
  Ap2X402Merchant,
  LocalFacilitator,
  USDC_BASE_SEPOLIA,
  createOpenCheckoutMandate,
  createOpenPaymentMandate,
  generateKeyPairJwk,
  toNodeHandler,
} from "../src/index.js";

const USER_ID = "user:alice";

// ── Keys ────────────────────────────────────────────────────────────────────
const user = await generateKeyPairJwk(); // user's trusted-device key (signs mandates)
const agent = await generateKeyPairJwk(); // shopping agent key (cnf of open mandates)
const merchantKey = await generateKeyPairJwk(); // merchant checkout-signing key
const wallet = privateKeyToAccount(generatePrivateKey()); // payer wallet (EIP-3009)
const merchantWallet = privateKeyToAccount(generatePrivateKey()).address;

// ── Merchant server ─────────────────────────────────────────────────────────
const server = createServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const merchantInfo = { id: "weather.example", name: "Weather Data Co.", website: origin };

const merchant = new Ap2X402Merchant({
  merchant: merchantInfo,
  signingKey: merchantKey.privateJwk,
  payTo: merchantWallet,
  asset: USDC_BASE_SEPOLIA,
  facilitator: new LocalFacilitator(), // swap for new HttpFacilitator({ url: "https://x402.org/facilitator" })
  resolveUserKey: (iss) => (iss === USER_ID ? user.publicJwk : null),
});

const forecast = merchant.protect(
  (_req, payment) =>
    Response.json({ city: "Seoul", forecast: "sunny, 21°C", paidBy: payment.payer }),
  {
    description: "7-day forecast API",
    cart: () => ({ line_items: [{ id: "forecast-7d", title: "7-day forecast", quantity: 1, unit_price: 25 }] }),
  },
);
server.on("request", toNodeHandler(forecast, { baseUrl: origin }));

// ── User delegates to the agent ─────────────────────────────────────────────
const openCheckoutMandate = await createOpenCheckoutMandate(
  user.privateJwk,
  [
    { type: "checkout.allowed_merchants", allowed: [merchantInfo] },
    { type: "checkout.line_items", items: [{ id: "weather", acceptable_items: [{ id: "forecast-7d", title: "7-day forecast" }], quantity: 1 }] },
  ],
  { issuer: USER_ID, agentPublicJwk: agent.publicJwk },
);
const openPaymentMandate = await createOpenPaymentMandate(
  user.privateJwk,
  [
    { type: "payment.amount_range", currency: "USD", max: 100 }, // ≤ $1.00 per purchase
    { type: "payment.budget", currency: "USD", max: 60 }, // ≤ $0.60 in total
    { type: "payment.allowed_payees", allowed: [merchantInfo] },
  ],
  { issuer: USER_ID, agentPublicJwk: agent.publicJwk },
);

// ── Agent shops ─────────────────────────────────────────────────────────────
const client = new Ap2X402Client({
  wallet,
  mode: { kind: "human_not_present", agentKey: agent.privateJwk, userPublicKey: user.publicJwk, openCheckoutMandate, openPaymentMandate },
});

try {
  for (let i = 1; i <= 3; i++) {
    try {
      const { response, payment } = await client.pay(`${origin}/forecast`);
      console.log(`#${i} HTTP ${response.status}`, await response.json());
      console.log(`   paid ${payment?.checkout.total.amount}¢ → ${payment?.requirements.amount} atomic USDC, settled=${payment?.settlement?.success} tx=${payment?.settlement?.transaction}`);
    } catch (e) {
      console.log(`#${i} blocked by agent:`, (e as Error).message);
    }
  }
} finally {
  server.close();
}

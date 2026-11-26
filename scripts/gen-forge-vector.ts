/**
 * Generate a cross-language test vector for Foundry: run the full SDK flow (merchant 402 →
 * AP2 open mandates → agent closed mandates → EIP-3009 signature bound to the payment mandate)
 * and write the resulting on-chain call parameters to contracts/test/fixtures/sdk-vector.json.
 *
 * contracts/test/SdkVector.t.sol then checks, in Solidity, that
 *   keccak256(paymentMandate) == authorization.nonce   and that
 *   MockUSDC.transferWithAuthorization accepts the SDK's signature.
 *
 * Run: npm run forge:vector
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSignature } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Ap2X402Client,
  Ap2X402Merchant,
  HEADER_PAYMENT_SIGNATURE,
  LocalFacilitator,
  createOpenCheckoutMandate,
  createOpenPaymentMandate,
  decodePaymentPayload,
  generateKeyPairJwk,
  getPaymentInfo,
  type AssetInfo,
} from "../src/index.js";

/** Address of the first contract deployed by anvil's default account 0 on a fresh chain. */
const TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ASSET: AssetInfo = {
  network: "eip155:31337",
  address: TOKEN,
  symbol: "USDC",
  decimals: 6,
  currency: "USD",
  currencyExponent: 2,
  eip712: { name: "USDC", version: "2" },
};

const merchantInfo = { id: "shop.example", name: "Example Shop", website: "https://shop.example" };
const user = await generateKeyPairJwk();
const agent = await generateKeyPairJwk();
const merchantKey = await generateKeyPairJwk();
const wallet = privateKeyToAccount(generatePrivateKey());
const payTo = privateKeyToAccount(generatePrivateKey()).address;

const merchant = new Ap2X402Merchant({
  merchant: merchantInfo,
  signingKey: merchantKey.privateJwk,
  payTo,
  asset: ASSET,
  facilitator: new LocalFacilitator(),
  resolveUserKey: () => user.publicJwk,
});
const handler = merchant.protect(() => new Response("ok"), {
  cart: () => ({ line_items: [{ id: "forecast-7d", title: "7-day forecast", quantity: 1, unit_price: 25 }] }),
});

let header = "";
const client = new Ap2X402Client({
  wallet,
  mode: {
    kind: "human_not_present",
    agentKey: agent.privateJwk,
    userPublicKey: user.publicJwk,
    openCheckoutMandate: await createOpenCheckoutMandate(
      user.privateJwk,
      [{ type: "checkout.line_items", items: [{ id: "i", acceptable_items: [{ id: "forecast-7d", title: "7-day forecast" }], quantity: 1 }] }],
      { issuer: "user:alice", agentPublicJwk: agent.publicJwk },
    ),
    openPaymentMandate: await createOpenPaymentMandate(user.privateJwk, [{ type: "payment.amount_range", currency: "USD", max: 100 }], {
      issuer: "user:alice",
      agentPublicJwk: agent.publicJwk,
    }),
  },
  fetch: async (input, init) => {
    header = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE) ?? header;
    return handler(new Request(input as string, init));
  },
});

const res = await client.fetch("https://shop.example/api/forecast");
if (res.status !== 200) throw new Error(`SDK flow failed: ${res.status}`);

const payload = decodePaymentPayload(header);
const a = payload.payload.authorization;
const sig = parseSignature(payload.payload.signature);
const vector = {
  chainId: 31337,
  token: TOKEN,
  from: a.from,
  to: a.to,
  value: a.value,
  validAfter: a.validAfter,
  validBefore: a.validBefore,
  nonce: a.nonce,
  signature: payload.payload.signature,
  v: Number(sig.v ?? BigInt(sig.yParity + 27)),
  r: sig.r,
  s: sig.s,
  paymentMandate: getPaymentInfo(payload)!.paymentMandate,
};

const out = fileURLToPath(new URL("../contracts/test/fixtures/sdk-vector.json", import.meta.url));
writeFileSync(out, JSON.stringify(vector, null, 2) + "\n");
console.log(`wrote ${out}\n  from ${a.from} → ${a.to}  value ${a.value}  nonce ${a.nonce}`);

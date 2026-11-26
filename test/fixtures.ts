import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Ap2X402Client,
  Ap2X402Merchant,
  LocalFacilitator,
  USDC_BASE_SEPOLIA,
  createOpenCheckoutMandate,
  createOpenPaymentMandate,
  generateKeyPairJwk,
  type CartInput,
  type CheckoutConstraint,
  type ClientConfig,
  type PaymentConstraint,
} from "../src/index.js";

export const MERCHANT = { id: "shop.example", name: "Example Shop", website: "https://shop.example" };
export const USER_ID = "user:alice";
export const REPORT: CartInput = { line_items: [{ id: "sku-report", title: "Market report", quantity: 1, unit_price: 500 }] };

export async function setup(opts: { checkout?: CheckoutConstraint[]; payment?: PaymentConstraint[]; cart?: CartInput } = {}) {
  const user = await generateKeyPairJwk();
  const agent = await generateKeyPairJwk();
  const merchantKey = await generateKeyPairJwk();
  const wallet = privateKeyToAccount(generatePrivateKey());
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const facilitator = new LocalFacilitator();

  const merchant = new Ap2X402Merchant({
    merchant: MERCHANT,
    signingKey: merchantKey.privateJwk,
    payTo,
    asset: USDC_BASE_SEPOLIA,
    facilitator,
    resolveUserKey: (iss) => (iss === USER_ID ? user.publicJwk : null),
  });

  const handler = merchant.protect(
    (_req, payment) => Response.json({ content: "premium", payer: payment.payer, mode: payment.mandates.mode }),
    { cart: () => opts.cart ?? REPORT, description: "Premium market report" },
  );
  const inProcessFetch = ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;

  const checkoutConstraints: CheckoutConstraint[] = opts.checkout ?? [
    { type: "checkout.allowed_merchants", allowed: [MERCHANT] },
    {
      type: "checkout.line_items",
      items: [{ id: "req-1", acceptable_items: [{ id: "sku-report", title: "Market report" }], quantity: 1 }],
    },
  ];
  const paymentConstraints: PaymentConstraint[] = opts.payment ?? [
    { type: "payment.amount_range", currency: "USD", max: 1000 },
    { type: "payment.allowed_payees", allowed: [MERCHANT] },
  ];
  const openCheckoutMandate = await createOpenCheckoutMandate(user.privateJwk, checkoutConstraints, {
    issuer: USER_ID,
    agentPublicJwk: agent.publicJwk,
  });
  const openPaymentMandate = await createOpenPaymentMandate(user.privateJwk, paymentConstraints, {
    issuer: USER_ID,
    agentPublicJwk: agent.publicJwk,
  });

  const makeClient = (over: Partial<ClientConfig> = {}) =>
    new Ap2X402Client({
      wallet,
      fetch: inProcessFetch,
      mode: {
        kind: "human_not_present",
        agentKey: agent.privateJwk,
        userPublicKey: user.publicJwk,
        openCheckoutMandate,
        openPaymentMandate,
      },
      ...over,
    });

  return { user, agent, merchantKey, wallet, payTo, facilitator, merchant, handler, inProcessFetch, openCheckoutMandate, openPaymentMandate, makeClient };
}

export const URL_REPORT = "https://shop.example/reports/today";

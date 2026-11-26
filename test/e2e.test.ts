import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AP2_EXTENSION,
  Ap2X402Error,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  X402_INSTRUMENT_TYPE,
  X402_VERSION,
  buildCheckoutMandate,
  buildPaymentMandate,
  createOpenPaymentMandate,
  decodePaymentRequired,
  encodePaymentPayload,
  getRequiredInfo,
  mandateBindingNonce,
  presentUnderOpenMandate,
  signExactEvm,
  verifyCheckoutJwt,
  x402InstrumentId,
  type Checkout,
  type Merchant,
  type PaymentConstraint,
} from "../src/index.js";
import { MERCHANT, REPORT, URL_REPORT, USER_ID, setup } from "./fixtures.js";

type Env = Awaited<ReturnType<typeof setup>>;

/** Hand-craft a payment, bypassing the client's own safety checks (simulates a buggy / malicious agent). */
async function craft(
  env: Env,
  over: {
    url?: string;
    openPaymentMandate?: string;
    amount?: number;
    nonce?: `0x${string}`;
    payee?: Merchant;
  } = {},
) {
  const url = over.url ?? URL_REPORT;
  const res = await env.inProcessFetch(url);
  const pr = decodePaymentRequired(res.headers.get(HEADER_PAYMENT_REQUIRED)!);
  const info = getRequiredInfo(pr)!;
  const checkout: Checkout = await verifyCheckoutJwt(info.checkoutJwt, env.merchantKey.publicJwk);
  const req = checkout.payment_requirements!;
  const instrument = { id: x402InstrumentId(req.network, env.wallet.address), type: X402_INSTRUMENT_TYPE };
  const pm = buildPaymentMandate(info.checkoutJwt, checkout, instrument);
  if (over.amount !== undefined) pm.payment_amount = { amount: over.amount, currency: "USD" };
  if (over.payee) pm.payee = over.payee;
  const present = { aud: MERCHANT.id, nonce: checkout.nonce };
  const checkoutMandate = await presentUnderOpenMandate(env.openCheckoutMandate, buildCheckoutMandate(info.checkoutJwt, checkout), env.agent.privateJwk, present);
  const paymentMandate = await presentUnderOpenMandate(over.openPaymentMandate ?? env.openPaymentMandate, pm, env.agent.privateJwk, present);
  const evm = await signExactEvm(env.wallet, req, { nonce: over.nonce ?? mandateBindingNonce(paymentMandate) });
  const header = encodePaymentPayload({
    x402Version: X402_VERSION,
    accepted: req,
    payload: evm,
    extensions: { [AP2_EXTENSION]: { info: { ...info, checkoutMandate, paymentMandate } } },
  });
  return { header, checkout };
}

async function send(env: Env, header: string, url = URL_REPORT) {
  const res = await env.inProcessFetch(url, { headers: { [HEADER_PAYMENT_SIGNATURE]: header } });
  return { status: res.status, body: (await res.json()) as { error?: string; content?: string } };
}

describe("human-not-present (agent within open mandates)", () => {
  it("pays and unlocks the resource", async () => {
    const env = await setup();
    const { response, payment } = await env.makeClient().pay(URL_REPORT);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "premium", mode: "human_not_present", payer: env.wallet.address });
    expect(payment?.settlement).toMatchObject({ success: true, network: "eip155:84532", amount: "5000000" });
    expect(payment?.checkout.total).toEqual({ amount: 500, currency: "USD" });
  });

  it("enforces payment.budget across purchases via the spend ledger", async () => {
    const env = await setup({
      payment: [
        { type: "payment.amount_range", currency: "USD", max: 1000 },
        { type: "payment.budget", currency: "USD", max: 800 },
      ],
    });
    const client = env.makeClient();
    expect((await client.fetch(URL_REPORT)).status).toBe(200);
    await expect(client.fetch(URL_REPORT)).rejects.toMatchObject({ code: "constraint_violation" });
  });

  it("enforces payment.agent_recurrence max_occurrences", async () => {
    const env = await setup({
      payment: [
        { type: "payment.amount_range", currency: "USD", max: 1000 },
        { type: "payment.agent_recurrence", frequency: "ON_DEMAND", max_occurrences: 1 },
      ],
    });
    const client = env.makeClient();
    expect((await client.fetch(URL_REPORT)).status).toBe(200);
    await expect(client.fetch(URL_REPORT)).rejects.toMatchObject({ code: "constraint_violation" });
  });

  it("agent refuses to exceed the user's amount limit", async () => {
    const env = await setup({ payment: [{ type: "payment.amount_range", currency: "USD", max: 100 }] });
    await expect(env.makeClient().fetch(URL_REPORT)).rejects.toMatchObject({ code: "constraint_violation" });
  });

  it("agent refuses items outside the line_items constraint", async () => {
    const env = await setup({ cart: { line_items: [{ id: "sku-other", title: "Other", quantity: 1, unit_price: 100 }] } });
    await expect(env.makeClient().fetch(URL_REPORT)).rejects.toMatchObject({ code: "constraint_violation" });
  });

  it("agent refuses a merchant whose key is not anchored to the request origin", async () => {
    const env = await setup();
    await expect(env.makeClient().fetch("https://evil.example/reports/today")).rejects.toMatchObject({ code: "merchant_untrusted" });
  });
});

describe("human-present (user signs closed mandates)", () => {
  it("pays after user confirmation", async () => {
    const env = await setup();
    let shown: Checkout | undefined;
    const client = env.makeClient({
      mode: { kind: "human_present", userId: USER_ID, userKey: env.user.privateJwk, confirm: (c) => ((shown = c), true) },
    });
    const res = await client.fetch(URL_REPORT);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "human_present" });
    expect(shown?.line_items[0]?.id).toBe("sku-report");
  });

  it("does not pay when the user declines", async () => {
    const env = await setup();
    const client = env.makeClient({
      mode: { kind: "human_present", userId: USER_ID, userKey: env.user.privateJwk, confirm: () => false },
    });
    await expect(client.fetch(URL_REPORT)).rejects.toBeInstanceOf(Ap2X402Error);
  });

  it("merchant rejects mandates from an unknown user", async () => {
    const env = await setup();
    const client = env.makeClient({
      mode: { kind: "human_present", userId: "user:mallory", userKey: env.user.privateJwk, confirm: () => true },
    });
    const res = await client.fetch(URL_REPORT);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/mandate_invalid.*untrusted root/);
  });
});

describe("merchant-side defenses against a malicious agent", () => {
  it("accepts a correctly crafted payment (control)", async () => {
    const env = await setup();
    const { header } = await craft(env);
    expect((await send(env, header)).status).toBe(200);
  });

  it("rejects constraint violations even if the agent skips its self-check", async () => {
    const env = await setup();
    const tight: PaymentConstraint[] = [{ type: "payment.amount_range", currency: "USD", max: 100 }];
    const openPaymentMandate = await createOpenPaymentMandate(env.user.privateJwk, tight, { issuer: USER_ID, agentPublicJwk: env.agent.publicJwk });
    const { header } = await craft(env, { openPaymentMandate });
    const r = await send(env, header);
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/constraint_violation.*amount_range/);
  });

  it("rejects an EIP-3009 authorization not bound to the mandate", async () => {
    const env = await setup();
    const { header } = await craft(env, { nonce: `0x${"11".repeat(32)}` });
    expect((await send(env, header)).body.error).toMatch(/binding_invalid/);
  });

  it("rejects a payment mandate whose amount differs from the checkout", async () => {
    const env = await setup();
    const { header } = await craft(env, { amount: 1 });
    expect((await send(env, header)).body.error).toMatch(/payment amount differs/);
  });

  it("rejects a payment mandate to another payee", async () => {
    const env = await setup();
    const { header } = await craft(env, { payee: { id: "other.example", name: "Other" } });
    expect((await send(env, header)).body.error).toMatch(/payee/);
  });

  it("rejects replay of a settled payment", async () => {
    const env = await setup();
    const { header } = await craft(env);
    expect((await send(env, header)).status).toBe(200);
    const again = await send(env, header);
    expect(again.status).toBe(402);
    expect(again.body.error).toMatch(/nonce_used|replay/);
  });

  it("rejects a checkout paid for one resource but presented on another", async () => {
    const env = await setup();
    const { header } = await craft(env, { url: "https://shop.example/reports/cheap" });
    expect((await send(env, header, URL_REPORT)).body.error).toMatch(/different resource/);
  });

  it("rejects an agent that is not the open mandate's cnf holder", async () => {
    const env = await setup();
    const thief = await setup(); // different agent key, same merchant shape
    const { header } = await craft({ ...env, agent: thief.agent });
    expect((await send(env, header)).body.error).toMatch(/mandate_invalid.*signature verification failed/);
  });

  it("rejects tampered accepted requirements (payTo swap)", async () => {
    const env = await setup();
    const { header } = await craft(env);
    const payload = JSON.parse(Buffer.from(header, "base64").toString());
    payload.accepted.payTo = privateKeyToAccount(generatePrivateKey()).address;
    const r = await send(env, Buffer.from(JSON.stringify(payload)).toString("base64"));
    expect(r.body.error).toMatch(/requirements_mismatch/);
  });
});

describe("402 challenge", () => {
  it("carries a signed checkout pinning the x402 requirement", async () => {
    const env = await setup();
    const res = await env.inProcessFetch(URL_REPORT);
    expect(res.status).toBe(402);
    const pr = decodePaymentRequired(res.headers.get(HEADER_PAYMENT_REQUIRED)!);
    expect(pr.x402Version).toBe(2);
    const info = getRequiredInfo(pr)!;
    const checkout = await verifyCheckoutJwt(info.checkoutJwt, env.merchantKey.publicJwk);
    expect(pr.accepts[0]).toEqual(checkout.payment_requirements);
    expect(checkout.payment_requirements).toMatchObject({ amount: "5000000", payTo: env.payTo, network: "eip155:84532" });
    expect(checkout.total.amount).toBe(REPORT.line_items[0]!.unit_price);
  });
});

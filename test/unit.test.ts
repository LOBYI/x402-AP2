import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  USDC_BASE_SEPOLIA,
  evaluateCheckoutConstraints,
  evaluatePaymentConstraints,
  generateKeyPairJwk,
  sdjwt,
  signExactEvm,
  toAtomic,
  toMinor,
  verifyExactEvm,
  type Checkout,
  type PaymentMandate,
} from "../src/index.js";

describe("sd-jwt chains", () => {
  it("issues, delegates and verifies with selective disclosure", async () => {
    const user = await generateKeyPairJwk();
    const agent = await generateKeyPairJwk();
    const root = await sdjwt.issue({ iss: "u", secret: 42, cnf: { jwk: agent.publicJwk } }, user.privateJwk, { selectivelyDisclose: ["secret"] });
    const chain = await sdjwt.delegate(root, { leaf: true }, agent.privateJwk, { aud: "m", nonce: "n" });
    const hops = await sdjwt.verifyChain(chain, { resolveRootKey: () => user.publicJwk, expectedAud: "m", expectedNonce: "n" });
    expect(hops).toHaveLength(2);
    expect(hops[0]!.claims["secret"]).toBe(42);
    expect(hops[0]!.claims["_sd"]).toBeUndefined();
    expect(hops[1]!.claims["leaf"]).toBe(true);
  });

  it("hides undisclosed claims", async () => {
    const user = await generateKeyPairJwk();
    const root = await sdjwt.issue({ iss: "u", secret: 42 }, user.privateJwk, { selectivelyDisclose: ["secret"] });
    const [jws] = root.split("~");
    const hops = await sdjwt.verifyChain(`${jws}~`, { resolveRootKey: () => user.publicJwk });
    expect(hops[0]!.claims["secret"]).toBeUndefined();
  });

  it("rejects a hop detached from its parent (sd_hash)", async () => {
    const user = await generateKeyPairJwk();
    const agent = await generateKeyPairJwk();
    const rootA = await sdjwt.issue({ iss: "u", n: 1, cnf: { jwk: agent.publicJwk } }, user.privateJwk);
    const rootB = await sdjwt.issue({ iss: "u", n: 2, cnf: { jwk: agent.publicJwk } }, user.privateJwk);
    const chainA = await sdjwt.delegate(rootA, { leaf: true }, agent.privateJwk);
    const spliced = rootB + "~" + sdjwt.splitChain(chainA)[1];
    await expect(sdjwt.verifyChain(spliced, { resolveRootKey: () => user.publicJwk })).rejects.toThrow(/sd_hash/);
  });

  it("rejects delegation from a non-delegable token and wrong aud/nonce", async () => {
    const user = await generateKeyPairJwk();
    const agent = await generateKeyPairJwk();
    const closed = await sdjwt.issue({ iss: "u" }, user.privateJwk);
    const chain = await sdjwt.delegate(closed, { x: 1 }, agent.privateJwk);
    await expect(sdjwt.verifyChain(chain, { resolveRootKey: () => user.publicJwk })).rejects.toThrow(/not delegable/);

    const open = await sdjwt.issue({ iss: "u", cnf: { jwk: agent.publicJwk } }, user.privateJwk);
    const ok = await sdjwt.delegate(open, { x: 1 }, agent.privateJwk, { aud: "m", nonce: "n" });
    await expect(sdjwt.verifyChain(ok, { resolveRootKey: () => user.publicJwk, expectedNonce: "other" })).rejects.toThrow(/nonce/);
  });

  it("rejects forged disclosures and expired tokens", async () => {
    const user = await generateKeyPairJwk();
    const root = await sdjwt.issue({ iss: "u", a: 1 }, user.privateJwk, { selectivelyDisclose: ["a"] });
    const forged = Buffer.from(JSON.stringify(["salt", "a", 999])).toString("base64url");
    const [jws] = root.split("~");
    await expect(sdjwt.verifyChain(`${jws}~${forged}~`, { resolveRootKey: () => user.publicJwk })).rejects.toThrow(/not referenced/);

    const old = await sdjwt.issue({ iss: "u", exp: 1000 }, user.privateJwk);
    await expect(sdjwt.verifyChain(old, { resolveRootKey: () => user.publicJwk })).rejects.toThrow(/expired/);
  });
});

describe("constraints", () => {
  const merchant = { id: "m", name: "M", website: "https://m.example" };
  const checkout = (items: Checkout["line_items"]): Checkout => ({
    id: "c", merchant, line_items: items, total: { amount: 0, currency: "USD" }, nonce: "n", iat: 0, exp: 0,
  });

  it("matches line items as a bipartite assignment", () => {
    const reqs = [
      { id: "r1", acceptable_items: [{ id: "a", title: "A" }, { id: "b", title: "B" }], quantity: 1 },
      { id: "r2", acceptable_items: [{ id: "a", title: "A" }], quantity: 1 },
    ];
    const c = { type: "checkout.line_items" as const, items: reqs };
    // Greedy would assign "a" to r1 and fail r2; matching must find r1→b, r2→a.
    expect(evaluateCheckoutConstraints([c], checkout([{ id: "a", title: "A", quantity: 1, unit_price: 1 }, { id: "b", title: "B", quantity: 1, unit_price: 1 }]))).toEqual([]);
    expect(evaluateCheckoutConstraints([c], checkout([{ id: "a", title: "A", quantity: 2, unit_price: 1 }, { id: "b", title: "B", quantity: 1, unit_price: 1 }]))).toHaveLength(1);
    expect(evaluateCheckoutConstraints([c], checkout([{ id: "b", title: "B", quantity: 1, unit_price: 1 }]))).toHaveLength(1);
  });

  it("pins merchant website when the constraint specifies one", () => {
    const allowed = { type: "checkout.allowed_merchants" as const, allowed: [merchant] };
    const impostor = { ...checkout([]), merchant: { ...merchant, website: "https://evil.example" } };
    expect(evaluateCheckoutConstraints([allowed], impostor)).toHaveLength(1);
  });

  it("evaluates payment constraints", () => {
    const pm: PaymentMandate = {
      vct: "mandate.payment.1", transaction_id: "tx", payee: merchant,
      payment_amount: { amount: 500, currency: "USD" }, payment_instrument: { id: "eip155:1:0xabc", type: "x402" },
    };
    expect(evaluatePaymentConstraints([{ type: "payment.amount_range", currency: "USD", max: 500, min: 100 }], pm)).toEqual([]);
    expect(evaluatePaymentConstraints([{ type: "payment.amount_range", currency: "EUR", max: 9999 }], pm)).toHaveLength(1);
    expect(evaluatePaymentConstraints([{ type: "payment.reference", conditional_transaction_id: "other" }], pm)).toHaveLength(1);
    expect(evaluatePaymentConstraints([{ type: "payment.reference", conditional_transaction_id: "oc" }], pm, { openCheckoutDigest: "oc" })).toEqual([]);
    expect(evaluatePaymentConstraints([{ type: "payment.budget", currency: "USD", max: 800 }], pm, { spent: 400 })).toHaveLength(1);
    expect(evaluatePaymentConstraints([{ type: "payment.allowed_pisps", allowed: [{ domain_name: "p" }] }], pm)).toHaveLength(1);
    expect(evaluatePaymentConstraints([{ type: "payment.execution_date", not_after: "2000-01-01T00:00:00Z" }], pm)).toHaveLength(1);
  });
});

describe("asset bridge", () => {
  it("converts USD minor units <-> USDC atomic units exactly", () => {
    expect(toAtomic({ amount: 1999, currency: "USD" }, USDC_BASE_SEPOLIA)).toBe("19990000");
    expect(toMinor("19990000", USDC_BASE_SEPOLIA)).toEqual({ amount: 1999, currency: "USD" });
    expect(() => toMinor("19990001", USDC_BASE_SEPOLIA)).toThrow();
    expect(() => toAtomic({ amount: 1, currency: "EUR" }, USDC_BASE_SEPOLIA)).toThrow();
  });
});

describe("x402 exact EVM", () => {
  const req = {
    scheme: "exact", network: "eip155:84532" as const, amount: "5000000", asset: USDC_BASE_SEPOLIA.address,
    payTo: privateKeyToAccount(generatePrivateKey()).address, maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };

  it("signs and verifies EIP-3009 authorizations", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const p = await signExactEvm(wallet, req, { nonce: `0x${"ab".repeat(32)}` });
    expect(await verifyExactEvm(p, req)).toEqual({ ok: true, payer: wallet.address });
    expect(await verifyExactEvm(p, { ...req, amount: "1" })).toMatchObject({ ok: false });
    const forged = { ...p, authorization: { ...p.authorization, value: "1", } };
    expect(await verifyExactEvm(forged, { ...req, amount: "1" })).toMatchObject({ ok: false, reason: "invalid_exact_evm_payload_signature" });
  });
});

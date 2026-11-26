/**
 * High-level AP2 mandate builders.
 *
 *   user  ──issue──▶  OpenCheckoutMandate / OpenPaymentMandate   (cnf = agent key)    human-not-present
 *   agent ──delegate▶ CheckoutMandate / PaymentMandate            (aud = merchant, nonce = challenge)
 *   user  ──issue──▶  CheckoutMandate / PaymentMandate            (directly)            human-present
 */
import { CompactSign, compactVerify, decodeProtectedHeader, importJWK, type JWK } from "jose";
import { delegate, issue, sha256b64u, toPublicJwk } from "./sdjwt.js";
import {
  VCT_CHECKOUT,
  VCT_CHECKOUT_OPEN,
  VCT_PAYMENT,
  VCT_PAYMENT_OPEN,
  type Checkout,
  type CheckoutConstraint,
  type CheckoutMandate,
  type OpenCheckoutMandate,
  type OpenPaymentMandate,
  type PaymentConstraint,
  type PaymentInstrument,
  type PaymentMandate,
  type Pisp,
} from "./types.js";

const now = () => Math.floor(Date.now() / 1000);

export interface OpenMandateOptions {
  /** User identifier; verifiers resolve the trust-anchor key from it. */
  issuer: string;
  /** Agent public key allowed to act on this mandate. */
  agentPublicJwk: JWK;
  /** Lifetime in seconds (default 24h). */
  ttlSeconds?: number;
  /** Claims to make selectively disclosable (e.g. `["constraints"]`). */
  selectivelyDisclose?: string[];
}

/** User → agent: authorize future checkouts within `constraints`. Must include a `checkout.line_items` constraint. */
export function createOpenCheckoutMandate(userPrivateJwk: JWK, constraints: CheckoutConstraint[], opts: OpenMandateOptions) {
  if (!constraints.some((c) => c.type === "checkout.line_items")) {
    throw new Error("ap2: open checkout mandate requires a checkout.line_items constraint");
  }
  const iat = now();
  const claims: OpenCheckoutMandate & { iss: string } = {
    iss: opts.issuer,
    vct: VCT_CHECKOUT_OPEN,
    constraints,
    cnf: { jwk: toPublicJwk(opts.agentPublicJwk) },
    iat,
    exp: iat + (opts.ttlSeconds ?? 86_400),
  };
  return issue(claims as unknown as Record<string, unknown>, userPrivateJwk, opts);
}

/** User → agent: authorize future payments within `constraints`. */
export function createOpenPaymentMandate(userPrivateJwk: JWK, constraints: PaymentConstraint[], opts: OpenMandateOptions) {
  const iat = now();
  const claims: OpenPaymentMandate & { iss: string } = {
    iss: opts.issuer,
    vct: VCT_PAYMENT_OPEN,
    constraints,
    cnf: { jwk: toPublicJwk(opts.agentPublicJwk) },
    iat,
    exp: iat + (opts.ttlSeconds ?? 86_400),
  };
  return issue(claims as unknown as Record<string, unknown>, userPrivateJwk, opts);
}

// ── Merchant-signed checkout JWT ────────────────────────────────────────────

export async function signCheckoutJwt(merchantPrivateJwk: JWK, checkout: Checkout): Promise<string> {
  const alg = merchantPrivateJwk.alg ?? "ES256";
  return new CompactSign(new TextEncoder().encode(JSON.stringify(checkout)))
    .setProtectedHeader({ alg, typ: "JWT", ...(merchantPrivateJwk.kid ? { kid: merchantPrivateJwk.kid } : {}) })
    .sign(await importJWK(merchantPrivateJwk, alg));
}

/** Decode a checkout JWT without verifying it (to discover merchant identity before key lookup). */
export function decodeCheckoutJwt(jwt: string): Checkout {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("ap2: malformed checkout_jwt");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Checkout;
}

export async function verifyCheckoutJwt(jwt: string, merchantPublicJwk: JWK, at: number = now()): Promise<Checkout> {
  const { alg } = decodeProtectedHeader(jwt);
  if (!alg || !["ES256", "ES384", "EdDSA"].includes(alg)) throw new Error(`ap2: disallowed checkout_jwt alg ${alg}`);
  const { payload } = await compactVerify(jwt, await importJWK(merchantPublicJwk, alg));
  const checkout = JSON.parse(new TextDecoder().decode(payload)) as Checkout;
  if (typeof checkout.exp !== "number" || checkout.exp < at) throw new Error("ap2: checkout expired");
  return checkout;
}

export const checkoutHash = (checkoutJwt: string) => sha256b64u(checkoutJwt);

// ── Closed mandates ─────────────────────────────────────────────────────────

export function buildCheckoutMandate(checkoutJwt: string, checkout: Checkout): CheckoutMandate {
  return { vct: VCT_CHECKOUT, checkout_jwt: checkoutJwt, checkout_hash: checkoutHash(checkoutJwt), iat: now(), exp: checkout.exp };
}

export function buildPaymentMandate(
  checkoutJwt: string,
  checkout: Checkout,
  instrument: PaymentInstrument,
  extra: { pisp?: Pisp; risk_data?: Record<string, unknown> } = {},
): PaymentMandate {
  return {
    vct: VCT_PAYMENT,
    transaction_id: checkoutHash(checkoutJwt),
    payee: checkout.merchant,
    payment_amount: checkout.total,
    payment_instrument: instrument,
    ...extra,
    iat: now(),
    exp: checkout.exp,
  };
}

export interface PresentOptions {
  /** Merchant id the mandate is presented to. */
  aud: string;
  /** Merchant challenge (Checkout.nonce). */
  nonce: string;
}

/** Human-not-present: agent derives a closed mandate from a user-issued open mandate. */
export function presentUnderOpenMandate(
  openMandate: string,
  closed: CheckoutMandate | PaymentMandate,
  agentPrivateJwk: JWK,
  opts: PresentOptions,
): Promise<string> {
  return delegate(openMandate, closed as unknown as Record<string, unknown>, agentPrivateJwk, opts);
}

/** Human-present: user signs the closed mandate directly on a trusted surface. */
export function signClosedMandate(
  closed: CheckoutMandate | PaymentMandate,
  userPrivateJwk: JWK,
  opts: PresentOptions & { issuer: string },
): Promise<string> {
  return issue({ iss: opts.issuer, ...closed, aud: opts.aud, nonce: opts.nonce } as Record<string, unknown>, userPrivateJwk);
}

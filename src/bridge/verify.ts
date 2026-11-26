import type { JWK, JWSHeaderParameters } from "jose";
import { evaluateCheckoutConstraints, evaluatePaymentConstraints } from "../ap2/constraints.js";
import { checkoutHash } from "../ap2/mandates.js";
import { rootDigest, verifyChain, type VerifiedHop } from "../ap2/sdjwt.js";
import {
  VCT_CHECKOUT,
  VCT_CHECKOUT_OPEN,
  VCT_PAYMENT,
  VCT_PAYMENT_OPEN,
  type Checkout,
  type CheckoutMandate,
  type OpenCheckoutMandate,
  type OpenPaymentMandate,
  type PaymentMandate,
} from "../ap2/types.js";
import { Ap2X402Error } from "../errors.js";
import { isBound, X402_INSTRUMENT_TYPE, x402InstrumentId } from "./binding.js";
import type { MandateMode } from "./extension.js";

/** Resolve the trust-anchor public key of a user (root mandate issuer). Return null to reject. */
export type UserKeyResolver = (issuer: string, header: JWSHeaderParameters) => Promise<JWK | null> | JWK | null;

export interface VerifyMandatesInput {
  /** Merchant-signed checkout JWT and its already-verified payload. */
  checkoutJwt: string;
  checkout: Checkout;
  checkoutMandate: string;
  paymentMandate: string;
  /** The x402 side this mandate must be bound to. */
  x402: { network: string; payer: string; nonce: string };
  resolveUserKey: UserKeyResolver;
  modes?: MandateMode[];
  now?: number;
  /** Ledger data for `payment.budget` / `payment.agent_recurrence` (if the verifier has it). */
  spent?: number;
  occurrences?: number;
}

export interface VerifiedMandates {
  mode: MandateMode;
  /** Root issuer (user id) shared by both chains. */
  userId: string;
  checkoutMandate: CheckoutMandate;
  paymentMandate: PaymentMandate;
  openCheckoutMandate?: OpenCheckoutMandate;
  openPaymentMandate?: OpenPaymentMandate;
  /** Root digest of the open payment mandate (ledger key), when human-not-present. */
  openPaymentDigest?: string;
}

const fail = (code: ConstructorParameters<typeof Ap2X402Error>[0], msg: string, details?: unknown): never => {
  throw new Ap2X402Error(code, msg, details);
};

async function verifyPair(token: string, input: VerifyMandatesInput, aud: string): Promise<VerifiedHop[]> {
  try {
    return await verifyChain(token, {
      resolveRootKey: (claims, header) =>
        typeof claims["iss"] === "string" ? input.resolveUserKey(claims["iss"], header) : null,
      expectedAud: aud,
      expectedNonce: input.checkout.nonce,
      now: input.now,
    });
  } catch (e) {
    return fail("mandate_invalid", (e as Error).message);
  }
}

/**
 * Full AP2 ⇄ x402 verification of a mandate pair. Used by merchants, and reusable by
 * facilitators / credentials providers that want to check the AP2 side independently.
 */
export async function verifyMandates(input: VerifyMandatesInput): Promise<VerifiedMandates> {
  const { checkout, checkoutJwt } = input;
  const modes = input.modes ?? ["human_present", "human_not_present"];
  const aud = checkout.merchant.id;

  const ch = await verifyPair(input.checkoutMandate, input, aud);
  const ph = await verifyPair(input.paymentMandate, input, aud);
  if (ch.length !== ph.length || ch.length > 2) fail("mandate_invalid", "unsupported mandate chain shape");
  const mode: MandateMode = ch.length === 1 ? "human_present" : "human_not_present";
  if (!modes.includes(mode)) fail("mandate_invalid", `mandate mode ${mode} not accepted`);

  const userId = ch[0]!.claims["iss"] as string;
  if (ph[0]!.claims["iss"] !== userId) fail("mandate_invalid", "checkout and payment mandates issued by different users");

  // ── Checkout leaf ──
  const cm = ch[ch.length - 1]!.claims as unknown as CheckoutMandate;
  if (cm.vct !== VCT_CHECKOUT) fail("mandate_invalid", "checkout mandate leaf has wrong vct");
  if (cm.checkout_jwt !== checkoutJwt) fail("mandate_invalid", "checkout mandate signs a different checkout");
  const hash = checkoutHash(checkoutJwt);
  if (cm.checkout_hash !== hash) fail("mandate_invalid", "checkout_hash mismatch");

  // ── Payment leaf ──
  const pm = ph[ph.length - 1]!.claims as unknown as PaymentMandate;
  if (pm.vct !== VCT_PAYMENT) fail("mandate_invalid", "payment mandate leaf has wrong vct");
  if (pm.transaction_id !== hash) fail("mandate_invalid", "payment transaction_id does not reference the checkout");
  if (pm.payee?.id !== checkout.merchant.id) fail("mandate_invalid", "payment payee is not the checkout merchant");
  if (pm.payment_amount?.amount !== checkout.total.amount || pm.payment_amount?.currency !== checkout.total.currency) {
    fail("mandate_invalid", "payment amount differs from checkout total");
  }
  if (pm.payment_instrument?.type !== X402_INSTRUMENT_TYPE) fail("mandate_invalid", "payment instrument is not x402");
  if (pm.payment_instrument.id !== x402InstrumentId(input.x402.network, input.x402.payer)) {
    fail("binding_invalid", "payment instrument does not match the x402 payer");
  }

  // ── AP2 ⇄ x402 binding ──
  if (!isBound(input.paymentMandate, input.x402.nonce)) {
    fail("binding_invalid", "EIP-3009 nonce is not bound to the payment mandate");
  }

  const result: VerifiedMandates = { mode, userId, checkoutMandate: cm, paymentMandate: pm };

  // ── Open mandate constraints (human-not-present) ──
  if (mode === "human_not_present") {
    const oc = ch[0]!.claims as unknown as OpenCheckoutMandate;
    const op = ph[0]!.claims as unknown as OpenPaymentMandate;
    if (oc.vct !== VCT_CHECKOUT_OPEN || op.vct !== VCT_PAYMENT_OPEN) fail("mandate_invalid", "root is not an open mandate");
    if (!Array.isArray(oc.constraints) || !Array.isArray(op.constraints)) {
      fail("mandate_invalid", "open mandate constraints not disclosed");
    }
    const violations = [
      ...evaluateCheckoutConstraints(oc.constraints, checkout),
      ...evaluatePaymentConstraints(op.constraints, pm, {
        now: input.now,
        openCheckoutDigest: rootDigest(input.checkoutMandate),
        spent: input.spent,
        occurrences: input.occurrences,
      }),
    ];
    if (violations.length) fail("constraint_violation", violations.join("; "), violations);
    Object.assign(result, {
      openCheckoutMandate: oc,
      openPaymentMandate: op,
      openPaymentDigest: rootDigest(input.paymentMandate),
    });
  }
  return result;
}

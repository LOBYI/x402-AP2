import type { JWK } from "jose";
import { evaluateCheckoutConstraints, evaluatePaymentConstraints } from "../ap2/constraints.js";
import {
  buildCheckoutMandate,
  buildPaymentMandate,
  decodeCheckoutJwt,
  presentUnderOpenMandate,
  signClosedMandate,
  verifyCheckoutJwt,
} from "../ap2/mandates.js";
import { rootDigest, verifyChain } from "../ap2/sdjwt.js";
import type { Checkout, Merchant, OpenCheckoutMandate, OpenPaymentMandate, PaymentMandate } from "../ap2/types.js";
import { mandateBindingNonce, X402_INSTRUMENT_TYPE, x402InstrumentId } from "../bridge/binding.js";
import { AP2_EXTENSION, getRequiredInfo, type Ap2PaymentInfo, type Ap2RequiredInfo } from "../bridge/extension.js";
import { Ap2X402Error } from "../errors.js";
import { signExactEvm, type PaymentSigner } from "../x402/evm.js";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodePaymentRequired,
  decodePaymentResponse,
  encodePaymentPayload,
} from "../x402/headers.js";
import {
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from "../x402/types.js";
import { InMemorySpendLedger, type SpendLedger } from "./ledger.js";

/** Human-not-present: the agent acts alone within user-issued open mandates. */
export interface HumanNotPresentMode {
  kind: "human_not_present";
  /** Agent private key; its public half is the `cnf` of both open mandates. */
  agentKey: JWK;
  openCheckoutMandate: string;
  openPaymentMandate: string;
  /** User public key, used to self-check the open mandates before spending. */
  userPublicKey: JWK;
}

/** Human-present: the user reviews each checkout and signs closed mandates on a trusted surface. */
export interface HumanPresentMode {
  kind: "human_present";
  userId: string;
  userKey: JWK;
  /** Show the checkout to the user; resolve true to approve. */
  confirm: (checkout: Checkout) => Promise<boolean> | boolean;
}

export interface ClientConfig {
  wallet: PaymentSigner;
  mode: HumanNotPresentMode | HumanPresentMode;
  /**
   * Resolve the merchant's checkout-signing key. Default: accept the key offered in the 402 only
   * when the merchant's `website` has the same origin as the URL being fetched (TLS-anchored).
   */
  resolveMerchantKey?: (merchant: Merchant, offered: JWK | undefined, url: string) => Promise<JWK | null> | JWK | null;
  ledger?: SpendLedger;
  fetch?: typeof fetch;
}

export interface PaidResponse {
  response: Response;
  /** Present when a payment was made. */
  payment?: {
    checkout: Checkout;
    requirements: PaymentRequirements;
    checkoutMandate: string;
    paymentMandate: string;
    settlement?: SettlementResponse;
  };
}

const defaultMerchantKey: NonNullable<ClientConfig["resolveMerchantKey"]> = (merchant, offered, url) => {
  if (!offered || !merchant.website) return null;
  try {
    return new URL(merchant.website).origin === new URL(url).origin ? offered : null;
  } catch {
    return null;
  }
};

/** Shopping-agent SDK: a `fetch` that answers x402 402 challenges with AP2-mandated payments. */
export class Ap2X402Client {
  private readonly ledger: SpendLedger;
  private readonly doFetch: typeof fetch;

  constructor(private readonly cfg: ClientConfig) {
    this.ledger = cfg.ledger ?? new InMemorySpendLedger();
    this.doFetch = cfg.fetch ?? fetch;
  }

  /** Drop-in `fetch` replacement. */
  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    return (await this.pay(input, init)).response;
  }

  /** Like `fetch`, but also returns the checkout, mandates and settlement receipt. */
  async pay(input: string | URL, init?: RequestInit): Promise<PaidResponse> {
    const url = String(input);
    const first = await this.doFetch(url, init);
    if (first.status !== 402) return { response: first };
    const header = first.headers.get(HEADER_PAYMENT_REQUIRED);
    if (!header) return { response: first };

    const pr = decodePaymentRequired(header);
    const info = getRequiredInfo(pr);
    if (!info) throw new Ap2X402Error("payment_required_invalid", "402 does not carry an AP2 checkout");

    const checkout = await this.verifyCheckout(info, url);
    const requirements = this.pickRequirements(pr, checkout);
    const { checkoutMandate, paymentMandate, ledgerKey } = await this.buildMandates(info.checkoutJwt, checkout, requirements);

    const evm = await signExactEvm(this.cfg.wallet, requirements, { nonce: mandateBindingNonce(paymentMandate) });
    const ap2Info: Ap2PaymentInfo = { ...info, checkoutMandate, paymentMandate };
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: pr.resource,
      accepted: requirements,
      payload: evm,
      extensions: { ...pr.extensions, [AP2_EXTENSION]: { ...pr.extensions?.[AP2_EXTENSION], info: ap2Info } },
    };

    const headers = new Headers(init?.headers);
    headers.set(HEADER_PAYMENT_SIGNATURE, encodePaymentPayload(payload));
    const response = await this.doFetch(url, { ...init, headers });
    const receipt = response.headers.get(HEADER_PAYMENT_RESPONSE);
    const settlement = receipt ? decodePaymentResponse(receipt) : undefined;
    if (settlement?.success && ledgerKey) await this.ledger.record(ledgerKey, checkout.total);
    return { response, payment: { checkout, requirements, checkoutMandate, paymentMandate, settlement } };
  }

  private async verifyCheckout(info: Ap2RequiredInfo, url: string): Promise<Checkout> {
    const claimed = decodeCheckoutJwt(info.checkoutJwt);
    const key = await (this.cfg.resolveMerchantKey ?? defaultMerchantKey)(claimed.merchant, info.merchantJwk, url);
    if (!key) throw new Ap2X402Error("merchant_untrusted", `no trusted key for merchant ${claimed.merchant.id}`);
    let checkout: Checkout;
    try {
      checkout = await verifyCheckoutJwt(info.checkoutJwt, key);
    } catch (e) {
      throw new Ap2X402Error("checkout_invalid", (e as Error).message);
    }
    if (checkout.resource && new URL(checkout.resource).href !== new URL(url).href) {
      throw new Ap2X402Error("checkout_invalid", "checkout is for a different resource");
    }
    const sum = checkout.line_items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    if (sum !== checkout.total.amount) throw new Ap2X402Error("checkout_invalid", "checkout total does not add up");
    return checkout;
  }

  /** Only pay a requirement that matches what the merchant signed into the checkout. */
  private pickRequirements(pr: PaymentRequired, checkout: Checkout): PaymentRequirements {
    const signed = checkout.payment_requirements;
    if (!signed) throw new Ap2X402Error("checkout_invalid", "checkout does not pin x402 payment requirements");
    const match = pr.accepts.find(
      (r) =>
        r.scheme === signed.scheme &&
        r.network === signed.network &&
        r.amount === signed.amount &&
        r.asset.toLowerCase() === signed.asset.toLowerCase() &&
        r.payTo.toLowerCase() === signed.payTo.toLowerCase(),
    );
    if (!match) throw new Ap2X402Error("requirements_mismatch", "no offered requirement matches the signed checkout");
    return signed;
  }

  private async buildMandates(checkoutJwt: string, checkout: Checkout, req: PaymentRequirements) {
    const instrument = {
      id: x402InstrumentId(req.network, this.cfg.wallet.address),
      type: X402_INSTRUMENT_TYPE,
      description: `x402 ${req.scheme} on ${req.network}`,
    };
    const cm = buildCheckoutMandate(checkoutJwt, checkout);
    const pm = buildPaymentMandate(checkoutJwt, checkout, instrument);
    const present = { aud: checkout.merchant.id, nonce: checkout.nonce };
    const mode = this.cfg.mode;

    if (mode.kind === "human_present") {
      if (!(await mode.confirm(checkout))) throw new Ap2X402Error("user_declined", "user declined the checkout");
      return {
        checkoutMandate: await signClosedMandate(cm, mode.userKey, { ...present, issuer: mode.userId }),
        paymentMandate: await signClosedMandate(pm, mode.userKey, { ...present, issuer: mode.userId }),
        ledgerKey: undefined,
      };
    }

    // Human-not-present: enforce the user's constraints *before* spending — the merchant
    // re-checks them, but the agent must never produce a mandate that exceeds its authority.
    const ledgerKey = rootDigest(mode.openPaymentMandate);
    await this.selfCheck(mode, checkout, pm, ledgerKey);
    return {
      checkoutMandate: await presentUnderOpenMandate(mode.openCheckoutMandate, cm, mode.agentKey, present),
      paymentMandate: await presentUnderOpenMandate(mode.openPaymentMandate, pm, mode.agentKey, present),
      ledgerKey,
    };
  }

  private async selfCheck(mode: HumanNotPresentMode, checkout: Checkout, pm: PaymentMandate, ledgerKey: string) {
    const resolveRootKey = () => mode.userPublicKey;
    let oc: OpenCheckoutMandate;
    let op: OpenPaymentMandate;
    try {
      oc = (await verifyChain(mode.openCheckoutMandate, { resolveRootKey }))[0]!.claims as unknown as OpenCheckoutMandate;
      op = (await verifyChain(mode.openPaymentMandate, { resolveRootKey }))[0]!.claims as unknown as OpenPaymentMandate;
    } catch (e) {
      throw new Ap2X402Error("mandate_invalid", `open mandate unusable: ${(e as Error).message}`);
    }
    const violations = [
      ...evaluateCheckoutConstraints(oc.constraints, checkout),
      ...evaluatePaymentConstraints(op.constraints, pm, {
        openCheckoutDigest: rootDigest(mode.openCheckoutMandate),
        spent: await this.ledger.spent(ledgerKey, pm.payment_amount.currency),
        occurrences: await this.ledger.occurrences(ledgerKey),
      }),
    ];
    if (violations.length) throw new Ap2X402Error("constraint_violation", violations.join("; "), violations);
  }
}

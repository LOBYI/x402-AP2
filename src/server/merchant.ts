import { randomBytes, randomUUID } from "node:crypto";
import type { JWK } from "jose";
import { decodeCheckoutJwt, signCheckoutJwt, verifyCheckoutJwt } from "../ap2/mandates.js";
import { toPublicJwk } from "../ap2/sdjwt.js";
import type { Checkout, LineItem, Merchant } from "../ap2/types.js";
import { toAtomic, type AssetInfo } from "../bridge/assets.js";
import {
  AP2_EXTENSION,
  AP2_EXTENSION_VERSION,
  AP2_REQUIRED_SCHEMA,
  getPaymentInfo,
  type Ap2RequiredInfo,
  type MandateMode,
} from "../bridge/extension.js";
import { verifyMandates, type UserKeyResolver, type VerifiedMandates } from "../bridge/verify.js";
import { Ap2X402Error } from "../errors.js";
import type { Facilitator } from "../x402/facilitator.js";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodePaymentPayload,
  encodePaymentRequired,
  encodePaymentResponse,
} from "../x402/headers.js";
import {
  X402_VERSION,
  type ExactEvmPayload,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettlementResponse,
} from "../x402/types.js";
import { InMemoryReplayStore, type ReplayStore } from "./replay.js";

export interface MerchantConfig {
  merchant: Merchant;
  /** Private key signing checkout JWTs. */
  signingKey: JWK;
  /** Wallet receiving funds. */
  payTo: `0x${string}`;
  asset: AssetInfo;
  facilitator: Facilitator;
  /** Trust anchor: map a user id (mandate `iss`) to their public key. */
  resolveUserKey: UserKeyResolver;
  modes?: MandateMode[];
  checkoutTtlSeconds?: number;
  maxTimeoutSeconds?: number;
  replayStore?: ReplayStore;
  clock?: () => number;
  /** Observability hook for logging / metrics. Must not throw. */
  onEvent?: (event: MerchantEvent) => void;
}

export type MerchantEvent =
  | { type: "payment_required"; resource: string; checkoutId: string; amount: Checkout["total"] }
  | { type: "payment_rejected"; resource: string; code: string; message: string }
  | { type: "payment_settled"; resource: string; checkoutId: string; payer: string; amount: Checkout["total"]; mode: MandateMode; userId: string; transaction: string };

export interface CartInput {
  line_items: LineItem[];
  id?: string;
}

export interface VerifiedPayment {
  checkout: Checkout;
  checkoutJwt: string;
  requirements: PaymentRequirements;
  payload: PaymentPayload<ExactEvmPayload>;
  payer: string;
  mandates: VerifiedMandates;
}

/** Merchant-side SDK: issues AP2 checkouts inside x402 402 responses and verifies / settles payments. */
export class Ap2X402Merchant {
  private readonly replay: ReplayStore;
  private readonly now: () => number;

  constructor(private readonly cfg: MerchantConfig) {
    this.replay = cfg.replayStore ?? new InMemoryReplayStore();
    this.now = cfg.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  requirementsFor(checkoutTotal: Checkout["total"]): PaymentRequirements {
    const a = this.cfg.asset;
    return {
      scheme: "exact",
      network: a.network,
      amount: toAtomic(checkoutTotal, a),
      asset: a.address,
      payTo: this.cfg.payTo,
      maxTimeoutSeconds: this.cfg.maxTimeoutSeconds ?? 120,
      extra: { name: a.eip712.name, version: a.eip712.version },
    };
  }

  /** Build the x402 `PaymentRequired` object carrying a freshly signed AP2 checkout. */
  async createPaymentRequired(resource: ResourceInfo, cart: CartInput): Promise<PaymentRequired> {
    if (!cart.line_items.length) throw new Error("merchant: empty cart");
    const iat = this.now();
    const total = { amount: cart.line_items.reduce((s, i) => s + i.unit_price * i.quantity, 0), currency: this.cfg.asset.currency };
    const draft: Checkout = {
      id: cart.id ?? randomUUID(),
      merchant: this.cfg.merchant,
      line_items: cart.line_items,
      total,
      nonce: randomBytes(16).toString("base64url"),
      resource: resource.url,
      iat,
      exp: iat + (this.cfg.checkoutTtlSeconds ?? 300),
    };
    draft.payment_requirements = this.requirementsFor(total);
    const checkoutJwt = await signCheckoutJwt(this.cfg.signingKey, draft);
    this.cfg.onEvent?.({ type: "payment_required", resource: resource.url, checkoutId: draft.id, amount: total });
    const info: Ap2RequiredInfo = {
      version: AP2_EXTENSION_VERSION,
      merchant: this.cfg.merchant,
      checkoutJwt,
      merchantJwk: toPublicJwk(this.cfg.signingKey),
      modes: this.cfg.modes ?? ["human_present", "human_not_present"],
    };
    return {
      x402Version: X402_VERSION,
      resource,
      accepts: [draft.payment_requirements],
      extensions: { [AP2_EXTENSION]: { info, schema: AP2_REQUIRED_SCHEMA } },
    };
  }

  /**
   * Verify a `PAYMENT-SIGNATURE` header: merchant checkout signature, both AP2 mandate chains and
   * their constraints, the AP2⇄x402 nonce binding, and finally the facilitator's x402 verification.
   * Does not settle.
   */
  async verifyPayment(header: string, opts: { resourceUrl?: string } = {}): Promise<VerifiedPayment> {
    let payload: PaymentPayload<ExactEvmPayload>;
    try {
      payload = decodePaymentPayload(header) as PaymentPayload<ExactEvmPayload>;
    } catch (e) {
      throw new Ap2X402Error("x402_invalid", (e as Error).message);
    }
    if (payload?.x402Version !== X402_VERSION) throw new Ap2X402Error("x402_invalid", "unsupported x402Version");
    const info = getPaymentInfo(payload);
    if (!info) throw new Ap2X402Error("mandate_invalid", "missing ap2 extension with mandates");

    // 1. The checkout must be one we signed and still valid.
    let checkout: Checkout;
    try {
      checkout = await verifyCheckoutJwt(info.checkoutJwt, toPublicJwk(this.cfg.signingKey), this.now());
    } catch (e) {
      throw new Ap2X402Error("checkout_invalid", (e as Error).message);
    }
    if (checkout.merchant.id !== this.cfg.merchant.id) throw new Ap2X402Error("checkout_invalid", "checkout for another merchant");
    if (opts.resourceUrl && checkout.resource && !sameResource(checkout.resource, opts.resourceUrl)) {
      throw new Ap2X402Error("checkout_invalid", "checkout was issued for a different resource");
    }

    // 2. Requirements come from our own signed checkout, never from the client.
    const requirements = checkout.payment_requirements ?? this.requirementsFor(checkout.total);
    if (!sameRequirements(payload.accepted, requirements)) {
      throw new Ap2X402Error("requirements_mismatch", "accepted requirements differ from the signed checkout");
    }
    const auth = payload.payload?.authorization;
    if (!auth?.from || !auth.nonce) throw new Ap2X402Error("x402_invalid", "missing EIP-3009 authorization");

    // 3. AP2 mandates + binding.
    const mandates = await verifyMandates({
      checkoutJwt: info.checkoutJwt,
      checkout,
      checkoutMandate: info.checkoutMandate,
      paymentMandate: info.paymentMandate,
      x402: { network: requirements.network, payer: auth.from, nonce: auth.nonce },
      resolveUserKey: this.cfg.resolveUserKey,
      modes: this.cfg.modes,
      now: this.now(),
    });

    // 4. x402 verification by the facilitator.
    const canonical: PaymentPayload<ExactEvmPayload> = { ...payload, accepted: requirements };
    const v = await this.cfg.facilitator.verify(canonical, requirements);
    if (!v.isValid) throw new Ap2X402Error("x402_invalid", v.invalidReason ?? "facilitator rejected payment");

    return { checkout, checkoutJwt: info.checkoutJwt, requirements, payload: canonical, payer: auth.from, mandates };
  }

  /** Settle a verified payment exactly once per checkout. */
  async settle(p: VerifiedPayment): Promise<SettlementResponse> {
    if (!(await this.replay.claim(p.checkout.id, p.checkout.exp))) {
      throw new Ap2X402Error("replay", `checkout ${p.checkout.id} already paid`);
    }
    return this.settleClaimed(p);
  }

  /** Settle a payment whose checkout was already claimed; releases the claim on failure so the buyer can retry. */
  private async settleClaimed(p: VerifiedPayment): Promise<SettlementResponse> {
    let s: SettlementResponse;
    try {
      s = await this.cfg.facilitator.settle(p.payload, p.requirements);
    } catch (e) {
      await this.replay.release(p.checkout.id);
      throw new Ap2X402Error("settlement_failed", (e as Error).message);
    }
    if (!s.success) {
      await this.replay.release(p.checkout.id);
      throw new Ap2X402Error("settlement_failed", s.errorReason ?? "settlement failed", s);
    }
    return s;
  }

  /**
   * Wrap a Web-standard handler (`Request → Response`) behind an AP2 + x402 paywall.
   * Works with Hono, Next.js route handlers, Bun, Deno, Cloudflare Workers, and Node via `toNodeHandler`.
   *
   * Order: verify → claim checkout → run handler → settle only if the handler succeeded (< 400).
   * A failing handler never charges the buyer, and a failed settlement never releases the content.
   * The settlement receipt is returned in the `PAYMENT-RESPONSE` header.
   */
  protect(
    handler: (req: Request, payment: VerifiedPayment) => Response | Promise<Response>,
    opts: { cart: (req: Request) => CartInput | Promise<CartInput>; description?: string; mimeType?: string },
  ): (req: Request) => Promise<Response> {
    return async (incoming) => {
      // Buffer the body once and hand each consumer a fresh Request. Request.clone() tees the
      // stream, and undici cancels the original when the clone is garbage-collected — which
      // happens during slow on-chain settlement and surfaces as "Body has already been read".
      const body = incoming.body ? await incoming.arrayBuffer() : undefined;
      const fresh = () => new Request(incoming.url, { method: incoming.method, headers: incoming.headers, body, signal: incoming.signal });
      const required = async (error?: string) => {
        const pr = await this.createPaymentRequired(
          { url: incoming.url, description: opts.description, mimeType: opts.mimeType },
          await opts.cart(fresh()),
        );
        if (error) pr.error = error;
        return paymentRequiredResponse(pr);
      };
      const reject = (e: Ap2X402Error) => {
        this.cfg.onEvent?.({ type: "payment_rejected", resource: incoming.url, code: e.code, message: e.message });
        return required(e.message);
      };

      const header = incoming.headers.get(HEADER_PAYMENT_SIGNATURE);
      if (!header) return required();

      let verified: VerifiedPayment;
      try {
        verified = await this.verifyPayment(header, { resourceUrl: incoming.url });
        // The cart must still match what this request costs now.
        const expected = await opts.cart(fresh());
        if (!sameItems(verified.checkout.line_items, expected.line_items)) {
          throw new Ap2X402Error("checkout_invalid", "checkout does not match the requested resource's price");
        }
        if (!(await this.replay.claim(verified.checkout.id, verified.checkout.exp))) {
          throw new Ap2X402Error("replay", `checkout ${verified.checkout.id} already paid`);
        }
      } catch (e) {
        if (e instanceof Ap2X402Error) return reject(e);
        throw e;
      }

      let res: Response;
      try {
        res = await handler(fresh(), verified);
      } catch (e) {
        await this.replay.release(verified.checkout.id);
        throw e;
      }
      if (res.status >= 400) {
        await this.replay.release(verified.checkout.id); // not charged; buyer may retry
        return res;
      }

      let settlement: SettlementResponse;
      try {
        settlement = await this.settleClaimed(verified);
      } catch (e) {
        if (e instanceof Ap2X402Error) return reject(e);
        throw e;
      }
      this.cfg.onEvent?.({
        type: "payment_settled",
        resource: incoming.url,
        checkoutId: verified.checkout.id,
        payer: verified.payer,
        amount: verified.checkout.total,
        mode: verified.mandates.mode,
        userId: verified.mandates.userId,
        transaction: settlement.transaction,
      });
      const headers = new Headers(res.headers);
      headers.set(HEADER_PAYMENT_RESPONSE, encodePaymentResponse(settlement));
      headers.append("Access-Control-Expose-Headers", HEADER_PAYMENT_RESPONSE);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };
  }

  /** Decode the merchant identity of a checkout without verifying (diagnostics). */
  static inspectCheckout(checkoutJwt: string): Checkout {
    return decodeCheckoutJwt(checkoutJwt);
  }
}

export function paymentRequiredResponse(pr: PaymentRequired): Response {
  return new Response(JSON.stringify(pr), {
    status: 402,
    headers: {
      "content-type": "application/json",
      [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(pr),
      "Access-Control-Expose-Headers": HEADER_PAYMENT_REQUIRED,
    },
  });
}

function sameRequirements(a: PaymentRequirements | undefined, b: PaymentRequirements): boolean {
  return (
    !!a &&
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase()
  );
}

function sameResource(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return a === b;
  }
}

function sameItems(a: LineItem[], b: LineItem[]): boolean {
  const key = (l: LineItem[]) => JSON.stringify(l.map((i) => [i.id, i.quantity, i.unit_price]).sort());
  return key(a) === key(b);
}

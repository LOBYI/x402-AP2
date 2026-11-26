import type { Merchant } from "../ap2/types.js";
import type { JWK } from "jose";
import type { ExtensionEntry, PaymentPayload, PaymentRequired } from "../x402/types.js";

/** Key under which AP2 data travels in x402 `extensions`. */
export const AP2_EXTENSION = "ap2";
export const AP2_EXTENSION_VERSION = "0.2";

export type MandateMode = "human_present" | "human_not_present";

/** Sent by the merchant in `PaymentRequired.extensions.ap2.info`. */
export interface Ap2RequiredInfo {
  version: string;
  merchant: Merchant;
  /** Merchant-signed checkout JWT (AP2 `checkout_jwt`). */
  checkoutJwt: string;
  /** Merchant public key. Clients must not trust it blindly — see `resolveMerchantKey`. */
  merchantJwk?: JWK;
  modes: MandateMode[];
}

/** Added by the client in `PaymentPayload.extensions.ap2.info` (on top of the echoed required info). */
export interface Ap2PaymentInfo extends Ap2RequiredInfo {
  /** SD-JWT (chain) whose leaf is a `mandate.checkout.1`. */
  checkoutMandate: string;
  /** SD-JWT (chain) whose leaf is a `mandate.payment.1`. Its keccak256 is the EIP-3009 nonce. */
  paymentMandate: string;
}

export const AP2_REQUIRED_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["version", "merchant", "checkoutJwt", "modes"],
  properties: {
    version: { type: "string" },
    merchant: { type: "object", required: ["id", "name"] },
    checkoutJwt: { type: "string" },
    merchantJwk: { type: "object" },
    modes: { type: "array", items: { enum: ["human_present", "human_not_present"] } },
  },
} as const;

export function getRequiredInfo(pr: PaymentRequired): Ap2RequiredInfo | undefined {
  const e = pr.extensions?.[AP2_EXTENSION] as ExtensionEntry<Ap2RequiredInfo> | undefined;
  return e?.info;
}

export function getPaymentInfo(p: PaymentPayload): Ap2PaymentInfo | undefined {
  const e = p.extensions?.[AP2_EXTENSION] as ExtensionEntry<Ap2PaymentInfo> | undefined;
  const info = e?.info;
  if (!info || typeof info.checkoutMandate !== "string" || typeof info.paymentMandate !== "string" || typeof info.checkoutJwt !== "string") {
    return undefined;
  }
  return info;
}

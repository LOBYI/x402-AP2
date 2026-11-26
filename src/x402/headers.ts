import type { PaymentPayload, PaymentRequired, SettlementResponse } from "./types.js";

/** x402 v2 HTTP header names. */
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(header: string): T {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
  } catch {
    throw new Error("x402: malformed base64 JSON header");
  }
}

export const encodePaymentRequired = (v: PaymentRequired) => encodeHeader(v);
export const decodePaymentRequired = (h: string) => decodeHeader<PaymentRequired>(h);
export const encodePaymentPayload = (v: PaymentPayload) => encodeHeader(v);
export const decodePaymentPayload = (h: string) => decodeHeader<PaymentPayload>(h);
export const encodePaymentResponse = (v: SettlementResponse) => encodeHeader(v);
export const decodePaymentResponse = (h: string) => decodeHeader<SettlementResponse>(h);

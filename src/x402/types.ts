/**
 * x402 protocol v2 wire types.
 * Spec: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 */

export const X402_VERSION = 2 as const;

/** CAIP-2 network identifier, e.g. `eip155:8453` (Base) or `eip155:84532` (Base Sepolia). */
export type Caip2Network = `${string}:${string}`;

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export interface PaymentRequirements {
  scheme: "exact" | (string & {});
  network: Caip2Network;
  /** Amount in the asset's atomic units (decimal string). */
  amount: string;
  /** Token contract address (EVM) or ISO 4217 code. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** Scheme-specific data. For `exact` on EVM: EIP-712 domain `name` / `version` of the token. */
  extra?: Record<string, unknown>;
}

/** A single x402 extension entry: `{ info, schema }`. */
export interface ExtensionEntry<T = unknown> {
  info: T;
  schema?: Record<string, unknown>;
}

export type Extensions = Record<string, ExtensionEntry>;

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Extensions;
}

/** EIP-3009 `transferWithAuthorization` parameters. All numeric values are decimal strings. */
export interface Eip3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 32-byte hex nonce. In x402-ap2 this is bound to the AP2 payment mandate (see bridge/binding). */
  nonce: `0x${string}`;
}

export interface ExactEvmPayload {
  signature: `0x${string}`;
  authorization: Eip3009Authorization;
}

export interface PaymentPayload<P = ExactEvmPayload> {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: P;
  extensions?: Extensions;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extensions?: Extensions;
  extra?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** Transaction hash; empty string when nothing was broadcast. */
  transaction: string;
  network: Caip2Network;
  amount?: string;
  extensions?: Extensions;
}

export interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

/**
 * AP2 (Agent Payments Protocol) mandate types, mirroring the JSON schemas in
 * https://github.com/google-agentic-commerce/AP2/tree/main/code/sdk/schemas/ap2
 */
import type { JWK } from "jose";
import type { PaymentRequirements } from "../x402/types.js";

export const VCT_CHECKOUT = "mandate.checkout.1";
export const VCT_CHECKOUT_OPEN = "mandate.checkout.open.1";
export const VCT_PAYMENT = "mandate.payment.1";
export const VCT_PAYMENT_OPEN = "mandate.payment.open.1";

export interface Merchant {
  id: string;
  name: string;
  website?: string;
}

/** Amount in ISO 4217 minor units (e.g. 1999 + "USD" = $19.99). */
export interface Amount {
  amount: number;
  currency: string;
}

export interface PaymentInstrument {
  id: string;
  type: string;
  description?: string;
}

export interface Pisp {
  domain_name?: string;
  legal_name?: string;
  brand_name?: string;
}

/** RFC 7800 confirmation claim: the key allowed to present / extend this mandate. */
export interface Cnf {
  jwk: JWK;
}

// ── Checkout ────────────────────────────────────────────────────────────────

export interface LineItem {
  id: string;
  title: string;
  quantity: number;
  /** Unit price in minor units of `Checkout.total.currency`. */
  unit_price: number;
}

/** Merchant-signed checkout payload carried as `checkout_jwt`. */
export interface Checkout {
  id: string;
  merchant: Merchant;
  line_items: LineItem[];
  total: Amount;
  /** Challenge the agent must echo as the KB-JWT `nonce` (replay protection). */
  nonce: string;
  /** x402-ap2: URL of the resource this checkout unlocks (prevents cross-resource reuse). */
  resource?: string;
  /** x402-ap2: the exact x402 requirement the merchant will accept, signed so `payTo` is bound to the merchant. */
  payment_requirements?: PaymentRequirements;
  iat: number;
  exp: number;
}

export interface CheckoutMandate {
  vct: typeof VCT_CHECKOUT;
  checkout_jwt: string;
  /** base64url(sha-256(checkout_jwt)) */
  checkout_hash: string;
  iat?: number;
  exp?: number;
}

export interface AllowedMerchantsConstraint {
  type: "checkout.allowed_merchants";
  allowed: Merchant[];
}

export interface LineItemRequirement {
  id: string;
  acceptable_items: { id: string; title: string }[];
  quantity: number;
}

export interface LineItemsConstraint {
  type: "checkout.line_items";
  items: LineItemRequirement[];
}

export type CheckoutConstraint = AllowedMerchantsConstraint | LineItemsConstraint;

export interface OpenCheckoutMandate {
  vct: typeof VCT_CHECKOUT_OPEN;
  constraints: CheckoutConstraint[];
  cnf: Cnf;
  iat?: number;
  exp?: number;
}

// ── Payment ─────────────────────────────────────────────────────────────────

export interface PaymentMandate {
  vct: typeof VCT_PAYMENT;
  /** base64url hash of the checkout_jwt this payment settles (== CheckoutMandate.checkout_hash). */
  transaction_id: string;
  payee: Merchant;
  pisp?: Pisp;
  payment_amount: Amount;
  payment_instrument: PaymentInstrument;
  execution_date?: string;
  risk_data?: Record<string, unknown>;
  iat?: number;
  exp?: number;
}

export interface AmountRangeConstraint {
  type: "payment.amount_range";
  currency: string;
  max: number;
  min?: number;
}

export interface AllowedPayeesConstraint {
  type: "payment.allowed_payees";
  allowed: Merchant[];
}

export interface PaymentReferenceConstraint {
  type: "payment.reference";
  conditional_transaction_id: string;
}

export interface AgentRecurrenceConstraint {
  type: "payment.agent_recurrence";
  frequency: "ON_DEMAND" | "DAILY" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY";
  max_occurrences?: number;
}

export interface AllowedPaymentInstrumentsConstraint {
  type: "payment.allowed_payment_instruments";
  allowed: PaymentInstrument[];
}

export interface AllowedPispsConstraint {
  type: "payment.allowed_pisps";
  allowed: Pisp[];
}

export interface BudgetConstraint {
  type: "payment.budget";
  max: number;
  currency: string;
}

export interface ExecutionDateConstraint {
  type: "payment.execution_date";
  not_before?: string;
  not_after?: string;
}

export type PaymentConstraint =
  | AmountRangeConstraint
  | AllowedPayeesConstraint
  | PaymentReferenceConstraint
  | AgentRecurrenceConstraint
  | AllowedPaymentInstrumentsConstraint
  | AllowedPispsConstraint
  | BudgetConstraint
  | ExecutionDateConstraint;

export interface OpenPaymentMandate {
  vct: typeof VCT_PAYMENT_OPEN;
  constraints: PaymentConstraint[];
  cnf: Cnf;
  iat?: number;
  exp?: number;
}

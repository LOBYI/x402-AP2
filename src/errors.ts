export type Ap2X402ErrorCode =
  | "payment_required_invalid"
  | "checkout_invalid"
  | "merchant_untrusted"
  | "mandate_invalid"
  | "constraint_violation"
  | "binding_invalid"
  | "requirements_mismatch"
  | "x402_invalid"
  | "settlement_failed"
  | "replay"
  | "user_declined";

export class Ap2X402Error extends Error {
  constructor(
    readonly code: Ap2X402ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "Ap2X402Error";
  }
}

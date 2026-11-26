import { keccak256, toHex } from "viem";
import { verifyExactEvm } from "./evm.js";
import {
  X402_VERSION,
  type ExactEvmPayload,
  type FacilitatorRequest,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type VerifyResponse,
} from "./types.js";

/** The two facilitator operations defined by x402 (`POST /verify`, `POST /settle`). */
export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse>;
}

export interface HttpFacilitatorOptions {
  /** Base URL, e.g. `https://x402.org/facilitator`. */
  url: string;
  /** Extra headers (e.g. API key auth for hosted facilitators). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

/** Client for any spec-compliant remote facilitator (Coinbase CDP, x402.org, self-hosted). */
export class HttpFacilitator implements Facilitator {
  constructor(private readonly opts: HttpFacilitatorOptions) {}

  private async post<T>(path: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<T> {
    const body: FacilitatorRequest = { x402Version: payload.x402Version, paymentPayload: payload, paymentRequirements: requirements };
    const res = await (this.opts.fetch ?? fetch)(new URL(path, this.opts.url.endsWith("/") ? this.opts.url : this.opts.url + "/"), {
      method: "POST",
      headers: { "content-type": "application/json", ...(await this.opts.headers?.()) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`x402 facilitator ${path} failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    return this.post<VerifyResponse>("verify", payload, requirements);
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements) {
    return this.post<SettlementResponse>("settle", payload, requirements);
  }
}

/**
 * In-process facilitator for tests, demos and local development.
 * Verifies the EIP-712 signature and window off-chain, enforces nonce single-use in memory,
 * and returns a deterministic pseudo transaction hash instead of broadcasting.
 * Do not use in production: it never moves funds and never checks balances.
 */
export class LocalFacilitator implements Facilitator {
  private readonly usedNonces = new Set<string>();

  constructor(private readonly clock: () => number = () => Math.floor(Date.now() / 1000)) {}

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (payload.x402Version !== X402_VERSION) return { isValid: false, invalidReason: "invalid_x402_version" };
    if (payload.accepted.scheme !== requirements.scheme || payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: "invalid_scheme_or_network" };
    }
    const evm = payload.payload as ExactEvmPayload;
    const r = await verifyExactEvm(evm, requirements, this.clock());
    if (!r.ok) return { isValid: false, invalidReason: r.reason };
    if (this.usedNonces.has(this.nonceKey(evm, requirements))) {
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_nonce_used", payer: r.payer };
    }
    return { isValid: true, payer: r.payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse> {
    const v = await this.verify(payload, requirements);
    if (!v.isValid) {
      return { success: false, errorReason: v.invalidReason, payer: v.payer, transaction: "", network: requirements.network };
    }
    const evm = payload.payload as ExactEvmPayload;
    this.usedNonces.add(this.nonceKey(evm, requirements));
    return {
      success: true,
      payer: v.payer,
      transaction: keccak256(toHex(`${requirements.network}|${evm.authorization.from}|${evm.authorization.nonce}`)),
      network: requirements.network,
      amount: requirements.amount,
    };
  }

  // EIP-3009 nonces are scoped per (token, authorizer).
  private nonceKey(evm: ExactEvmPayload, req: PaymentRequirements) {
    return `${req.network}|${req.asset.toLowerCase()}|${evm.authorization.from.toLowerCase()}|${evm.authorization.nonce}`;
  }
}

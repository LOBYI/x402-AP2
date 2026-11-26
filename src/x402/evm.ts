import { getAddress, isAddressEqual, verifyTypedData, type Hex, type TypedDataDomain } from "viem";
import type { Caip2Network, Eip3009Authorization, ExactEvmPayload, PaymentRequirements } from "./types.js";

/**
 * Minimal wallet interface. Any viem `LocalAccount` (privateKeyToAccount, mnemonicToAccount, …)
 * satisfies it, as do remote signers (KMS, MPC, AP2 credentials provider) that implement EIP-712.
 */
export interface PaymentSigner {
  address: `0x${string}`;
  signTypedData(params: {
    domain: TypedDataDomain;
    types: typeof EIP3009_TYPES;
    primaryType: "TransferWithAuthorization";
    message: TransferWithAuthorizationMessage;
  }): Promise<Hex>;
}

export interface TransferWithAuthorizationMessage {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
}

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function chainIdFromNetwork(network: Caip2Network): number {
  const [ns, ref] = network.split(":");
  if (ns !== "eip155" || !ref || !/^\d+$/.test(ref)) {
    throw new Error(`x402: unsupported network ${network} (only eip155:* is supported)`);
  }
  return Number(ref);
}

export function eip712Domain(req: PaymentRequirements): TypedDataDomain {
  const name = req.extra?.["name"];
  const version = req.extra?.["version"];
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error("x402: exact/EVM requirements must carry extra.name and extra.version (EIP-712 domain)");
  }
  return {
    name,
    version,
    chainId: chainIdFromNetwork(req.network),
    verifyingContract: getAddress(req.asset),
  };
}

function toMessage(a: Eip3009Authorization): TransferWithAuthorizationMessage {
  return {
    from: getAddress(a.from),
    to: getAddress(a.to),
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
  };
}

export interface SignExactOptions {
  /** 32-byte nonce. x402-ap2 passes the mandate binding hash here. */
  nonce: `0x${string}`;
  /** Unix seconds; defaults to now. */
  now?: number;
}

/** Create and sign an EIP-3009 authorization satisfying `req` (scheme `exact`). */
export async function signExactEvm(
  signer: PaymentSigner,
  req: PaymentRequirements,
  opts: SignExactOptions,
): Promise<ExactEvmPayload> {
  if (req.scheme !== "exact") throw new Error(`x402: unsupported scheme ${req.scheme}`);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const authorization: Eip3009Authorization = {
    from: getAddress(signer.address),
    to: getAddress(req.payTo),
    value: req.amount,
    // Small backdating tolerates clock skew between payer and facilitator.
    validAfter: String(now - 60),
    validBefore: String(now + req.maxTimeoutSeconds),
    nonce: opts.nonce,
  };
  const signature = await signer.signTypedData({
    domain: eip712Domain(req),
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: toMessage(authorization),
  });
  return { signature, authorization };
}

export type ExactCheckResult = { ok: true; payer: `0x${string}` } | { ok: false; reason: string };

/**
 * Off-chain verification of an `exact` EVM payload against requirements:
 * signature recovery, recipient, amount, and validity window. Balance / nonce-used checks
 * need chain access and are left to the facilitator.
 */
export async function verifyExactEvm(
  payload: ExactEvmPayload,
  req: PaymentRequirements,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ExactCheckResult> {
  const a = payload.authorization;
  if (!a || typeof payload.signature !== "string") return { ok: false, reason: "invalid_payload" };
  if (!isAddressEqual(a.to, req.payTo as `0x${string}`)) return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch" };
  if (BigInt(a.value) !== BigInt(req.amount)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_value" };
  if (BigInt(a.validAfter) > BigInt(now)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_after" };
  if (BigInt(a.validBefore) <= BigInt(now)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before" };
  if (BigInt(a.validBefore) - BigInt(now) > BigInt(req.maxTimeoutSeconds) + 60n) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before" };
  }
  let valid = false;
  try {
    valid = await verifyTypedData({
      address: getAddress(a.from),
      domain: eip712Domain(req),
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: toMessage(a),
      signature: payload.signature,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "invalid_exact_evm_payload_signature" };
  return { ok: true, payer: getAddress(a.from) };
}

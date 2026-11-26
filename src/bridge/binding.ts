import { keccak256, stringToBytes } from "viem";

/**
 * Cryptographic binding between AP2 and x402: the EIP-3009 `nonce` is the keccak256 hash of the
 * exact payment mandate chain string (same construction as the AP2 x402 reference PSP).
 *
 * Consequences:
 *  - the on-chain authorization can only be settled together with *that* mandate;
 *  - a mandate cannot be replayed with a second authorization (EIP-3009 nonces are single-use);
 *  - swapping in a different mandate breaks the payer's EIP-712 signature.
 */
export function mandateBindingNonce(paymentMandateChain: string): `0x${string}` {
  return keccak256(stringToBytes(paymentMandateChain));
}

export function isBound(paymentMandateChain: string, nonce: string): boolean {
  return mandateBindingNonce(paymentMandateChain).toLowerCase() === nonce.toLowerCase();
}

/** CAIP-10 account id used as the AP2 payment instrument id for an x402 payer. */
export function x402InstrumentId(network: string, payer: string): string {
  return `${network}:${payer.toLowerCase()}`;
}

export const X402_INSTRUMENT_TYPE = "x402";

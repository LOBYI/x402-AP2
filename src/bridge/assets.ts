import type { Amount } from "../ap2/types.js";
import type { Caip2Network } from "../x402/types.js";

/**
 * Maps an on-chain x402 asset to the fiat denomination AP2 mandates are expressed in.
 * AP2 amounts are ISO 4217 minor units (USD cents); x402 amounts are token atomic units.
 */
export interface AssetInfo {
  network: Caip2Network;
  address: `0x${string}`;
  symbol: string;
  /** Token decimals (USDC = 6). */
  decimals: number;
  /** ISO 4217 currency the token is pegged to. */
  currency: string;
  /** ISO 4217 minor-unit exponent of `currency` (USD = 2). */
  currencyExponent: number;
  /** EIP-712 domain of the token contract, needed for EIP-3009 signatures. */
  eip712: { name: string; version: string };
}

export const USDC_BASE: AssetInfo = {
  network: "eip155:8453",
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  decimals: 6,
  currency: "USD",
  currencyExponent: 2,
  eip712: { name: "USD Coin", version: "2" },
};

export const USDC_BASE_SEPOLIA: AssetInfo = {
  network: "eip155:84532",
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  symbol: "USDC",
  decimals: 6,
  currency: "USD",
  currencyExponent: 2,
  eip712: { name: "USDC", version: "2" },
};

export const USDC_SEPOLIA: AssetInfo = {
  network: "eip155:11155111",
  address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  symbol: "USDC",
  decimals: 6,
  currency: "USD",
  currencyExponent: 2,
  eip712: { name: "USDC", version: "2" },
};

/** Circle USDC deployments by EVM chain id. */
export const USDC_BY_CHAIN: Record<number, AssetInfo> = {
  8453: USDC_BASE,
  84532: USDC_BASE_SEPOLIA,
  11155111: USDC_SEPOLIA,
};

/** AP2 minor units → x402 atomic units (exact; throws if the token cannot represent the amount). */
export function toAtomic(amount: Amount, asset: AssetInfo): string {
  if (amount.currency !== asset.currency) throw new Error(`bridge: ${amount.currency} cannot be paid in ${asset.symbol}`);
  if (!Number.isSafeInteger(amount.amount) || amount.amount < 0) throw new Error("bridge: amount must be a non-negative integer");
  const shift = asset.decimals - asset.currencyExponent;
  if (shift < 0) throw new Error("bridge: token has fewer decimals than currency minor units");
  return (BigInt(amount.amount) * 10n ** BigInt(shift)).toString();
}

/** x402 atomic units → AP2 minor units (throws on sub-minor-unit remainders). */
export function toMinor(atomic: string, asset: AssetInfo): Amount {
  const shift = 10n ** BigInt(asset.decimals - asset.currencyExponent);
  const v = BigInt(atomic);
  if (v % shift !== 0n) throw new Error("bridge: atomic amount is not a whole number of minor units");
  return { amount: Number(v / shift), currency: asset.currency };
}

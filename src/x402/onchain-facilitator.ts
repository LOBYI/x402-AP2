import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  parseSignature,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { chainIdFromNetwork, verifyExactEvm } from "./evm.js";
import type { Facilitator } from "./facilitator.js";
import type { ExactEvmPayload, PaymentPayload, PaymentRequirements, SettlementResponse, VerifyResponse } from "./types.js";

/** The subset of the FiatTokenV2 (USDC) ABI needed for EIP-3009 settlement. */
export const EIP3009_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  // MockUSDC custom errors (FiatToken reverts with strings, which viem decodes without ABI entries).
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "AuthorizationNotYetValid", inputs: [] },
  { type: "error", name: "AuthorizationExpired", inputs: [] },
  { type: "error", name: "AuthorizationUsedOrCanceled", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
] as const;

export interface OnchainFacilitatorOptions {
  /** Submits settlement transactions and pays gas (the payer never needs ETH). */
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  /** Blocks to wait after inclusion before reporting success (default 1). */
  confirmations?: number;
}

/**
 * Facilitator that verifies against chain state and settles by calling
 * `transferWithAuthorization` on the token contract. Works with any EIP-3009 token
 * (USDC on Base / Base Sepolia, or MockUSDC on anvil).
 */
export class OnchainFacilitator implements Facilitator {
  constructor(private readonly opts: OnchainFacilitatorOptions) {}

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    if (req.scheme !== "exact") return { isValid: false, invalidReason: "unsupported_scheme" };
    let chainId: number;
    try {
      chainId = chainIdFromNetwork(req.network);
    } catch {
      return { isValid: false, invalidReason: "invalid_network" };
    }
    if (chainId !== this.opts.walletClient.chain.id) return { isValid: false, invalidReason: "invalid_network" };

    const evm = payload.payload as ExactEvmPayload;
    // The settling tx lands in the *next* block, whose timestamp is >= both the latest block and
    // (on dev chains that mine on demand, where the latest block may be stale) the wall clock.
    const block = await this.opts.publicClient.getBlock();
    const now = Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000));
    const off = await verifyExactEvm(evm, req, now);
    if (!off.ok) return { isValid: false, invalidReason: off.reason };

    const a = evm.authorization;
    const token = getAddress(req.asset);
    const [used, balance] = await Promise.all([
      this.opts.publicClient.readContract({ address: token, abi: EIP3009_ABI, functionName: "authorizationState", args: [getAddress(a.from), a.nonce] }),
      this.opts.publicClient.readContract({ address: token, abi: EIP3009_ABI, functionName: "balanceOf", args: [getAddress(a.from)] }),
    ]);
    if (used) return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_nonce_used", payer: off.payer };
    if (balance < BigInt(a.value)) return { isValid: false, invalidReason: "insufficient_funds", payer: off.payer };

    try {
      await this.opts.publicClient.simulateContract({ ...this.call(evm, token), account: this.opts.walletClient.account, blockTag: "pending" });
    } catch (e) {
      return { isValid: false, invalidReason: `simulation_failed: ${revertName(e)}`, payer: off.payer };
    }
    return { isValid: true, payer: off.payer };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettlementResponse> {
    const v = await this.verify(payload, req);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, payer: v.payer, transaction: "", network: req.network };

    const evm = payload.payload as ExactEvmPayload;
    let hash: `0x${string}`;
    try {
      hash = await this.opts.walletClient.writeContract({ ...this.call(evm, getAddress(req.asset)), account: this.opts.walletClient.account, chain: this.opts.walletClient.chain });
    } catch (e) {
      return { success: false, errorReason: `submit_failed: ${revertName(e)}`, payer: v.payer, transaction: "", network: req.network };
    }
    const receipt = await this.opts.publicClient.waitForTransactionReceipt({ hash, confirmations: this.opts.confirmations ?? 1 });
    if (receipt.status !== "success") {
      return { success: false, errorReason: "transaction_reverted", payer: v.payer, transaction: hash, network: req.network };
    }
    return { success: true, payer: v.payer, transaction: hash, network: req.network, amount: req.amount };
  }

  private call(evm: ExactEvmPayload, token: `0x${string}`) {
    const a = evm.authorization;
    const sig = parseSignature(evm.signature);
    const v = Number(sig.v ?? BigInt(sig.yParity + 27));
    return {
      address: token,
      abi: EIP3009_ABI,
      functionName: "transferWithAuthorization" as const,
      args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, sig.r, sig.s] as const,
    };
  }
}

function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? "reverted";
    return e.shortMessage;
  }
  return (e as Error).message;
}

/**
 * Prepare a local anvil chain for the demo server's on-chain mode:
 * deploys MockUSDC (Foundry artifact) and funds a fresh payer wallet with USDC (and no ETH).
 *
 *   anvil                                  # terminal 1
 *   npm run demo:anvil-setup               # terminal 2 → prints env for server / client
 *
 * Env: RPC_URL (http://127.0.0.1:8545)  DEPLOYER_KEY (anvil account #0)  FUND (USDC, default 100)
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const DEPLOYER_KEY = (process.env.DEPLOYER_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const FUND = process.env.FUND ?? "100";
const ARTIFACT = fileURLToPath(new URL("../contracts/out/MockUSDC.sol/MockUSDC.json", import.meta.url));

if (!existsSync(ARTIFACT)) throw new Error("contract artifact missing — run `cd contracts && forge build` first");
const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: readonly unknown[]; bytecode: { object: Hex } };

const probe = createPublicClient({ transport: http(RPC_URL) });
const chainId = await probe.getChainId().catch(() => {
  throw new Error(`no RPC at ${RPC_URL} — start anvil first`);
});
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const deployer = createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(DEPLOYER_KEY) });

const deployHash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
const token = (await publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;

const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
const mintHash = await deployer.writeContract({ address: token, abi: artifact.abi, functionName: "mint", args: [payer.address, parseUnits(FUND, 6)] });
await publicClient.waitForTransactionReceipt({ hash: mintHash });

console.log(`
  MockUSDC deployed   ${token}   (chain ${chainId}, EIP-712 domain "USDC" v2)
  payer funded        ${payer.address}   ${FUND} USDC, 0 ETH

  # terminal: server (on-chain facilitator, gas paid by anvil account #0)
  RPC_URL=${RPC_URL} USDC_ADDRESS=${token} npm run demo:server

  # terminal: client
  PAYER_KEY=${payerKey} npm run demo:client

  # inspect
  cast call ${token} "balanceOf(address)(uint256)" ${payer.address} --rpc-url ${RPC_URL}
`);

/**
 * Pre-flight check for a live testnet run. Reads .env, prints addresses and balances,
 * and verifies the token's on-chain EIP-712 domain matches what the SDK will sign.
 * Prints addresses only — never private keys.
 *
 * Run: npm run testnet:check
 */
import { createPublicClient, formatEther, formatUnits, hashDomain, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_BY_CHAIN } from "../src/index.js";

const ok = (b: boolean) => (b ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m");
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("RPC_URL missing — copy .env.example to .env");

const keyOf = (name: string): Hex | undefined => {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} is not a 32-byte hex private key`);
  return v as Hex;
};

const client = createPublicClient({ transport: http(RPC_URL) });
const chainId = await client.getChainId();
const preset = USDC_BY_CHAIN[chainId];
const token = (process.env.USDC_ADDRESS ?? preset?.address) as Hex | undefined;
if (!token) throw new Error(`no USDC preset for chain ${chainId}; set USDC_ADDRESS`);

const abi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function balanceOf(address) view returns (uint256)",
]);
const read = <T>(functionName: "name" | "version" | "decimals" | "DOMAIN_SEPARATOR") =>
  client.readContract({ address: token, abi, functionName }) as Promise<T>;
const [name, version, decimals, onchainDomain] = await Promise.all([read<string>("name"), read<string>("version"), read<number>("decimals"), read<Hex>("DOMAIN_SEPARATOR")]);
const expectedName = process.env.USDC_EIP712_NAME ?? preset?.eip712.name ?? "USDC";
const computed = hashDomain({
  domain: { name: expectedName, version: "2", chainId: BigInt(chainId), verifyingContract: token },
  types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
});

console.log(`\nchain        ${chainId}  via ${new URL(RPC_URL).host}`);
console.log(`token        ${token}  name="${name}" version="${version}" decimals=${decimals}`);
console.log(`${ok(computed === onchainDomain)} EIP-712 domain matches SDK ("${expectedName}", "2")`);

let ready = computed === onchainDomain;
const usdc = async (a: Hex) => formatUnits(await client.readContract({ address: token, abi, functionName: "balanceOf", args: [a] }), 6);

const fk = keyOf("FACILITATOR_PRIVATE_KEY");
if (fk) {
  const a = privateKeyToAccount(fk).address;
  const eth = await client.getBalance({ address: a });
  const gasPrice = await client.getGasPrice();
  const perSettle = gasPrice * 90_000n;
  console.log(`${ok(eth > perSettle * 3n)} facilitator  ${a}  ETH=${formatEther(eth)}  (~${formatEther(perSettle)} ETH per settlement)`);
  ready &&= eth > perSettle * 3n;
} else {
  console.log(`${ok(false)} facilitator  FACILITATOR_PRIVATE_KEY not set in .env`);
  ready = false;
}

const pk = keyOf("PAYER_KEY");
if (pk) {
  const a = privateKeyToAccount(pk).address;
  const bal = await usdc(a);
  const eth = await client.getBalance({ address: a });
  console.log(`${ok(Number(bal) >= 0.5)} payer        ${a}  USDC=${bal}  ETH=${formatEther(eth)}  (needs ≥ 0.5 USDC, no ETH)`);
  ready &&= Number(bal) >= 0.5;
} else {
  console.log(`${ok(false)} payer        PAYER_KEY not set — run npm run testnet:wallet`);
  ready = false;
}

const payTo = (process.env.PAY_TO ?? (fk ? privateKeyToAccount(fk).address : undefined)) as Hex | undefined;
if (payTo) console.log(`  payTo        ${payTo}  USDC=${await usdc(payTo)}${process.env.PAY_TO ? "" : "  (facilitator address)"}`);

console.log(ready ? "\n\x1b[32mready\x1b[0m → npm run testnet:server  (then npm run testnet:client in another terminal)\n" : "\nnot ready yet — fix the ✘ items above\n");
process.exit(ready ? 0 : 1);

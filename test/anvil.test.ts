/**
 * On-chain integration test: spawns anvil, deploys MockUSDC (Foundry artifact), and runs the
 * full AP2 + x402 flow with OnchainFacilitator calling transferWithAuthorization for real.
 * Skipped when anvil is not installed. Run via `npm run test:anvil` (builds contracts first).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Ap2X402Client,
  Ap2X402Merchant,
  EIP3009_ABI,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  OnchainFacilitator,
  createOpenCheckoutMandate,
  createOpenPaymentMandate,
  decodePaymentPayload,
  decodePaymentRequired,
  generateKeyPairJwk,
  getPaymentInfo,
  mandateBindingNonce,
  type AssetInfo,
} from "../src/index.js";

const ROOT = join(import.meta.dirname, "..");
const ANVIL = [join(homedir(), ".foundry/bin/anvil"), "anvil"].find((p) => spawnSync(p, ["--version"]).status === 0);
const ARTIFACT = join(ROOT, "contracts/out/MockUSDC.sol/MockUSDC.json");
/** anvil default account #0 (deployer + facilitator gas payer). */
const ANVIL_KEY_0: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const AUTH_USED_EVENT = [
  {
    type: "event",
    name: "AuthorizationUsed",
    inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce", type: "bytes32", indexed: true },
    ],
  },
] as const;

describe.skipIf(!ANVIL)("on-chain settlement on anvil (Foundry)", () => {
  let anvil: ChildProcess;
  let publicClient: PublicClient;
  let token: `0x${string}`;
  let facilitator: OnchainFacilitator;
  const deployer = privateKeyToAccount(ANVIL_KEY_0);
  const merchantWallet = privateKeyToAccount(generatePrivateKey()).address;

  beforeAll(async () => {
    if (!existsSync(ARTIFACT)) {
      const forge = ANVIL!.replace(/anvil$/, "forge");
      const r = spawnSync(forge, ["build"], { cwd: join(ROOT, "contracts"), stdio: "inherit" });
      if (r.status !== 0) throw new Error("forge build failed");
    }
    const port = 20000 + Math.floor(Math.random() * 20000);
    anvil = spawn(ANVIL!, ["--port", String(port), "--silent"], { stdio: "ignore" });
    const rpc = `http://127.0.0.1:${port}`;
    publicClient = createPublicClient({ chain: foundry, transport: http(rpc) });
    for (let i = 0; ; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch {
        if (i > 50) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const walletClient = createWalletClient({ chain: foundry, transport: http(rpc), account: deployer });
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
    const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
    token = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    facilitator = new OnchainFacilitator({ walletClient, publicClient });

    // expose for helpers
    mint = async (to, amount) => {
      const h = await walletClient.writeContract({
        address: token,
        abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [] }],
        functionName: "mint",
        args: [to, amount],
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
    };
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  let mint: (to: `0x${string}`, amount: bigint) => Promise<void>;
  const balanceOf = (a: `0x${string}`) => publicClient.readContract({ address: token, abi: EIP3009_ABI, functionName: "balanceOf", args: [a] });

  /** Merchant + agent wired to the chain; the payer wallet holds USDC but no ETH. */
  async function world(opts: { fund?: bigint } = {}) {
    const asset: AssetInfo = {
      network: "eip155:31337",
      address: token,
      symbol: "USDC",
      decimals: 6,
      currency: "USD",
      currencyExponent: 2,
      eip712: { name: "USDC", version: "2" },
    };
    const user = await generateKeyPairJwk();
    const agent = await generateKeyPairJwk();
    const merchantKey = await generateKeyPairJwk();
    const payer = privateKeyToAccount(generatePrivateKey());
    if (opts.fund !== 0n) await mint(payer.address, opts.fund ?? 10_000_000n);

    const merchantInfo = { id: "shop.example", name: "Example Shop", website: "https://shop.example" };
    const merchant = new Ap2X402Merchant({
      merchant: merchantInfo,
      signingKey: merchantKey.privateJwk,
      payTo: merchantWallet,
      asset,
      facilitator,
      resolveUserKey: () => user.publicJwk,
    });
    const handler = merchant.protect(() => Response.json({ ok: true }), {
      cart: () => ({ line_items: [{ id: "forecast-7d", title: "7-day forecast", quantity: 1, unit_price: 25 }] }),
    });
    const sent: string[] = [];
    const fetchImpl = (async (i: string | URL | Request, init?: RequestInit) => {
      const sig = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
      if (sig) sent.push(sig);
      return handler(new Request(i, init));
    }) as typeof fetch;
    const client = new Ap2X402Client({
      wallet: payer,
      fetch: fetchImpl,
      mode: {
        kind: "human_not_present",
        agentKey: agent.privateJwk,
        userPublicKey: user.publicJwk,
        openCheckoutMandate: await createOpenCheckoutMandate(
          user.privateJwk,
          [
            { type: "checkout.allowed_merchants", allowed: [merchantInfo] },
            { type: "checkout.line_items", items: [{ id: "i", acceptable_items: [{ id: "forecast-7d", title: "7-day forecast" }], quantity: 1 }] },
          ],
          { issuer: "user:alice", agentPublicJwk: agent.publicJwk },
        ),
        openPaymentMandate: await createOpenPaymentMandate(user.privateJwk, [{ type: "payment.amount_range", currency: "USD", max: 100 }], {
          issuer: "user:alice",
          agentPublicJwk: agent.publicJwk,
        }),
      },
    });
    return { client, payer, handler, sent, url: "https://shop.example/api/forecast" };
  }

  it("settles a mandated payment on-chain: USDC moves, payer spends no gas, nonce = keccak256(mandate)", async () => {
    const w = await world();
    const merchantBefore = await balanceOf(merchantWallet);

    const { response, payment } = await w.client.pay(w.url);
    expect(response.status).toBe(200);
    const tx = payment!.settlement!.transaction as Hex;

    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(deployer.address.toLowerCase()); // facilitator paid gas
    expect(await balanceOf(w.payer.address)).toBe(10_000_000n - 250_000n);
    expect((await balanceOf(merchantWallet)) - merchantBefore).toBe(250_000n);
    expect(await publicClient.getBalance({ address: w.payer.address })).toBe(0n); // gasless for the payer

    const [log] = parseEventLogs({ abi: AUTH_USED_EVENT, logs: receipt.logs });
    expect(log?.args.nonce).toBe(mandateBindingNonce(payment!.paymentMandate));
    const used = await publicClient.readContract({ address: token, abi: EIP3009_ABI, functionName: "authorizationState", args: [w.payer.address, log!.args.nonce] });
    expect(used).toBe(true);
  });

  it("rejects replay of a settled PAYMENT-SIGNATURE (authorization already used on-chain)", async () => {
    const w = await world();
    expect((await w.client.pay(w.url)).response.status).toBe(200);
    const before = await balanceOf(w.payer.address);

    const res = await w.handler(new Request(w.url, { headers: { [HEADER_PAYMENT_SIGNATURE]: w.sent[0]! } }));
    expect(res.status).toBe(402);
    expect(decodePaymentRequired(res.headers.get(HEADER_PAYMENT_REQUIRED)!).error).toMatch(/nonce_used|replay/);
    expect(await balanceOf(w.payer.address)).toBe(before);
  });

  it("rejects an unfunded payer before any transaction is sent", async () => {
    const w = await world({ fund: 0n });
    const blockBefore = await publicClient.getBlockNumber();
    const { response } = await w.client.pay(w.url);
    expect(response.status).toBe(402);
    expect(decodePaymentRequired(response.headers.get(HEADER_PAYMENT_REQUIRED)!).error).toMatch(/insufficient_funds/);
    expect(await publicClient.getBlockNumber()).toBe(blockBefore);
  });

  it("chain enforces single settlement even if two settles race past verification", async () => {
    const w = await world();
    // Capture a valid payment without letting the merchant settle it.
    let header = "";
    const capture = new Ap2X402Client({
      ...(w.client as unknown as { cfg: ConstructorParameters<typeof Ap2X402Client>[0] }).cfg,
      fetch: (async (i: string | URL | Request, init?: RequestInit) => {
        const sig = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
        if (sig) return (header = sig), new Response(null, { status: 499 });
        return w.handler(new Request(i, init));
      }) as typeof fetch,
    });
    await capture.pay(w.url);
    const payload = decodePaymentPayload(header);
    expect(getPaymentInfo(payload)).toBeDefined();

    const results = await Promise.all([facilitator.settle(payload, payload.accepted), facilitator.settle(payload, payload.accepted)]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(await balanceOf(w.payer.address)).toBe(10_000_000n - 250_000n);
  });

  it("rejects a payment for the wrong chain", async () => {
    const w = await world();
    let header = "";
    const capture = new Ap2X402Client({
      ...(w.client as unknown as { cfg: ConstructorParameters<typeof Ap2X402Client>[0] }).cfg,
      fetch: (async (i: string | URL | Request, init?: RequestInit) => {
        const sig = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
        if (sig) return (header = sig), new Response(null, { status: 499 });
        return w.handler(new Request(i, init));
      }) as typeof fetch,
    });
    await capture.pay(w.url);
    const payload = decodePaymentPayload(header);
    const v = await facilitator.verify(payload, { ...payload.accepted, network: "eip155:8453" });
    expect(v).toMatchObject({ isValid: false, invalidReason: "invalid_network" });
  });
});

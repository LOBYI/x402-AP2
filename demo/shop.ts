/**
 * Interactive human-present shop: pick a product, inspect the merchant-signed checkout,
 * approve or decline it yourself, and watch the x402 settlement land on-chain.
 *
 *   npm run testnet:shop          # against the running demo server, PAYER_KEY from .env
 *   npm run demo:shop             # same, without .env (random unfunded payer → good for decline tests)
 *
 * Options: --server URL (http://127.0.0.1:4020)
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Ap2X402Client,
  Ap2X402Error,
  HEADER_PAYMENT_SIGNATURE,
  decodePaymentPayload,
  generateKeyPairJwk,
  getPaymentInfo,
  type Checkout,
  type Merchant,
} from "../src/index.js";

const { values: args } = parseArgs({ options: { server: { type: "string", default: process.env.SERVER ?? "http://127.0.0.1:4020" } } });
const server = args.server.replace(/\/$/, "");

const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", mag: "\x1b[35m", off: "\x1b[0m" };
const tag = (p: "x402" | "AP2") => (p === "x402" ? `${c.cyan}[x402]${c.off}` : `${c.mag}[AP2 ]${c.off}`);
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const EXPLORERS: Record<string, string> = {
  "eip155:11155111": "https://sepolia.etherscan.io",
  "eip155:84532": "https://sepolia.basescan.org",
  "eip155:8453": "https://basescan.org",
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(q)).trim();
process.on("SIGINT", () => (rl.close(), process.exit(0)));

// ── Setup ───────────────────────────────────────────────────────────────────
const disco = (await (await fetch(`${server}/.well-known/ap2-merchant`)).json()) as { merchant: Merchant; network: string; payTo: string };
const catalog = (await (await fetch(server)).json()) as {
  products: { method: string; path: string; title: string; price: string; description: string }[];
};
const explorer = EXPLORERS[disco.network];

const userId = `user:shop-${Math.random().toString(36).slice(2, 8)}`;
const user = await generateKeyPairJwk();
const wallet = privateKeyToAccount((process.env.PAYER_KEY as `0x${string}` | undefined) ?? generatePrivateKey());
const reg = await fetch(`${server}/dev/users`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: userId, jwk: user.publicJwk }),
});
if (!reg.ok) throw new Error(`user registration failed: ${reg.status} ${await reg.text()}`);

async function balance(address: string): Promise<string> {
  const r = await fetch(`${server}/dev/balance/${address}`);
  return r.ok ? `${((await r.json()) as { usdc: string }).usdc} USDC` : "n/a (off-chain mode)";
}
async function showBalances() {
  console.log(`  payer   ${wallet.address}  ${c.bold}${await balance(wallet.address)}${c.off}`);
  console.log(`  payTo   ${disco.payTo}  ${c.bold}${await balance(disco.payTo)}${c.off}`);
}

console.log(`
${c.bold}x402-ap2 · human-present shop${c.off}
  merchant ${disco.merchant.name} (${disco.merchant.id})   network ${disco.network}
  user     ${userId}  ${c.dim}(이 세션의 사용자 키가 결제마다 mandate에 직접 서명합니다)${c.off}`);
await showBalances();

// ── Checkout approval (AP2, human present) ──────────────────────────────────
async function confirm(ch: Checkout): Promise<boolean> {
  const req = ch.payment_requirements!;
  const left = ch.exp - Math.floor(Date.now() / 1000);
  console.log(`
  ${tag("x402")} 402 Payment Required 수신
  ${tag("AP2")} 머천트 서명 검증된 checkout:
  ┌───────────────────────────────────────────────────────────────
  │ 머천트   ${ch.merchant.name}  (${ch.merchant.id})
${ch.line_items.map((i) => `  │ 품목     ${i.quantity}× ${i.title}  ${usd(i.unit_price * i.quantity)}`).join("\n")}
  │ 합계     ${c.bold}${usd(ch.total.amount)}${c.off}  ${c.dim}(AP2 ${ch.total.amount} ${ch.total.currency} minor units)${c.off}
  │ 송금     ${req.amount} atomic USDC → ${req.payTo}  ${c.dim}(x402 ${req.scheme}, ${req.network})${c.off}
  │ 만료     ${Math.floor(left / 60)}분 ${left % 60}초 후   checkout ${ch.id.slice(0, 8)}
  └───────────────────────────────────────────────────────────────`);
  const a = (await ask(`  ${c.yellow}이 결제를 승인할까요? [y/N]${c.off} `)).toLowerCase();
  const yes = a === "y" || a === "yes";
  if (yes) console.log(`  ${tag("AP2")} 사용자 키로 checkoutMandate · paymentMandate 서명`);
  return yes;
}

/** fetch that narrates the paid retry. */
const tracingFetch: typeof fetch = async (input, init) => {
  const sig = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
  if (sig) {
    const p = decodePaymentPayload(sig);
    const pm = getPaymentInfo(p)!.paymentMandate;
    console.log(`  ${tag("x402")} EIP-3009 서명  nonce ${p.payload.authorization.nonce.slice(0, 18)}… = keccak256(paymentMandate)`);
    console.log(`  ${c.dim}         paymentMandate ${pm.length} chars, PAYMENT-SIGNATURE ${sig.length} B${c.off}`);
    console.log(`  ${tag("x402")} PAYMENT-SIGNATURE 전송 → 머천트 검증 · facilitator 정산 대기 ${c.dim}(Sepolia ~12초)${c.off}`);
  }
  return fetch(input, init);
};

const client = new Ap2X402Client({
  wallet,
  fetch: tracingFetch,
  mode: { kind: "human_present", userId, userKey: user.privateJwk, confirm },
});

// ── Menu loop ───────────────────────────────────────────────────────────────
for (;;) {
  console.log(`\n${c.bold}상품${c.off}`);
  catalog.products.forEach((p, i) => console.log(`  [${i + 1}] ${p.method.padEnd(4)} ${p.path.padEnd(16)} ${p.price.padEnd(13)} ${c.dim}${p.title}${c.off}`));
  console.log(`  [b] 잔액 보기   [q] 종료`);
  const pick = (await ask("선택> ")).toLowerCase();
  if (pick === "q") break;
  if (pick === "b") {
    await showBalances();
    continue;
  }
  const product = catalog.products[Number(pick) - 1];
  if (!product) continue;

  let url = new URL(product.path, server).href;
  let init: RequestInit | undefined;
  if (product.method === "POST") {
    const text = (await ask("  번역할 문장> ")) || "hello agent payments world";
    init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) };
  } else if (product.path === "/api/forecast") {
    url += `?city=${encodeURIComponent((await ask("  도시 (Enter=Seoul)> ")) || "Seoul")}`;
  }

  console.log(`\n  ${tag("x402")} ${init?.method ?? "GET"} ${url}`);
  const started = Date.now();
  try {
    const { response, payment } = await client.pay(url, init);
    const body = await response.json().catch(() => null);
    const s = payment?.settlement;
    if (response.ok && s?.success) {
      console.log(`  ${tag("x402")} ${c.green}200 OK · 정산 완료${c.off} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      console.log(`         tx ${explorer ? `${explorer}/tx/${s.transaction}` : s.transaction}`);
      console.log(`  응답    ${JSON.stringify((body as { data?: unknown })?.data)}`);
      await showBalances();
    } else {
      console.log(`  ${c.red}HTTP ${response.status}${c.off} ${JSON.stringify((body as { error?: string })?.error ?? body)}`);
    }
  } catch (e) {
    if (e instanceof Ap2X402Error && e.code === "user_declined") console.log(`  ${c.yellow}거절함 — 서명도 송금도 하지 않았습니다.${c.off}`);
    else console.log(`  ${c.red}오류:${c.off} ${(e as Error).message}`);
  }
}
rl.close();
process.exit(0);

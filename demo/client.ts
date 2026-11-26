/**
 * x402-ap2 demo client — pays the demo server (or any x402-ap2 merchant) over real HTTP.
 *
 *   npm run demo:client                                     # GET /api/forecast, human-not-present, 3 purchases
 *   npm run demo:client -- --path /api/report               # $5 item → blocked by the $1 per-purchase limit
 *   npm run demo:client -- --path /api/translate --text "hello agent payments world"
 *   npm run demo:client -- --mode hp                        # human-present: you approve each checkout
 *   npm run demo:client -- --max 100 --budget 60 --times 3  # tune the user's constraints
 *
 * Options: --server URL (http://127.0.0.1:4020)  --path P  --mode hnp|hp  --times N  --max CENTS  --budget CENTS
 *          --text "..."  --yes (auto-approve in hp mode)  --verbose (dump raw headers)
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Ap2X402Client,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  createOpenCheckoutMandate,
  createOpenPaymentMandate,
  decodeCheckoutJwt,
  decodePaymentPayload,
  decodePaymentRequired,
  decodePaymentResponse,
  generateKeyPairJwk,
  getPaymentInfo,
  getRequiredInfo,
  sdjwt,
  type Checkout,
  type HumanNotPresentMode,
  type HumanPresentMode,
  type Merchant,
  type PaymentConstraint,
} from "../src/index.js";

const { values: args } = parseArgs({
  options: {
    server: { type: "string", default: process.env.SERVER ?? "http://127.0.0.1:4020" },
    path: { type: "string", default: "/api/forecast?city=Seoul" },
    mode: { type: "string", default: "hnp" },
    times: { type: "string", default: "3" },
    max: { type: "string", default: "100" },
    budget: { type: "string", default: "60" },
    text: { type: "string", default: "hello agent payments world" },
    yes: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

const server = args.server.replace(/\/$/, "");
const url = new URL(args.path, server).href;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const step = (n: string, msg: string) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
const kv = (k: string, v: unknown) => console.log(`    ${k.padEnd(16)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

// ── 1. Discover the merchant ────────────────────────────────────────────────
step("1", `discover merchant  GET ${server}/.well-known/ap2-merchant`);
const disco = (await (await fetch(`${server}/.well-known/ap2-merchant`)).json()) as { merchant: Merchant; network: string; payTo: string };
kv("merchant", disco.merchant);
kv("network", disco.network);
kv("payTo", disco.payTo);

// ── 2. User + agent keys; register the user as a trusted mandate issuer ────
const userId = `user:demo-${Math.random().toString(36).slice(2, 8)}`;
const user = await generateKeyPairJwk();
const agent = await generateKeyPairJwk();
const wallet = process.env.PAYER_KEY ? privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`) : privateKeyToAccount(generatePrivateKey());
step("2", `register user  POST ${server}/dev/users`);
const reg = await fetch(`${server}/dev/users`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: userId, jwk: user.publicJwk }),
});
if (!reg.ok) throw new Error(`user registration failed: ${reg.status} ${await reg.text()}`);
kv("user", userId);
kv("payer wallet", wallet.address);

// ── 3. Mandates ─────────────────────────────────────────────────────────────
const isPost = new URL(url).pathname === "/api/translate";
const catalog = (await (await fetch(server)).json()) as { products: { path: string; sku: string; title: string }[] };
const product = catalog.products.find((p) => p.path === new URL(url).pathname);
if (!product) throw new Error(`no product at ${new URL(url).pathname}; see GET ${server}/`);

let mode: HumanNotPresentMode | HumanPresentMode;
if (args.mode === "hp") {
  step("3", "human-present: you will approve each checkout; mandates are signed by the user key per purchase");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  mode = {
    kind: "human_present",
    userId,
    userKey: user.privateJwk,
    confirm: async (c: Checkout) => {
      const items = c.line_items.map((i) => `${i.quantity}× ${i.title}`).join(", ");
      if (args.yes) return console.log(`    auto-approve: ${items} — ${usd(c.total.amount)}`), true;
      const a = await rl.question(`    Pay ${usd(c.total.amount)} to ${c.merchant.name} for ${items}? [y/N] `);
      return a.trim().toLowerCase().startsWith("y");
    },
  };
  process.on("exit", () => rl.close());
} else {
  step("3", "human-not-present: user issues open mandates to the agent (cnf = agent key)");
  const paymentConstraints: PaymentConstraint[] = [
    { type: "payment.amount_range", currency: "USD", max: Number(args.max) },
    { type: "payment.budget", currency: "USD", max: Number(args.budget) },
    { type: "payment.allowed_payees", allowed: [disco.merchant] },
  ];
  const openCheckoutMandate = await createOpenCheckoutMandate(
    user.privateJwk,
    [
      { type: "checkout.allowed_merchants", allowed: [disco.merchant] },
      { type: "checkout.line_items", items: [{ id: "item", acceptable_items: [{ id: product.sku, title: product.title }], quantity: 1 }] },
    ],
    { issuer: userId, agentPublicJwk: agent.publicJwk },
  );
  const openPaymentMandate = await createOpenPaymentMandate(user.privateJwk, paymentConstraints, { issuer: userId, agentPublicJwk: agent.publicJwk });
  kv("checkout scope", `${disco.merchant.id} / ${product.sku} ×1`);
  kv("payment scope", `≤ ${usd(Number(args.max))} per purchase, ≤ ${usd(Number(args.budget))} total`);
  kv("open checkout", short(openCheckoutMandate));
  kv("open payment", short(openPaymentMandate));
  mode = { kind: "human_not_present", agentKey: agent.privateJwk, userPublicKey: user.publicJwk, openCheckoutMandate, openPaymentMandate };
}

// ── 4. Pay ──────────────────────────────────────────────────────────────────
/** fetch wrapper that narrates the x402 exchange. */
const tracingFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const sig = headers.get(HEADER_PAYMENT_SIGNATURE);
  if (sig) {
    const p = decodePaymentPayload(sig);
    const info = getPaymentInfo(p)!;
    const pm = sdjwt.splitChain(info.paymentMandate);
    console.log(`    → retry with PAYMENT-SIGNATURE (${sig.length} B)`);
    kv("EIP-3009", `${p.payload.authorization.value} atomic → ${p.payload.authorization.to}`);
    kv("nonce", `${p.payload.authorization.nonce} = keccak256(paymentMandate)`);
    kv("mandate chain", `${pm.length} hop(s): ${pm.length === 2 ? "user open mandate → agent closed mandate" : "user-signed closed mandate"}`);
    if (args.verbose) kv("raw payload", p);
  } else {
    console.log(`    → ${init?.method ?? "GET"} ${String(input)}`);
  }
  const res = await fetch(input, init);
  const pr = res.headers.get(HEADER_PAYMENT_REQUIRED);
  const receipt = res.headers.get(HEADER_PAYMENT_RESPONSE);
  console.log(`    ← HTTP ${res.status}`);
  if (pr) {
    const decoded = decodePaymentRequired(pr);
    const info = getRequiredInfo(decoded);
    if (decoded.error) kv("server error", decoded.error);
    if (info && !sig) {
      const c = decodeCheckoutJwt(info.checkoutJwt);
      kv("checkout", `${c.id.slice(0, 8)} ${c.line_items.map((i) => `${i.quantity}× ${i.title}`).join(", ")} = ${usd(c.total.amount)}`);
      kv("x402 accepts", `${decoded.accepts[0]?.amount} atomic ${decoded.accepts[0]?.network} → ${decoded.accepts[0]?.payTo}`);
    }
    if (args.verbose) kv("raw 402", decoded);
  }
  if (receipt) kv("PAYMENT-RESPONSE", decodePaymentResponse(receipt));
  return res;
};

const client = new Ap2X402Client({ wallet, mode, fetch: tracingFetch });
const init: RequestInit | undefined = isPost
  ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: args.text }) }
  : undefined;

let ok = 0;
for (let i = 1; i <= Number(args.times); i++) {
  step(`4.${i}`, `purchase ${i}/${args.times}  ${init?.method ?? "GET"} ${url}`);
  try {
    const { response } = await client.pay(url, init);
    const body = await response.json();
    kv("response", body);
    if (response.ok) ok++;
  } catch (e) {
    console.log(`    \x1b[33m✋ agent refused:\x1b[0m ${(e as Error).message}`);
  }
}

step("done", `${ok}/${args.times} purchases succeeded — see server log or GET ${server}/dev/events`);
process.exit(0);

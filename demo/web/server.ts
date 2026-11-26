/**
 * x402-ap2 web wallet — a local browser UI for paying x402-ap2 merchants.
 *
 * Keys (user mandate key, agent key, optional server payer) live only in this Node process; the browser
 * shows each protocol step and sends approve / decline decisions. The x402 payment signature can come
 * from the server payer (PAYER_KEY) or from the user's MetaMask via a remote PaymentSigner. Binds to 127.0.0.1 and requires
 * a per-launch token + same-origin requests so other websites cannot drive the wallet.
 *
 *   npm run testnet:web     # PAYER_KEY / RPC_URL from .env, merchant at http://127.0.0.1:4020
 *   npm run demo:web        # no .env: random unfunded payer (good for decline / error paths)
 *
 * Env: WALLET_PORT (4040)  MERCHANT_URL (http://127.0.0.1:4020)  PAYER_KEY  RPC_URL
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPublicClient, formatUnits, getAddress, http, parseAbi, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Ap2X402Client,
  Ap2X402Error,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  InMemorySpendLedger,
  USDC_BY_CHAIN,
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
  type PaymentSigner,
} from "../../src/index.js";

const PORT = Number(process.env.WALLET_PORT ?? 4040);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MERCHANT_URL = (process.env.MERCHANT_URL ?? "http://127.0.0.1:4020").replace(/\/$/, "");
const TOKEN = randomBytes(24).toString("base64url");

// ── Merchant discovery ──────────────────────────────────────────────────────
interface Product {
  method: string;
  path: string;
  sku: string;
  title: string;
  description: string;
  price: string;
}
const disco = (await (await fetch(`${MERCHANT_URL}/.well-known/ap2-merchant`)).json()) as { merchant: Merchant; network: string; payTo: string; asset: string };
const catalog = ((await (await fetch(MERCHANT_URL)).json()) as { products: Product[] }).products;
const chainId = Number(disco.network.split(":")[1]);
const EXPLORERS: Record<number, string> = { 11155111: "https://sepolia.etherscan.io", 84532: "https://sepolia.basescan.org", 8453: "https://basescan.org" };

// ── Keys & identity ─────────────────────────────────────────────────────────
const serverWallet = privateKeyToAccount((process.env.PAYER_KEY as `0x${string}` | undefined) ?? generatePrivateKey());
const user = await generateKeyPairJwk();
const agent = await generateKeyPairJwk();
const userId = `user:web-${randomBytes(3).toString("hex")}`;
{
  const r = await fetch(`${MERCHANT_URL}/dev/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: userId, jwk: user.publicJwk }),
  });
  if (!r.ok) throw new Error(`merchant refused user registration: ${r.status} ${await r.text()}`);
}

// ── Balances (read the chain directly when RPC_URL is set) ─────────────────
const rpc = process.env.RPC_URL ? createPublicClient({ transport: http(process.env.RPC_URL) }) : undefined;
const token = (USDC_BY_CHAIN[chainId]?.address ?? disco.asset) as `0x${string}`;
async function usdc(address: string): Promise<string | null> {
  try {
    if (rpc) {
      const v = await rpc.readContract({ address: token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [address as `0x${string}`] });
      return formatUnits(v, 6);
    }
    const r = await fetch(`${MERCHANT_URL}/dev/balance/${address}`);
    return r.ok ? ((await r.json()) as { usdc: string }).usdc : null;
  } catch {
    return null;
  }
}

// ── Mandate mode (human-present ⇄ human-not-present) ───────────────────────
interface Policy {
  kind: "human_present" | "human_not_present";
  maxPerPurchase: number; // cents
  budget: number; // cents
  allowedSkus: string[];
}
let policy: Policy = { kind: "human_present", maxPerPurchase: 100, budget: 100, allowedSkus: catalog.map((p) => p.sku) };
let ledger = new InMemorySpendLedger();
let hnp: HumanNotPresentMode | undefined;

async function issueOpenMandates() {
  const products = catalog.filter((p) => policy.allowedSkus.includes(p.sku));
  const openCheckoutMandate = await createOpenCheckoutMandate(
    user.privateJwk,
    [
      { type: "checkout.allowed_merchants", allowed: [disco.merchant] },
      { type: "checkout.line_items", items: [{ id: "any", acceptable_items: products.map((p) => ({ id: p.sku, title: p.title })), quantity: 1 }] },
    ],
    { issuer: userId, agentPublicJwk: agent.publicJwk },
  );
  const openPaymentMandate = await createOpenPaymentMandate(
    user.privateJwk,
    [
      { type: "payment.amount_range", currency: "USD", max: policy.maxPerPurchase },
      { type: "payment.budget", currency: "USD", max: policy.budget },
      { type: "payment.allowed_payees", allowed: [disco.merchant] },
    ],
    { issuer: userId, agentPublicJwk: agent.publicJwk },
  );
  ledger = new InMemorySpendLedger();
  hnp = { kind: "human_not_present", agentKey: agent.privateJwk, userPublicKey: user.publicJwk, openCheckoutMandate, openPaymentMandate };
  return { openCheckoutMandate, openPaymentMandate };
}

// ── Payment signer: server key or MetaMask (remote) ────────────────────────
type SignerMode = "server" | "metamask";
let signerMode: SignerMode = "server";
let metamaskAddress: `0x${string}` | undefined;
const pendingSignatures = new Map<string, { resolve: (sig: Hex) => void; reject: (e: Error) => void }>();
/** Purchases whose "mandates created" step was already shown (MetaMask path shows it before the signature). */
const mandateStepShown = new Set<string>();
const mandateTitle = () =>
  policy.kind === "human_not_present" ? "에이전트가 open mandate 아래 closed mandate 생성 (user → agent 위임 체인)" : "사용자 키로 closed mandate 서명";

/**
 * PaymentSigner that forwards EIP-712 requests to the browser, where MetaMask signs them
 * (eth_signTypedData_v4). The signature is checked against the expected address before use.
 */
function metamaskSigner(address: `0x${string}`, purchaseId: string): PaymentSigner {
  return {
    address,
    signTypedData: (params) =>
      new Promise<Hex>((resolve, reject) => {
        const requestId = randomUUID();
        const typedData = {
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            ...params.types,
          },
          primaryType: params.primaryType,
          domain: { ...params.domain, chainId: Number(params.domain.chainId) },
          message: Object.fromEntries(Object.entries(params.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
        };
        const timer = setTimeout(() => {
          pendingSignatures.delete(requestId);
          reject(new Error("MetaMask signature timed out"));
        }, 180_000);
        pendingSignatures.set(requestId, {
          resolve: async (sig) => {
            clearTimeout(timer);
            pendingSignatures.delete(requestId);
            const ok = await verifyTypedData({ address, ...params, signature: sig }).catch(() => false);
            if (ok) resolve(sig);
            else reject(new Error("MetaMask signature does not match the connected account / typed data"));
          },
          reject: (e) => {
            clearTimeout(timer);
            pendingSignatures.delete(requestId);
            reject(e);
          },
        });
        // The SDK builds both mandates before asking for the payment signature.
        mandateStepShown.add(purchaseId);
        emit({ purchaseId, step: 4, layer: "AP2", kind: "info", title: mandateTitle(), detail: { binding: `nonce ${String(params.message.nonce)} = keccak256(paymentMandate)` } });
        emit({
          purchaseId,
          step: 5,
          layer: "x402",
          kind: "sign_request",
          title: "MetaMask 서명 요청 — EIP-3009 TransferWithAuthorization (x402 송금 승인)",
          detail: { requestId, from: address, typedData },
        });
      }),
  };
}

function currentWallet(purchaseId: string): PaymentSigner {
  if (signerMode === "metamask") {
    if (!metamaskAddress) throw new Error("MetaMask가 연결되지 않았습니다");
    return metamaskSigner(metamaskAddress, purchaseId);
  }
  return serverWallet;
}
const payerAddress = () => (signerMode === "metamask" ? metamaskAddress : serverWallet.address);

// ── Event stream to the browser ─────────────────────────────────────────────
type Layer = "x402" | "AP2" | "x402+AP2" | "binding" | "wallet";
interface WalletEvent {
  seq?: number;
  purchaseId: string;
  step?: number;
  layer?: Layer;
  kind: "info" | "approval" | "sign_request" | "done" | "error" | "declined";
  title: string;
  detail?: unknown;
}
const listeners = new Set<ServerResponse>();
const history: WalletEvent[] = [];
let seq = 0;
function emit(e: WalletEvent) {
  e.seq = ++seq;
  history.push(e);
  if (history.length > 300) history.shift();
  const data = `data: ${JSON.stringify(e)}\n\n`;
  for (const l of listeners) l.write(data);
}

// ── Purchases ───────────────────────────────────────────────────────────────
const pendingApprovals = new Map<string, (approve: boolean) => void>();
let busy = false;

function clientFor(purchaseId: string): Ap2X402Client {
  const tracingFetch: typeof fetch = async (input, init) => {
    const sig = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
    if (sig) {
      const p = decodePaymentPayload(sig);
      const info = getPaymentInfo(p)!;
      const hops = (t: string) => sdjwt.splitChain(t).length;
      const mandates = {
        checkoutMandate: `${info.checkoutMandate.length} chars, ${hops(info.checkoutMandate)} hop(s)`,
        paymentMandate: `${info.paymentMandate.length} chars, ${hops(info.paymentMandate)} hop(s)`,
      };
      if (!mandateStepShown.delete(purchaseId)) emit({ purchaseId, step: 4, layer: "AP2", kind: "info", title: mandateTitle(), detail: mandates });
      emit({
        purchaseId,
        step: 5,
        layer: "binding",
        kind: "info",
        title: signerMode === "metamask" ? "MetaMask 서명 완료 — nonce = keccak256(paymentMandate)" : "EIP-3009 송금 서명 — nonce = keccak256(paymentMandate)",
        detail: { from: p.payload.authorization.from, to: p.payload.authorization.to, value: p.payload.authorization.value, nonce: p.payload.authorization.nonce },
      });
      emit({ purchaseId, step: 6, layer: "x402+AP2", kind: "info", title: "PAYMENT-SIGNATURE 전송 (payload: x402 · extensions.ap2: mandates)", detail: { bytes: sig.length, ...mandates } });
      emit({ purchaseId, step: 7, layer: "AP2", kind: "info", title: "머천트: mandate · 제약 · 바인딩 검증 → 핸들러 → facilitator 정산 대기…" });
    } else {
      emit({ purchaseId, step: 1, layer: "x402", kind: "info", title: `${init?.method ?? "GET"} ${String(input).replace(MERCHANT_URL, "")}` });
    }
    const res = await fetch(input, init);
    const pr = res.headers.get(HEADER_PAYMENT_REQUIRED);
    if (pr && !sig) {
      const decoded = decodePaymentRequired(pr);
      const info = getRequiredInfo(decoded);
      emit({
        purchaseId,
        step: 2,
        layer: "x402+AP2",
        kind: "info",
        title: "402 Payment Required — accepts(x402) + extensions.ap2.checkoutJwt(AP2)",
        detail: { accepts: decoded.accepts[0], ap2: info ? { merchant: info.merchant, checkout: decodeCheckoutJwt(info.checkoutJwt) } : null },
      });
      if (policy.kind === "human_not_present") {
        emit({ purchaseId, step: 3, layer: "AP2", kind: "info", title: "에이전트가 checkout을 사용자 open mandate 제약과 대조 (사용자 승인 없음)" });
      }
    }
    const receipt = res.headers.get(HEADER_PAYMENT_RESPONSE);
    if (receipt) {
      const s = decodePaymentResponse(receipt);
      emit({ purchaseId, step: 9, layer: "x402", kind: "info", title: "facilitator 온체인 정산 완료 (transferWithAuthorization)", detail: { tx: s.transaction, link: EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${s.transaction}` : undefined } });
    }
    return res;
  };

  const hp: HumanPresentMode = {
    kind: "human_present",
    userId,
    userKey: user.privateJwk,
    confirm: (checkout: Checkout) =>
      new Promise<boolean>((resolve) => {
        const left = Math.max(1, checkout.exp - Math.floor(Date.now() / 1000));
        const timer = setTimeout(() => {
          pendingApprovals.delete(purchaseId);
          resolve(false);
        }, left * 1000);
        pendingApprovals.set(purchaseId, (ok) => {
          clearTimeout(timer);
          pendingApprovals.delete(purchaseId);
          resolve(ok);
        });
        emit({
          purchaseId,
          step: 3,
          layer: "AP2",
          kind: "approval",
          title: "결제 승인 요청 — 머천트 서명이 검증된 checkout",
          detail: { checkout, expiresAt: checkout.exp },
        });
      }),
  };
  return new Ap2X402Client({ wallet: currentWallet(purchaseId), fetch: tracingFetch, ledger, mode: policy.kind === "human_present" ? hp : hnp! });
}

async function buy(purchaseId: string, product: Product, input: string) {
  let url = new URL(product.path, MERCHANT_URL).href;
  let init: RequestInit | undefined;
  if (product.method === "POST") init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: input || "hello agent payments world" }) };
  else if (input) url += `?city=${encodeURIComponent(input)}`;

  const started = Date.now();
  try {
    const { response, payment } = await clientFor(purchaseId).pay(url, init);
    const body = await response.json().catch(() => null);
    if (response.ok && payment?.settlement?.success) {
      emit({
        purchaseId,
        step: 10,
        layer: "x402",
        kind: "done",
        title: `200 OK — 리소스 수신 (${((Date.now() - started) / 1000).toFixed(1)}s)`,
        detail: { data: (body as { data?: unknown })?.data, amount: payment.checkout.total, tx: payment.settlement.transaction, link: EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${payment.settlement.transaction}` : undefined },
      });
    } else {
      emit({ purchaseId, kind: "error", title: `HTTP ${response.status}`, detail: (body as { error?: string })?.error ?? body });
    }
  } catch (e) {
    if (e instanceof Ap2X402Error && e.code === "user_declined") emit({ purchaseId, kind: "declined", title: "거절함 — 서명도 송금도 하지 않았습니다" });
    else if ((e as Error).message.startsWith("MetaMask: ")) emit({ purchaseId, kind: "declined", layer: "x402", title: "MetaMask에서 서명 거부 — 송금하지 않았습니다", detail: (e as Error).message });
    else emit({ purchaseId, kind: "error", layer: e instanceof Ap2X402Error ? "AP2" : undefined, title: e instanceof Ap2X402Error && e.code === "constraint_violation" ? "에이전트가 거부 (사용자 제약 위반)" : "오류", detail: (e as Error).message });
  } finally {
    busy = false;
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const page = () => readFileSync(new URL("./index.html", import.meta.url), "utf8").replace("__WALLET_TOKEN__", TOKEN);

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}
/** Only this page may drive the wallet: same-origin + per-launch token. */
function authorized(req: IncomingMessage, url: URL): boolean {
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN) return false;
  return req.headers["x-wallet-token"] === TOKEN || url.searchParams.get("token") === TOKEN;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      return res.end(page());
    }
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not_found" });
    if (!authorized(req, url)) return json(res, 403, { error: "forbidden" });

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      for (const e of history.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
      listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => (clearInterval(ping), listeners.delete(res)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const addr = payerAddress();
      const [payer, payTo] = await Promise.all([addr ? usdc(addr) : null, usdc(disco.payTo)]);
      return json(res, 200, {
        merchant: disco.merchant,
        merchantUrl: MERCHANT_URL,
        network: disco.network,
        explorer: EXPLORERS[chainId] ?? null,
        userId,
        payer: { address: addr ?? null, usdc: payer },
        signer: { mode: signerMode, serverAddress: serverWallet.address, metamaskAddress: metamaskAddress ?? null },
        pendingSignIds: [...pendingSignatures.keys()],
        seq,
        chainId,
        payTo: { address: disco.payTo, usdc: payTo },
        products: catalog,
        policy,
        spent: hnp ? await ledger.spent(sdjwt.rootDigest(hnp.openPaymentMandate), "USD") : 0,
        busy,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/policy") {
      const b = await readJson(req);
      if (busy) return json(res, 409, { error: "purchase in progress" });
      const kind = b.kind === "human_not_present" ? "human_not_present" : "human_present";
      const toCents = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
      policy = {
        kind,
        maxPerPurchase: toCents(b.maxPerPurchase, policy.maxPerPurchase),
        budget: toCents(b.budget, policy.budget),
        allowedSkus: Array.isArray(b.allowedSkus) ? (b.allowedSkus as string[]).filter((s) => catalog.some((p) => p.sku === s)) : policy.allowedSkus,
      };
      if (kind === "human_not_present") {
        if (!policy.allowedSkus.length) return json(res, 400, { error: "허용 상품을 하나 이상 선택하세요" });
        await issueOpenMandates();
        emit({ purchaseId: "policy", layer: "AP2", kind: "info", title: `사용자가 에이전트에게 open mandate 발급 — 건당 ≤ $${(policy.maxPerPurchase / 100).toFixed(2)}, 누적 ≤ $${(policy.budget / 100).toFixed(2)}, 상품 ${policy.allowedSkus.join(", ")}` });
      } else {
        hnp = undefined;
        emit({ purchaseId: "policy", layer: "AP2", kind: "info", title: "human-present 모드 — 결제마다 직접 승인하고 사용자 키로 서명" });
      }
      return json(res, 200, { policy });
    }
    if (req.method === "POST" && url.pathname === "/api/buy") {
      const b = await readJson(req);
      const product = catalog.find((p) => p.path === b.path);
      if (!product) return json(res, 400, { error: "unknown product" });
      if (busy) return json(res, 409, { error: "다른 결제가 진행 중입니다" });
      busy = true;
      const purchaseId = randomUUID();
      void buy(purchaseId, product, typeof b.input === "string" ? b.input.slice(0, 500) : "");
      return json(res, 202, { purchaseId });
    }
    if (req.method === "POST" && url.pathname === "/api/signer") {
      if (busy) return json(res, 409, { error: "purchase in progress" });
      const b = await readJson(req);
      if (b.mode === "metamask") {
        if (typeof b.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.address)) return json(res, 400, { error: "invalid address" });
        metamaskAddress = getAddress(b.address);
        signerMode = "metamask";
        emit({ purchaseId: "policy", layer: "x402", kind: "info", title: `결제 서명자: MetaMask ${metamaskAddress}` });
      } else {
        signerMode = "server";
        emit({ purchaseId: "policy", layer: "x402", kind: "info", title: `결제 서명자: 서버 키 ${serverWallet.address}` });
      }
      return json(res, 200, { mode: signerMode, address: payerAddress() });
    }
    const sign = url.pathname.match(/^\/api\/sign\/([\w-]+)$/);
    if (req.method === "POST" && sign) {
      const pending = pendingSignatures.get(sign[1]!);
      if (!pending) return json(res, 404, { error: "no pending signature request" });
      const b = await readJson(req);
      if (typeof b.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(b.signature)) pending.resolve(b.signature as Hex);
      else pending.reject(new Error(`MetaMask: ${typeof b.error === "string" ? b.error.slice(0, 200) : "signature rejected"}`));
      return json(res, 200, { ok: true });
    }
    const decision = url.pathname.match(/^\/api\/purchases\/([\w-]+)\/decision$/);
    if (req.method === "POST" && decision) {
      const resolve = pendingApprovals.get(decision[1]!);
      if (!resolve) return json(res, 404, { error: "no pending approval" });
      const b = await readJson(req);
      const approve = b.approve === true;
      emit({ purchaseId: decision[1]!, step: 3, layer: "AP2", kind: "info", title: approve ? "사용자 승인 — 사용자 키로 mandate 서명 진행" : "사용자 거절" });
      resolve(approve);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`
  x402-ap2 web wallet
  ────────────────────────────────────────────────
  open        ${ORIGIN}
  merchant    ${MERCHANT_URL}  (${disco.merchant.name}, ${disco.network})
  payer       ${serverWallet.address}${process.env.PAYER_KEY ? "" : "  (random, unfunded — set PAYER_KEY in .env)"}  (or connect MetaMask in the UI)
  user        ${userId}
  balances    ${rpc ? `via ${new URL(process.env.RPC_URL!).host}` : "via merchant /dev/balance"}
`);
});

/**
 * x402-ap2 demo server — a merchant API and an x402 facilitator you can integrate against.
 *
 *   merchant     http://127.0.0.1:4020   paid APIs + discovery + dev endpoints
 *   facilitator  http://127.0.0.1:4021   POST /verify, POST /settle, GET /supported
 *
 * The merchant talks to the facilitator over HTTP (HttpFacilitator), exactly as it would in production.
 *
 * Env:
 *   HOST (127.0.0.1)  PORT (4020)  FACILITATOR_PORT (4021)
 *   PUBLIC_URL        public origin of the merchant (default http://HOST:PORT) — must match what clients fetch
 *   FACILITATOR_URL   use an external facilitator instead of the bundled local one
 *   NETWORK           base-sepolia (default) | base
 *   PAY_TO            merchant wallet (default: random address)
 *   DEV_REGISTRATION  "0" disables POST /dev/users
 *
 * On-chain mode (e.g. anvil — see demo/anvil-setup.ts): the bundled facilitator settles for real
 * by calling transferWithAuthorization.
 *   RPC_URL               JSON-RPC endpoint; enables on-chain mode
 *   USDC_ADDRESS          EIP-3009 token address (default: Circle USDC on Sepolia / Base Sepolia / Base)
 *   USDC_EIP712_NAME      token EIP-712 domain name (default from the Circle preset, else "USDC"),
 *                         version via USDC_EIP712_VERSION ("2")
 *   FACILITATOR_PRIVATE_KEY  gas payer (default: anvil account #0 when chainId is 31337)
 *   PAY_TO                in on-chain mode defaults to the facilitator address (funds come back to you)
 *
 * Values are also read from ./.env (see .env.example).
 *
 * Run: npm run demo:server
 */
import { createServer, type Server } from "node:http";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { JWK } from "jose";
import {
  Ap2X402Merchant,
  EIP3009_ABI,
  HttpFacilitator,
  LocalFacilitator,
  OnchainFacilitator,
  USDC_BASE,
  USDC_BASE_SEPOLIA,
  USDC_BY_CHAIN,
  X402_VERSION,
  createFacilitatorHandler,
  generateKeyPairJwk,
  toNodeHandler,
  toPublicJwk,
  type AssetInfo,
  type CartInput,
  type Facilitator,
  type MerchantEvent,
} from "../src/index.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4020);
const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT ?? 4021);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://${HOST}:${PORT}`).replace(/\/$/, "");
const RPC_URL = process.env.RPC_URL;
let PAY_TO = process.env.PAY_TO as `0x${string}` | undefined;
const DEV_REGISTRATION = process.env.DEV_REGISTRATION !== "0";

// ── Logging ─────────────────────────────────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 23);
const log = (tag: string, msg: string) => console.log(`${ts()} ${tag.padEnd(12)} ${msg}`);
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const events: (MerchantEvent & { at: string })[] = [];
function onEvent(e: MerchantEvent) {
  events.push({ ...e, at: new Date().toISOString() });
  if (events.length > 200) events.shift();
  const path = new URL(e.resource).pathname;
  if (e.type === "payment_required") log("402", `${path} checkout=${e.checkoutId.slice(0, 8)} ${usd(e.amount.amount)}`);
  if (e.type === "payment_rejected") log("REJECTED", `${path} ${e.message}`);
  if (e.type === "payment_settled") {
    log("SETTLED", `${path} ${usd(e.amount.amount)} user=${e.userId} mode=${e.mode} payer=${e.payer} tx=${e.transaction.slice(0, 18)}…`);
  }
}

// ── Chain / asset ───────────────────────────────────────────────────────────
let ASSET: AssetInfo = process.env.NETWORK === "base" ? USDC_BASE : USDC_BASE_SEPOLIA;
let backend: Facilitator = new LocalFacilitator();
let chainInfo = "bundled LocalFacilitator — no real funds move";
let tokenBalance: ((a: `0x${string}`) => Promise<string>) | undefined;
let explorerTx = (tx: string) => tx;

if (RPC_URL) {
  const chainId = await createPublicClient({ transport: http(RPC_URL) }).getChainId();
  const preset = USDC_BY_CHAIN[chainId];
  const token = (process.env.USDC_ADDRESS ?? preset?.address) as `0x${string}` | undefined;
  if (!token) throw new Error("USDC_ADDRESS is required on this chain (see npm run demo:anvil-setup)");
  const explorer = { 11155111: "https://sepolia.etherscan.io", 84532: "https://sepolia.basescan.org", 8453: "https://basescan.org" }[chainId];
  if (explorer) explorerTx = (tx) => `${explorer}/tx/${tx}`;
  const key = (process.env.FACILITATOR_PRIVATE_KEY ??
    (chainId === 31337 ? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" : undefined)) as Hex | undefined;
  if (!key) throw new Error("FACILITATOR_PRIVATE_KEY is required outside anvil");
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(key) });
  backend = new OnchainFacilitator({ walletClient, publicClient });
  ASSET = {
    network: `eip155:${chainId}`,
    address: token,
    symbol: "USDC",
    decimals: 6,
    currency: "USD",
    currencyExponent: 2,
    eip712: {
      name: process.env.USDC_EIP712_NAME ?? (token.toLowerCase() === preset?.address.toLowerCase() ? preset.eip712.name : "USDC"),
      version: process.env.USDC_EIP712_VERSION ?? "2",
    },
  };
  PAY_TO ??= walletClient.account.address;
  tokenBalance = async (a) => formatUnits(await publicClient.readContract({ address: token, abi: EIP3009_ABI, functionName: "balanceOf", args: [a] }), 6);
  chainInfo = `OnchainFacilitator via ${RPC_URL} — gas paid by ${walletClient.account.address}`;
}

PAY_TO ??= privateKeyToAccount(generatePrivateKey()).address;

// ── Facilitator (bundled) ───────────────────────────────────────────────────
let facilitatorServer: Server | undefined;
const facilitatorUrl = process.env.FACILITATOR_URL ?? `http://${HOST}:${FACILITATOR_PORT}`;
if (!process.env.FACILITATOR_URL) {
  const local = backend;
  const handler = createFacilitatorHandler(
    {
      verify: async (p, r) => {
        const v = await local.verify(p, r);
        log("FAC/verify", `${v.isValid ? "valid" : `invalid: ${v.invalidReason}`} payer=${v.payer ?? "-"}`);
        return v;
      },
      settle: async (p, r) => {
        const s = await local.settle(p, r);
        log("FAC/settle", s.success ? `ok amount=${s.amount} tx=${explorerTx(s.transaction)}` : `failed: ${s.errorReason}`);
        return s;
      },
    },
    { kinds: [{ x402Version: X402_VERSION, scheme: "exact", network: ASSET.network }], extensions: ["ap2"] },
  );
  facilitatorServer = createServer(toNodeHandler(handler, { baseUrl: facilitatorUrl }));
}

// ── Merchant ────────────────────────────────────────────────────────────────
const merchantKey = await generateKeyPairJwk();
const merchantInfo = { id: new URL(PUBLIC_URL).host, name: "BAY Demo Data Shop", website: PUBLIC_URL };
const users = new Map<string, JWK>();

const merchant = new Ap2X402Merchant({
  merchant: merchantInfo,
  signingKey: merchantKey.privateJwk,
  payTo: PAY_TO,
  asset: ASSET,
  facilitator: new HttpFacilitator({ url: facilitatorUrl }),
  resolveUserKey: (iss) => users.get(iss) ?? null,
  onEvent,
});

interface Product {
  method: "GET" | "POST";
  path: string;
  sku: string;
  title: string;
  description: string;
  /** Price is computed per request so it can depend on the input. */
  cart: (req: Request) => CartInput | Promise<CartInput>;
  serve: (req: Request) => unknown | Promise<unknown>;
  priceHint: string;
}

const products: Product[] = [
  {
    method: "GET",
    path: "/api/forecast",
    sku: "forecast-7d",
    title: "7-day forecast",
    description: "7-day weather forecast for ?city=",
    priceHint: "$0.25",
    cart: () => ({ line_items: [{ id: "forecast-7d", title: "7-day forecast", quantity: 1, unit_price: 25 }] }),
    serve: (req) => {
      const city = new URL(req.url).searchParams.get("city") ?? "Seoul";
      return { city, days: ["sunny 21°C", "cloudy 19°C", "rain 16°C", "sunny 22°C", "sunny 23°C", "windy 18°C", "cloudy 20°C"] };
    },
  },
  {
    method: "GET",
    path: "/api/report",
    sku: "market-report",
    title: "Market report",
    description: "Premium market report (expensive — useful to test amount limits)",
    priceHint: "$5.00",
    cart: () => ({ line_items: [{ id: "market-report", title: "Market report", quantity: 1, unit_price: 500 }] }),
    serve: () => ({ title: "Q4 agent-commerce outlook", summary: "Stablecoin rails + delegated mandates go mainstream." }),
  },
  {
    method: "POST",
    path: "/api/translate",
    sku: "translate",
    title: "Translation",
    description: 'POST {"text": "..."} — priced at $0.01 per word',
    priceHint: "$0.01 / word",
    cart: async (req) => {
      const { text = "" } = (await req.json().catch(() => ({}))) as { text?: string };
      const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
      return { line_items: [{ id: "translate", title: "Translation", quantity: 1, unit_price: words }] };
    },
    serve: async (req) => {
      const { text = "" } = (await req.json()) as { text?: string };
      return { original: text, translated: text.split("").reverse().join(""), note: "demo translation (reversed)" };
    },
  },
];

const paid = new Map(
  products.map((p) => [
    `${p.method} ${p.path}`,
    merchant.protect(async (req, payment) => Response.json({ data: await p.serve(req), paidBy: payment.payer }), {
      cart: p.cart,
      description: p.description,
      mimeType: "application/json",
    }),
  ]),
);

// ── Routing ─────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, PAYMENT-SIGNATURE",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
};

async function route(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const paidHandler = paid.get(`${req.method} ${pathname}`);
  if (paidHandler) return paidHandler(req);

  if (req.method === "GET" && pathname === "/") {
    return Response.json({
      service: merchantInfo.name,
      protocol: { x402Version: X402_VERSION, extension: "ap2" },
      network: ASSET.network,
      asset: { symbol: ASSET.symbol, address: ASSET.address },
      products: products.map(({ method, path, sku, title, description, priceHint }) => ({ method, path, sku, title, description, price: priceHint })),
      endpoints: {
        merchant: "GET /.well-known/ap2-merchant",
        registerUser: DEV_REGISTRATION ? 'POST /dev/users {"id": "user:alice", "jwk": {…public JWK…}}' : "disabled",
        events: "GET /dev/events",
        balance: RPC_URL ? "GET /dev/balance/:address" : "on-chain mode only",
        facilitator: facilitatorUrl,
      },
    });
  }

  if (req.method === "GET" && pathname === "/.well-known/ap2-merchant") {
    return Response.json({ merchant: merchantInfo, jwk: toPublicJwk(merchantKey.publicJwk), payTo: PAY_TO, network: ASSET.network, asset: ASSET.address });
  }

  if (pathname === "/dev/users" && req.method === "POST") {
    if (!DEV_REGISTRATION) return Response.json({ error: "registration disabled" }, { status: 403 });
    const body = (await req.json().catch(() => null)) as { id?: unknown; jwk?: JWK } | null;
    if (typeof body?.id !== "string" || !body.id || typeof body.jwk?.kty !== "string") {
      return Response.json({ error: 'expected {"id": string, "jwk": public JWK}' }, { status: 400 });
    }
    if (body.jwk.d !== undefined) return Response.json({ error: "send the PUBLIC key only (jwk.d present)" }, { status: 400 });
    users.set(body.id, toPublicJwk(body.jwk));
    log("USER", `registered ${body.id} kid=${body.jwk.kid ?? "-"}`);
    return Response.json({ ok: true, id: body.id }, { status: 201 });
  }
  if (pathname === "/dev/users" && req.method === "GET") return Response.json({ users: [...users.keys()] });
  if (pathname === "/dev/events" && req.method === "GET") return Response.json({ events });
  const bal = pathname.match(/^\/dev\/balance\/(0x[0-9a-fA-F]{40})$/);
  if (bal && req.method === "GET") {
    if (!tokenBalance) return Response.json({ error: "on-chain mode only (set RPC_URL)" }, { status: 400 });
    return Response.json({ address: bal[1], usdc: await tokenBalance(bal[1] as `0x${string}`) });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function withCors(req: Request): Promise<Response> {
  const res = await route(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const merchantServer = createServer(toNodeHandler(withCors, { baseUrl: PUBLIC_URL }));

// ── Start ───────────────────────────────────────────────────────────────────
const listen = (s: Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, HOST, resolve);
  });

if (facilitatorServer) await listen(facilitatorServer, FACILITATOR_PORT);
await listen(merchantServer, PORT);

console.log(`
  x402-ap2 demo server
  ────────────────────────────────────────────────────────
  merchant      ${PUBLIC_URL}   (id: ${merchantInfo.id})
  facilitator   ${facilitatorUrl}   (${facilitatorServer ? chainInfo : "external"})
  network       ${ASSET.network}  ${ASSET.symbol} ${ASSET.address}
  payTo         ${PAY_TO}
  products      ${products.map((p) => `${p.method} ${p.path} (${p.priceHint})`).join("\n                ")}
  dev users     ${DEV_REGISTRATION ? "POST /dev/users enabled" : "disabled"}
  ────────────────────────────────────────────────────────
  try:  curl -si ${PUBLIC_URL}/api/forecast
        npm run demo:client
`);

const shutdown = () => {
  merchantServer.close();
  facilitatorServer?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

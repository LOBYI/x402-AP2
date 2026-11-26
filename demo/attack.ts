/**
 * Sends malicious / malformed payments to a running demo server and checks it refuses each one.
 * A valid PAYMENT-SIGNATURE is captured first (without being sent), then tampered with.
 *
 * Run (server must be up): npm run demo:attack [-- --server http://127.0.0.1:4020]
 * In on-chain mode pass a funded wallet: PAYER_KEY=0x… npm run demo:attack
 */
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Ap2X402Client,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  createOpenCheckoutMandate,
  createOpenPaymentMandate,
  decodePaymentRequired,
  encodeHeader,
  generateKeyPairJwk,
  type Merchant,
} from "../src/index.js";

const { values } = parseArgs({ options: { server: { type: "string", default: "http://127.0.0.1:4020" } } });
const server = values.server.replace(/\/$/, "");
const target = `${server}/api/forecast`;

const { merchant } = (await (await fetch(`${server}/.well-known/ap2-merchant`)).json()) as { merchant: Merchant };
const user = await generateKeyPairJwk();
const agent = await generateKeyPairJwk();
const userId = `user:attacker-test-${Date.now()}`;
await fetch(`${server}/dev/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: userId, jwk: user.publicJwk }) });

const mandates = async (max: number) => ({
  openCheckoutMandate: await createOpenCheckoutMandate(
    user.privateJwk,
    [{ type: "checkout.line_items", items: [{ id: "i", acceptable_items: [{ id: "forecast-7d", title: "7-day forecast" }], quantity: 1 }] }],
    { issuer: userId, agentPublicJwk: agent.publicJwk },
  ),
  openPaymentMandate: await createOpenPaymentMandate(user.privateJwk, [{ type: "payment.amount_range", currency: "USD", max }], {
    issuer: userId,
    agentPublicJwk: agent.publicJwk,
  }),
});

/** Run the SDK client but intercept the paid retry instead of sending it. */
async function capture(url: string): Promise<string> {
  let captured = "";
  const client = new Ap2X402Client({
    wallet: privateKeyToAccount((process.env.PAYER_KEY as `0x${string}` | undefined) ?? generatePrivateKey()),
    mode: { kind: "human_not_present", agentKey: agent.privateJwk, userPublicKey: user.publicJwk, ...(await mandates(100)) },
    fetch: async (input, init) => {
      const sig = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
      if (sig) {
        captured = sig;
        return new Response(null, { status: 499 });
      }
      return fetch(input, init);
    },
  });
  await client.pay(url);
  return captured;
}

const decode = (h: string) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

async function send(header: string, url = target) {
  const res = await fetch(url, { headers: { [HEADER_PAYMENT_SIGNATURE]: header } });
  const pr = res.headers.get(HEADER_PAYMENT_REQUIRED);
  return { status: res.status, error: pr ? decodePaymentRequired(pr).error : undefined };
}

let pass = 0;
let fail = 0;
async function expectRejected(name: string, header: string, url?: string) {
  const r = await send(header, url);
  const ok = r.status === 402;
  ok ? pass++ : fail++;
  console.log(`${ok ? "\x1b[32m✔ rejected\x1b[0m" : "\x1b[31m✘ ACCEPTED\x1b[0m"}  ${name.padEnd(42)} ${r.status} ${r.error ?? ""}`);
}

// Baseline: a legit payment goes through; replaying it must not.
const legit = await capture(target);
const first = await send(legit);
console.log(`${first.status === 200 ? "\x1b[32m✔ accepted\x1b[0m" : "\x1b[31m✘ FAILED\x1b[0m"}  ${"legit payment (control)".padEnd(42)} ${first.status}`);
first.status === 200 ? pass++ : fail++;
await expectRejected("replay the same PAYMENT-SIGNATURE", legit);

const fresh = () => capture(target);
{
  const p = decode(await fresh());
  p.accepted.payTo = privateKeyToAccount(generatePrivateKey()).address;
  await expectRejected("swap accepted.payTo", encodeHeader(p));
}
{
  const p = decode(await fresh());
  p.accepted.amount = "1";
  await expectRejected("lower accepted.amount", encodeHeader(p));
}
{
  const p = decode(await fresh());
  p.payload.authorization.nonce = `0x${"00".repeat(32)}`;
  await expectRejected("EIP-3009 nonce not bound to mandate", encodeHeader(p));
}
{
  const a = decode(await fresh());
  const b = decode(await fresh());
  a.extensions.ap2.info.paymentMandate = b.extensions.ap2.info.paymentMandate;
  await expectRejected("splice payment mandate from another checkout", encodeHeader(a));
}
{
  const p = decode(await fresh());
  p.extensions.ap2.info.checkoutJwt = p.extensions.ap2.info.checkoutJwt.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
  await expectRejected("forge merchant checkout signature", encodeHeader(p));
}
{
  const p = decode(await fresh());
  p.extensions.ap2.info.paymentMandate = p.extensions.ap2.info.paymentMandate.replace(/~~.*/, "~");
  await expectRejected("drop the agent hop (bare open mandate)", encodeHeader(p));
}
{
  const p = decode(await fresh());
  await expectRejected("use /api/forecast checkout on /api/report", encodeHeader(p), `${server}/api/report`);
}
await expectRejected("garbage header", "not-base64-json");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

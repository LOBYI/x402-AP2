import { describe, expect, it } from "vitest";
import {
  Ap2X402Client,
  Ap2X402Merchant,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  InMemoryReplayStore,
  LocalFacilitator,
  USDC_BASE_SEPOLIA,
  decodePaymentRequired,
  type Facilitator,
  type ReplayStore,
} from "../src/index.js";
import { MERCHANT, REPORT, URL_REPORT, setup } from "./fixtures.js";

type Env = Awaited<ReturnType<typeof setup>>;

/** Wait while forcing GC — the window in which undici used to cancel a cloned request's body. */
async function gcPause(ms: number) {
  const gc = (globalThis as { gc?: () => void }).gc;
  for (let t = 0; t < ms; t += 20) {
    gc?.();
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Replay store with network-like latency (e.g. Redis), sitting between cart() and the handler. */
function slowReplayStore(ms: number): ReplayStore {
  const inner = new InMemoryReplayStore();
  return {
    claim: async (id, exp) => (await gcPause(ms), inner.claim(id, exp)),
    release: (id) => inner.release(id),
  };
}

/** LocalFacilitator with a settle counter, optional delay, and optional forced failure. */
function spyFacilitator(opts: { delayMs?: number; fail?: boolean } = {}) {
  const inner = new LocalFacilitator();
  const calls = { settle: 0 };
  const f: Facilitator = {
    verify: (p, r) => inner.verify(p, r),
    settle: async (p, r) => {
      calls.settle++;
      if (opts.delayMs) await gcPause(opts.delayMs); // slow on-chain settlement
      if (opts.fail) return { success: false, errorReason: "simulated_failure", transaction: "", network: r.network };
      return inner.settle(p, r);
    },
  };
  return { f, calls };
}

function wire(env: Env, facilitator: Facilitator, handler: (req: Request) => Response | Promise<Response>, replayStore?: ReplayStore) {
  const merchant = new Ap2X402Merchant({
    merchant: MERCHANT,
    signingKey: env.merchantKey.privateJwk,
    payTo: env.payTo,
    asset: USDC_BASE_SEPOLIA,
    facilitator,
    resolveUserKey: () => env.user.publicJwk,
    replayStore,
  });
  const protectedHandler = merchant.protect(handler, { cart: async (req) => (await req.text(), REPORT) });
  const fetchImpl = ((i: string | URL | Request, init?: RequestInit) => protectedHandler(new Request(i, init))) as typeof fetch;
  return env.makeClient({ fetch: fetchImpl }) as Ap2X402Client;
}

const POST = { method: "POST", body: JSON.stringify({ text: "hello agent" }) };

describe("protect(): body handling and settlement ordering", () => {
  it("handler can read the POST body despite GC during slow replay-store / settlement I/O (regression)", async () => {
    expect(typeof (globalThis as { gc?: unknown }).gc).toBe("function");
    const env = await setup();
    const { f } = spyFacilitator({ delayMs: 200 });
    const client = wire(env, f, async (req) => Response.json(await req.json()), slowReplayStore(200));
    const res = await client.fetch(URL_REPORT, POST);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello agent" });
    expect(res.headers.get(HEADER_PAYMENT_RESPONSE)).toBeTruthy();
  });

  it("does not charge when the handler fails (status >= 400)", async () => {
    const env = await setup();
    const { f, calls } = spyFacilitator();
    const client = wire(env, f, () => Response.json({ error: "upstream down" }, { status: 503 }));
    const res = await client.fetch(URL_REPORT, POST);
    expect(res.status).toBe(503);
    expect(calls.settle).toBe(0);
    expect(res.headers.get(HEADER_PAYMENT_RESPONSE)).toBeNull();
  });

  it("does not charge when the handler throws", async () => {
    const env = await setup();
    const { f, calls } = spyFacilitator();
    const client = wire(env, f, () => {
      throw new Error("boom");
    });
    await expect(client.fetch(URL_REPORT, POST)).rejects.toThrow("boom");
    expect(calls.settle).toBe(0);
  });

  it("withholds content when settlement fails", async () => {
    const env = await setup();
    const { f, calls } = spyFacilitator({ fail: true });
    const client = wire(env, f, () => Response.json({ secret: "content" }));
    const res = await client.fetch(URL_REPORT, POST);
    expect(calls.settle).toBe(1);
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("secret");
    expect(decodePaymentRequired(res.headers.get(HEADER_PAYMENT_REQUIRED)!).error).toMatch(/settlement_failed/);
  });
});

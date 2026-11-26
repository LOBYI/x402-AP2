import { describe, expect, it } from "vitest";
import {
  Ap2X402Client,
  Ap2X402Merchant,
  HttpFacilitator,
  LocalFacilitator,
  USDC_BASE_SEPOLIA,
  X402_VERSION,
  createFacilitatorHandler,
  type MerchantEvent,
} from "../src/index.js";
import { REPORT, URL_REPORT, setup } from "./fixtures.js";

describe("facilitator over HTTP + merchant events", () => {
  it("merchant settles through HttpFacilitator ↔ createFacilitatorHandler and emits events", async () => {
    const env = await setup();
    const fhandler = createFacilitatorHandler(new LocalFacilitator(), {
      kinds: [{ x402Version: X402_VERSION, scheme: "exact", network: USDC_BASE_SEPOLIA.network }],
    });
    const facilitator = new HttpFacilitator({ url: "https://facilitator.test/x402", fetch: ((i: string | URL | Request, init?: RequestInit) => fhandler(new Request(i, init))) as typeof fetch });

    const events: MerchantEvent[] = [];
    const merchant = new Ap2X402Merchant({
      merchant: { id: "shop.example", name: "Example Shop", website: "https://shop.example" },
      signingKey: env.merchantKey.privateJwk,
      payTo: env.payTo,
      asset: USDC_BASE_SEPOLIA,
      facilitator,
      resolveUserKey: () => env.user.publicJwk,
      onEvent: (e) => events.push(e),
    });
    // A POST handler that reads the body after the cart callback also read it.
    const handler = merchant.protect(async (req) => Response.json(await req.json()), {
      cart: async (req) => (await req.json(), REPORT),
    });
    const client = new Ap2X402Client({
      wallet: env.wallet,
      fetch: ((i: string | URL | Request, init?: RequestInit) => handler(new Request(i, init))) as typeof fetch,
      mode: { kind: "human_not_present", agentKey: env.agent.privateJwk, userPublicKey: env.user.publicJwk, openCheckoutMandate: env.openCheckoutMandate, openPaymentMandate: env.openPaymentMandate },
    });
    const res = await client.fetch(URL_REPORT, { method: "POST", body: JSON.stringify({ hello: "world" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
    expect(events.map((e) => e.type)).toEqual(["payment_required", "payment_settled"]);

    const supported = await fhandler(new Request("https://facilitator.test/x402/supported"));
    expect(await supported.json()).toMatchObject({ kinds: [{ scheme: "exact", network: "eip155:84532" }] });
  });
});

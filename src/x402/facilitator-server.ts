import type { Facilitator } from "./facilitator.js";
import { X402_VERSION, type FacilitatorRequest } from "./types.js";

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface FacilitatorHandlerOptions {
  /** Advertised in `GET /supported`. */
  kinds: SupportedKind[];
  extensions?: string[];
}

/**
 * Expose any `Facilitator` over the x402 facilitator HTTP API
 * (`POST /verify`, `POST /settle`, `GET /supported`) as a Web-standard handler.
 * Routes match on the path suffix, so it can be mounted under any prefix.
 */
export function createFacilitatorHandler(f: Facilitator, opts: FacilitatorHandlerOptions) {
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (req.method === "GET" && path.endsWith("/supported")) {
      return Response.json({ kinds: opts.kinds, extensions: opts.extensions ?? [], signers: {} });
    }
    const op = path.endsWith("/verify") ? "verify" : path.endsWith("/settle") ? "settle" : undefined;
    if (req.method !== "POST" || !op) return Response.json({ error: "not_found" }, { status: 404 });

    let body: FacilitatorRequest;
    try {
      body = (await req.json()) as FacilitatorRequest;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!body?.paymentPayload || !body.paymentRequirements) {
      return Response.json({ error: "paymentPayload and paymentRequirements are required" }, { status: 400 });
    }
    if (body.x402Version !== X402_VERSION) {
      return op === "verify"
        ? Response.json({ isValid: false, invalidReason: "invalid_x402_version" })
        : Response.json({ success: false, errorReason: "invalid_x402_version", transaction: "", network: body.paymentRequirements.network });
    }
    return Response.json(await f[op](body.paymentPayload, body.paymentRequirements));
  };
}

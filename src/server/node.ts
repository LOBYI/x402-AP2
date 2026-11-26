import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Adapt a Web-standard handler to Node's `http` / Express `(req, res)` signature.
 * `baseUrl` should be the public origin (e.g. `https://api.example.com`) so the checkout's
 * `resource` matches what clients requested even behind a reverse proxy.
 */
export function toNodeHandler(handler: (req: Request) => Promise<Response>, opts: { baseUrl?: string } = {}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const base = opts.baseUrl ?? `http://${req.headers.host ?? "localhost"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
        else if (v !== undefined) headers.set(k, v);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const body = hasBody ? await readBody(req) : undefined;
      const response = await handler(new Request(new URL(req.url ?? "/", base), { method: req.method, headers, body }));
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  };
}

async function readBody(req: IncomingMessage): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

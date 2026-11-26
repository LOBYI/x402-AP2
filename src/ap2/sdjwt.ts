/**
 * Minimal SD-JWT implementation sufficient for AP2 mandate chains.
 *
 * Wire format (as in the AP2 reference SDK):
 *   root issuance       <jwt>~<disclosure>~...~
 *   delegated hop       <prev token>~<hop-jwt>~<disclosure>~...~     (segments joined by "~~")
 *
 * Each hop is signed by the key in the previous hop's `cnf.jwk` and carries
 * `sd_hash = b64url(sha256(<exact preceding token>))`, so hops cannot be re-ordered,
 * spliced into another chain, or detached from their parent.
 *
 * Scope: only top-level claims can be selectively disclosable (no nested / array-element disclosures).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  CompactSign,
  base64url,
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type JWSHeaderParameters,
} from "jose";

export const TYP_ROOT = "dc+sd-jwt";
export const TYP_HOP = "kb+sd-jwt";
const ALLOWED_ALGS = ["ES256", "ES384", "EdDSA"];
const RESERVED = new Set(["_sd", "_sd_alg", "...", "sd_hash"]);

export interface KeyPairJwk {
  publicJwk: JWK;
  privateJwk: JWK;
}

/** Generate an ES256 key pair as JWKs (user device keys, agent keys, merchant keys). */
export async function generateKeyPairJwk(alg: "ES256" | "EdDSA" = "ES256"): Promise<KeyPairJwk> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), alg };
  const privateJwk = { ...(await exportJWK(privateKey)), alg };
  publicJwk.kid = privateJwk.kid = await calculateJwkThumbprint(publicJwk);
  return { publicJwk, privateJwk };
}

/** Strip private members so a JWK can be embedded in `cnf` or published. */
export function toPublicJwk(jwk: JWK): JWK {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, k: _k, ...pub } = jwk;
  return pub;
}

function algOf(jwk: JWK): string {
  if (jwk.alg) return jwk.alg;
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "ES256";
  if (jwk.kty === "EC" && jwk.crv === "P-384") return "ES384";
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return "EdDSA";
  throw new Error("sd-jwt: cannot infer alg from JWK");
}

export const sha256b64u = (s: string) => base64url.encode(createHash("sha256").update(s, "ascii").digest());

async function signJws(payload: Record<string, unknown>, privateJwk: JWK, typ: string): Promise<string> {
  const alg = algOf(privateJwk);
  const key = await importJWK(privateJwk, alg);
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg, typ, ...(privateJwk.kid ? { kid: privateJwk.kid } : {}) })
    .sign(key);
}

function makeDisclosures(claims: Record<string, unknown>, sdKeys: string[] = []) {
  const payload: Record<string, unknown> = {};
  const disclosures: string[] = [];
  const digests: string[] = [];
  for (const [k, v] of Object.entries(claims)) {
    if (RESERVED.has(k)) throw new Error(`sd-jwt: reserved claim name ${k}`);
    if (sdKeys.includes(k)) {
      const d = base64url.encode(JSON.stringify([base64url.encode(randomBytes(16)), k, v]));
      disclosures.push(d);
      digests.push(sha256b64u(d));
    } else {
      payload[k] = v;
    }
  }
  if (digests.length) {
    payload["_sd"] = digests.sort();
    payload["_sd_alg"] = "sha-256";
  }
  return { payload, disclosures };
}

export interface IssueOptions {
  /** Top-level claim names to make selectively disclosable. */
  selectivelyDisclose?: string[];
}

/** Issue a root SD-JWT signed by `issuerPrivateJwk`. Returns the issuance form ending with "~". */
export async function issue(claims: Record<string, unknown>, issuerPrivateJwk: JWK, opts: IssueOptions = {}): Promise<string> {
  const { payload, disclosures } = makeDisclosures(claims, opts.selectivelyDisclose);
  const jws = await signJws(payload, issuerPrivateJwk, TYP_ROOT);
  return [jws, ...disclosures].join("~") + "~";
}

export interface DelegateOptions extends IssueOptions {
  /** Audience the hop is presented to (e.g. merchant id). */
  aud?: string;
  /** Verifier-supplied challenge. */
  nonce?: string;
  iat?: number;
}

/**
 * Append a hop to `prevToken`, signed by the holder key bound in the previous hop's `cnf`.
 * Returns the extended chain.
 */
export async function delegate(
  prevToken: string,
  claims: Record<string, unknown>,
  holderPrivateJwk: JWK,
  opts: DelegateOptions = {},
): Promise<string> {
  if (!prevToken.endsWith("~")) throw new Error("sd-jwt: previous token must be in canonical form (trailing '~')");
  const { payload, disclosures } = makeDisclosures(claims, opts.selectivelyDisclose);
  payload["sd_hash"] = sha256b64u(prevToken);
  if (opts.aud !== undefined) payload["aud"] = opts.aud;
  if (opts.nonce !== undefined) payload["nonce"] = opts.nonce;
  payload["iat"] ??= opts.iat ?? Math.floor(Date.now() / 1000);
  const jws = await signJws(payload, holderPrivateJwk, TYP_HOP);
  return prevToken + "~" + [jws, ...disclosures].join("~") + "~";
}

/** Split a chain into canonical segments (each ending with "~"). */
export function splitChain(token: string): string[] {
  if (!token.endsWith("~")) throw new Error("sd-jwt: token must end with '~'");
  const parts = token.split("~~");
  return parts.map((p, i) => (i === parts.length - 1 ? p : p + "~"));
}

export interface VerifiedHop {
  header: JWSHeaderParameters;
  /** Payload with disclosures resolved and SD bookkeeping (`_sd`, `_sd_alg`) removed. */
  claims: Record<string, unknown>;
  /** Canonical on-wire form of this segment. */
  raw: string;
  /** b64url(sha256(raw)) of the cumulative token ending at this hop. */
  digest: string;
}

export interface VerifyChainOptions {
  /** Resolve the root issuer's public key (trust anchor). Throw / return null to reject. */
  resolveRootKey: (claims: Record<string, unknown>, header: JWSHeaderParameters) => Promise<JWK | null> | JWK | null;
  /** Expected `aud` on the leaf hop. */
  expectedAud?: string;
  /** Expected `nonce` on the leaf hop. */
  expectedNonce?: string;
  now?: number;
  /** Allowed clock skew in seconds. */
  skew?: number;
}

async function verifySegment(segment: string, key: JWK, typ: string) {
  const [jws, ...rest] = segment.split("~");
  const disclosures = rest.slice(0, -1); // last element is "" from the trailing "~"
  if (!jws) throw new Error("sd-jwt: empty segment");
  const header = decodeProtectedHeader(jws);
  if (!header.alg || !ALLOWED_ALGS.includes(header.alg)) throw new Error(`sd-jwt: disallowed alg ${header.alg}`);
  if (header.typ !== typ) throw new Error(`sd-jwt: expected typ ${typ}, got ${header.typ}`);
  const { payload } = await compactVerify(jws, await importJWK(key, header.alg), { algorithms: ALLOWED_ALGS });
  const body = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;

  const sd = Array.isArray(body["_sd"]) ? (body["_sd"] as string[]) : [];
  if (sd.length && body["_sd_alg"] !== "sha-256") throw new Error("sd-jwt: unsupported _sd_alg");
  const claims: Record<string, unknown> = { ...body };
  delete claims["_sd"];
  delete claims["_sd_alg"];
  const seen = new Set<string>();
  for (const d of disclosures) {
    const digest = sha256b64u(d);
    if (!sd.includes(digest)) throw new Error("sd-jwt: disclosure not referenced by _sd");
    if (seen.has(digest)) throw new Error("sd-jwt: duplicate disclosure");
    seen.add(digest);
    const arr = JSON.parse(new TextDecoder().decode(base64url.decode(d))) as unknown;
    if (!Array.isArray(arr) || arr.length !== 3 || typeof arr[1] !== "string") throw new Error("sd-jwt: malformed disclosure");
    const name = arr[1];
    if (RESERVED.has(name) || name in claims) throw new Error(`sd-jwt: illegal disclosed claim ${name}`);
    claims[name] = arr[2];
  }
  return { header, claims };
}

/**
 * Verify a root SD-JWT or a delegation chain. Every hop's signature, `typ`, `sd_hash` link,
 * and time validity is checked; `aud` / `nonce` are checked on the leaf.
 */
export async function verifyChain(token: string, opts: VerifyChainOptions): Promise<VerifiedHop[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skew ?? 60;
  const segments = splitChain(token);
  const hops: VerifiedHop[] = [];
  let prefix = "";

  for (const [i, raw] of segments.entries()) {
    let key: JWK | null;
    if (i === 0) {
      const jws = raw.split("~")[0] ?? "";
      const unverified = JSON.parse(new TextDecoder().decode(base64url.decode(jws.split(".")[1] ?? ""))) as Record<string, unknown>;
      key = await opts.resolveRootKey(unverified, decodeProtectedHeader(jws));
      if (!key) throw new Error("sd-jwt: untrusted root issuer");
    } else {
      const cnf = hops[i - 1]!.claims["cnf"] as { jwk?: JWK } | undefined;
      if (!cnf?.jwk) throw new Error(`sd-jwt: hop ${i - 1} is not delegable (no cnf.jwk)`);
      key = cnf.jwk;
    }
    const { header, claims } = await verifySegment(raw, key, i === 0 ? TYP_ROOT : TYP_HOP);

    if (i > 0 && claims["sd_hash"] !== sha256b64u(prefix)) throw new Error(`sd-jwt: hop ${i} sd_hash does not match parent`);
    if (typeof claims["exp"] === "number" && claims["exp"] + skew < now) throw new Error(`sd-jwt: hop ${i} expired`);
    if (typeof claims["iat"] === "number" && claims["iat"] - skew > now) throw new Error(`sd-jwt: hop ${i} issued in the future`);

    prefix = i === 0 ? raw : prefix + "~" + raw;
    hops.push({ header, claims, raw, digest: sha256b64u(prefix) });
  }

  const leaf = hops[hops.length - 1]!.claims;
  if (opts.expectedAud !== undefined && leaf["aud"] !== opts.expectedAud) throw new Error("sd-jwt: leaf aud mismatch");
  if (opts.expectedNonce !== undefined && leaf["nonce"] !== opts.expectedNonce) throw new Error("sd-jwt: leaf nonce mismatch");
  return hops;
}

/** Hash identifying the root (issuance) token of a chain, used by `payment.reference`. */
export function rootDigest(token: string): string {
  return sha256b64u(splitChain(token)[0]!);
}

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

/**
 * Per-client request signing. A client holds an Ed25519 private key; `cue.yaml`
 * lists each client's public key. Every Gateway call carries a signature over
 * the client name, a timestamp, a nonce, the method and a hash of the
 * arguments, so a holder of the cluster cookie alone can't act as a client.
 */

export const AUTH_VERSION = 1;

export const RequestAuthSchema = z.object({
  v: z.literal(AUTH_VERSION),
  client: z.string().min(1).max(200),
  /** Epoch milliseconds when the client signed the request. */
  ts: z.number().int().nonnegative(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  /** Base64url Ed25519 signature over {@link signingString}. */
  sig: z.string().min(1).max(200),
});
export type RequestAuth = z.infer<typeof RequestAuthSchema>;

/** What a client sends for each Gateway call. `auth` is `null` only when the daemon has no clients configured. */
export const SignedRequestSchema = z.object({
  auth: RequestAuthSchema.nullable(),
  args: z.array(z.unknown()),
});
export type SignedRequest = z.infer<typeof SignedRequestSchema>;

/** JSON with object keys sorted recursively, after a JSON round trip (drops `undefined` like the wire does). */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? "null" : JSON.stringify(sortKeys(JSON.parse(text)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries: [string, unknown][] = Object.entries(value);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, v] of entries) out[key] = sortKeys(v);
    return out;
  }
  return value;
}

/** The exact bytes a client signs. */
export function signingString(input: { client: string; ts: number; nonce: string; method: string; args: readonly unknown[] }): string {
  const body = createHash("sha256").update(canonicalJson(input.args)).digest("base64url");
  return ["cue/1", input.client, String(input.ts), input.nonce, input.method, body].join("\n");
}

export function signRequest(input: {
  client: string;
  key: KeyObject;
  method: string;
  args: readonly unknown[];
  now?: number;
  nonce?: string;
}): SignedRequest {
  const ts = input.now ?? Date.now();
  const nonce = input.nonce ?? randomBytes(16).toString("base64url");
  const sig = sign(null, Buffer.from(signingString({ client: input.client, ts, nonce, method: input.method, args: input.args })), input.key).toString("base64url");
  return { auth: { v: AUTH_VERSION, client: input.client, ts, nonce, sig }, args: [...input.args] };
}

/** Checks the signature only; freshness, nonce reuse and permissions are the Gateway's job. */
export function verifySignature(input: { publicKey: KeyObject; method: string; auth: RequestAuth; args: readonly unknown[] }): boolean {
  const { auth } = input;
  const data = Buffer.from(signingString({ client: auth.client, ts: auth.ts, nonce: auth.nonce, method: input.method, args: input.args }));
  try {
    return verify(null, data, input.publicKey, Buffer.from(auth.sig, "base64url"));
  } catch {
    return false;
  }
}

/** Raw 32-byte Ed25519 public key, base64url, as written in `cue.yaml`. */
export function parsePublicKey(text: string): KeyObject {
  const x = text.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) throw new Error("public key must be 43 base64url characters (raw Ed25519)");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

export function encodePublicKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("not an Ed25519 public key");
  return jwk.x;
}

/** PKCS#8 PEM private key, as written by `cue keygen`. */
export function parsePrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("private key is not Ed25519");
  return key;
}

export function generateClientKey(): { privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: encodePublicKey(publicKey) };
}

/** A signer for every call made by `client` with `key` (fresh timestamp and nonce each time). */
export function createSigner(client: string, key: KeyObject): (method: string, args: readonly unknown[]) => SignedRequest {
  return (method, args) => signRequest({ client, key, method, args });
}

import { describe, expect, it } from "vitest";
import { canonicalJson, generateClientKey, parsePrivateKey, parsePublicKey, signRequest, verifySignature } from "@cue/core";

describe("request signing", () => {
  const alice = generateClientKey();
  const mallory = generateClientKey();
  const key = parsePrivateKey(alice.privateKeyPem);
  const pub = parsePublicKey(alice.publicKey);

  it("canonicalises key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("verifies a signed request regardless of key order on the wire", () => {
    const req = signRequest({ client: "alice", key, method: "submit", args: [{ prompt: "hi", labels: ["x"] }] });
    if (!req.auth) throw new Error("no auth");
    const reordered = [{ labels: ["x"], prompt: "hi" }];
    expect(verifySignature({ publicKey: pub, method: "submit", auth: req.auth, args: reordered })).toBe(true);
  });

  it("rejects tampering with method, args, client, timestamp or key", () => {
    const req = signRequest({ client: "alice", key, method: "cancel", args: ["job-20261122-aaaaaa"], now: 1000, nonce: "n".repeat(16) });
    const auth = req.auth;
    if (!auth) throw new Error("no auth");
    const ok = (over: Partial<Parameters<typeof verifySignature>[0]>) => verifySignature({ publicKey: pub, method: "cancel", auth, args: req.args, ...over });
    expect(ok({})).toBe(true);
    expect(ok({ method: "status" })).toBe(false);
    expect(ok({ args: ["job-20261122-bbbbbb"] })).toBe(false);
    expect(ok({ auth: { ...auth, client: "bob" } })).toBe(false);
    expect(ok({ auth: { ...auth, ts: 1001 } })).toBe(false);
    expect(ok({ auth: { ...auth, sig: "garbage" } })).toBe(false);
    expect(ok({ publicKey: parsePublicKey(mallory.publicKey) })).toBe(false);
  });

  it("validates key formats", () => {
    expect(() => parsePublicKey("short")).toThrow(/43 base64url/);
    expect(() => parsePrivateKey("not a pem")).toThrow();
  });
});

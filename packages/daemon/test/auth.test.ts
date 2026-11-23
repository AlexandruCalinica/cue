import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSigner, generateClientKey, parseConfig, parsePrivateKey, signRequest, type CueConfigInput } from "@cue/core";
import { claudeAdapter } from "@cue/harness";
import { startCued, type Cued, type GatewayClient, type Signer } from "@cue/daemon";

const FAKE = fileURLToPath(new URL("./fixtures/fake-harness.mjs", import.meta.url));
const bin = [process.execPath, FAKE];

const keys: Readonly<Record<string, { privateKeyPem: string; publicKey: string }>> = { alice: generateClientKey(), bob: generateClientKey(), ops: generateClientKey(), reader: generateClientKey(), mallory: generateClientKey() };
const pk = (name: string) => keys[name]?.publicKey ?? "";
const pem = (name: string) => keys[name]?.privateKeyPem ?? "";

function signer(client: string, key = client): Signer {
  const pair = keys[key];
  if (!pair) throw new Error(`no test key ${key}`);
  return createSigner(client, parsePrivateKey(pair.privateKeyPem));
}

describe("gateway identity and permissions", () => {
  let dir: string;
  let cued: Cued | null = null;

  const start = async (over: Partial<CueConfigInput> = {}) => {
    const config = parseConfig({
      dataDir: join(dir, "data"),
      node: { id: "auth-node" },
      limits: { tickMs: 40, leaseTtlSec: 2 },
      pools: [
        { harness: "claude", account: "a", bin, concurrency: 1 },
        { harness: "claude", account: "b", bin, concurrency: 1 },
      ],
      lanes: { team: { concurrency: 5 }, other: { concurrency: 5 } },
      clients: {
        alice: { publicKey: pk("alice"), lanes: ["team"], defaultLane: "team", maxActive: 2, maxMinutes: 5 },
        bob: { publicKey: pk("bob"), pools: ["claude:b"] },
        ops: { publicKey: pk("ops"), verbs: ["status", "list", "cancel", "stats", "audit"], scope: "all" },
        reader: { publicKey: pk("reader"), verbs: ["status"] },
      },
      ...over,
    });
    cued = await startCued({ config, adapters: [claudeAdapter], network: { kind: "local" }, killGraceMs: 300 });
    return cued;
  };
  const as = (s: Signer): GatewayClient => {
    if (!cued) throw new Error("not started");
    return cued.gatewayAs(s);
  };
  const spec = (prompt: string, over: Record<string, unknown> = {}) => ({ prompt, requester: "someone", ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cue-auth-"));
  });
  afterEach(async () => {
    await cued?.shutdown();
    cued = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects unsigned, unknown, wrong-key and stale calls, and audits each rejection", async () => {
    const c = await start();
    expect(await c.gateway.ping()).toBe("pong");
    await expect(c.gateway.list()).rejects.toThrow(/unauthorized: unsigned request/);
    await expect(as(signer("eve", "mallory")).list()).rejects.toThrow(/unknown client eve/);
    await expect(as(signer("alice", "mallory")).list()).rejects.toThrow(/bad signature/);
    const key = parsePrivateKey(pem("alice"));
    const stale: Signer = (method, args) => signRequest({ client: "alice", key, method, args, now: Date.now() - 10 * 60_000 });
    await expect(as(stale).list()).rejects.toThrow(/timestamp/);

    const audit = await as(signer("ops")).audit();
    expect(audit.filter((a) => !a.ok).map((a) => [a.client, a.method])).toEqual([
      ["alice", "list"],
      ["alice", "list"],
      ["eve", "list"],
      [null, "list"],
    ]);
  });

  it("rejects a replayed request", async () => {
    await start();
    const fixed = signRequest({ client: "ops", key: parsePrivateKey(pem("ops")), method: "list", args: [] });
    const replay = as(() => fixed);
    expect(await replay.list()).toEqual([]);
    await expect(replay.list()).rejects.toThrow(/replayed request/);
  });

  it("enforces verbs", async () => {
    await start();
    await expect(as(signer("reader")).submit(spec("say hi"))).rejects.toThrow(/may not call submit/);
    await expect(as(signer("ops")).submit(spec("say hi"))).rejects.toThrow(/may not call submit/);
    await expect(as(signer("alice")).stats()).rejects.toThrow(/may not call stats/);
    expect(await as(signer("reader")).status("job-20261122-aaaaaa")).toBeNull();
  });

  it("scopes jobs to their client unless the client has scope all", async () => {
    await start();
    const alice = as(signer("alice"));
    const bob = as(signer("bob"));
    const ops = as(signer("ops"));
    const { id } = await alice.submit(spec("say mine; sleep 3"));
    const rec = await alice.status(id);
    expect(rec).toMatchObject({ client: "alice", spec: { lane: "team", maxMinutes: 5 } });

    expect(await bob.status(id)).toBeNull();
    await expect(bob.cancel(id)).rejects.toThrow(/no such job/);
    await expect(bob.logs({ id })).rejects.toThrow(/no such job/);
    await expect(bob.events({ id })).rejects.toThrow(/no such job/);
    expect((await bob.list()).map((j) => j.id)).not.toContain(id);

    expect((await ops.list()).map((j) => j.id)).toContain(id);
    expect(await ops.cancel(id)).toMatchObject({ accepted: true });

    const audit = await ops.audit();
    expect(audit.find((a) => a.method === "submit")).toMatchObject({ client: "alice", ok: true, jobId: id });
    expect(audit.find((a) => a.method === "cancel" && a.ok)).toMatchObject({ client: "ops", jobId: id });
    expect(audit.find((a) => a.method === "cancel" && !a.ok)).toMatchObject({ client: "bob", reason: `no such job: ${id}` });
  });

  it("applies client lanes, limits and pool allow-lists", async () => {
    await start();
    const alice = as(signer("alice"));
    await expect(alice.submit(spec("say x", { lane: "other" }))).rejects.toThrow(/lane other is not allowed/);
    const capped = await alice.submit(spec("say a; sleep 3", { maxMinutes: 60 }));
    expect((await alice.status(capped.id))?.spec.maxMinutes).toBe(5);
    await alice.submit(spec("say b; sleep 3"));
    await expect(alice.submit(spec("say c"))).rejects.toThrow(/already has 2 unfinished jobs \(limit 2\)/);

    const bob = as(signer("bob"));
    expect((await bob.submit(spec("say bob"))).candidates).toEqual(["claude:b"]);
    await expect(bob.submit(spec("say pinned", { harness: "claude:a" }))).rejects.toThrow(/no enabled pool matches/);
  });

  it("routes by verified client", async () => {
    await start({ routing: [{ name: "alice-to-b", match: { client: ["alice"] }, use: ["claude:b"] }] });
    expect(await as(signer("alice")).submit(spec("say a"))).toMatchObject({ rule: "alice-to-b", candidates: ["claude:b"] });
    expect(await as(signer("bob")).submit(spec("say b"))).toMatchObject({ rule: "default" });
  });

  it("limits an own-scope client's audit view to itself", async () => {
    await start();
    await as(signer("alice")).submit(spec("say a"));
    await expect(as(signer("bob")).submit(spec("say b", { harness: "claude:a" }))).rejects.toThrow();
    const alice = as(signer("alice"));
    await expect(alice.audit()).rejects.toThrow(/may not call audit/);
    const opsView = await as(signer("ops")).audit({ client: "bob" });
    expect(opsView.map((a) => a.client)).toEqual(["bob"]);
  });

  it("accepts unsigned and signed calls when no clients are configured", async () => {
    const c = await start({ clients: {} });
    expect((await c.gateway.submit(spec("say open"))).id).toMatch(/^job-/);
    expect(await as(signer("alice")).list()).toHaveLength(1);
  });
});

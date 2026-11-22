import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTerminal, parseConfig, parseJobId, type CueConfigInput, type JobId, type JobResult } from "@cue/core";
import { claudeAdapter } from "@cue/harness";
import { openSqliteStore } from "@cue/store";
import { createNotifier, createScriptHookRunner, startCued, wants, type Cued } from "@cue/daemon";

const FAKE = fileURLToPath(new URL("./fixtures/fake-harness.mjs", import.meta.url));

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000, label = "condition"): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const result = (over: Partial<JobResult> = {}): JobResult => ({
  id: parseJobId("job-20261122-abcdef"),
  status: "succeeded",
  pool: "claude:a",
  exitCode: 0,
  error: null,
  report: "ok",
  costUsd: null,
  numTurns: null,
  sessionId: null,
  permissionDenials: 0,
  flags: [],
  startedAt: null,
  finishedAt: new Date().toISOString(),
  ...over,
});

describe("notification matching", () => {
  it("matches terminal, a status, or flagged results", () => {
    expect(wants({ on: ["terminal"] }, result({ status: "cancelled" }))).toBe(true);
    expect(wants({ on: ["failed", "timeout"] }, result())).toBe(false);
    expect(wants({ on: ["failed", "timeout"] }, result({ status: "timeout" }))).toBe(true);
    expect(wants({ on: ["flagged"] }, result())).toBe(false);
    expect(wants({ on: ["flagged"] }, result({ flags: ["permission-denied"] }))).toBe(true);
  });

  it("rejects unknown `on` values in config", () => {
    expect(() => parseConfig({ pools: [{ harness: "claude" }], notify: [{ kind: "webhook", url: "http://x.test", on: ["leased"] }] })).toThrow();
  });
});

describe("webhook delivery", () => {
  it("retries once on a 5xx and records the outcome", async () => {
    const store = openSqliteStore(":memory:");
    const r = result();
    store.insertJob({ id: r.id, spec: { prompt: "p", requester: "t", labels: [], priority: 50, meta: {} }, candidates: ["claude:a"] });
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 204 });
    };
    const config = parseConfig({ pools: [{ harness: "claude" }], notify: [{ kind: "webhook", url: "http://hooks.test/x" }] });
    const notify = createNotifier({ notifiers: config.notify, hooks: createScriptHookRunner(), store, fetch: fakeFetch, retryDelayMs: 1 });
    await notify({ result: r, jobDir: "/nowhere", resultPath: "/nowhere/result.json" });
    expect(calls).toBe(2);
    expect(store.readEvents({ jobId: r.id }).map((e) => e.type)).toEqual(["notified"]);

    calls = 0;
    const failing: typeof fetch = async () => {
      calls += 1;
      return new Response(null, { status: 400 });
    };
    await createNotifier({ notifiers: config.notify, hooks: createScriptHookRunner(), store, fetch: failing, retryDelayMs: 1 })({
      result: r,
      jobDir: "/nowhere",
      resultPath: "/nowhere/result.json",
    });
    expect(calls).toBe(1);
    expect(store.readEvents({ jobId: r.id }).at(-1)).toMatchObject({ type: "notify-failed", data: { error: "HTTP 400" } });
    store.close();
  });
});

describe("notifications end to end (fake harness)", () => {
  let dir: string;
  let cued: Cued | null = null;
  let server: Server | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cue-notify-"));
  });
  afterEach(async () => {
    await cued?.shutdown();
    cued = null;
    await new Promise((r) => (server ? server.close(r) : r(undefined)));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts to a webhook and runs a command; a failing notifier leaves the job status alone", async () => {
    const bodies: unknown[] = [];
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString()));
      req.on("end", () => {
        bodies.push({ auth: req.headers["authorization"], body: JSON.parse(data) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const copy = join(dir, "notified.json");
    const over: Partial<CueConfigInput> = {
      notify: [
        { kind: "webhook", url: `http://127.0.0.1:${port}/hook`, headers: { authorization: "Bearer t" } },
        { kind: "command", run: ["sh", "-c", `cp "$CUE_RESULT_JSON" ${copy}; echo "$CUE_HOOK" >> ${copy}.hook`], on: ["succeeded"] },
        { kind: "command", run: ["sh", "-c", "exit 7"], on: ["terminal"] },
      ],
    };
    const config = parseConfig({
      dataDir: join(dir, "data"),
      node: { id: "test-node" },
      limits: { tickMs: 40 },
      pools: [{ harness: "claude", account: "a", bin: [process.execPath, FAKE] }],
      ...over,
    });
    cued = await startCued({ config, adapters: [claudeAdapter], network: { kind: "local" } });
    const gw = cued.gateway;
    const id: JobId = (await gw.submit({ prompt: "say notified", requester: "t" })).id;
    const rec = await waitFor(async () => {
      const r = await gw.status(id);
      return r && isTerminal(r.status) ? r : undefined;
    });
    expect(rec.status).toBe("succeeded");
    const types = await waitFor(async () => {
      const t = (await gw.events({ id })).map((e) => e.type);
      return t.filter((x) => x === "notified" || x === "notify-failed").length === 3 ? t : undefined;
    });
    expect(types.filter((t) => t === "notified")).toHaveLength(2);
    expect(types.filter((t) => t === "notify-failed")).toHaveLength(1);
    expect((await gw.status(id))?.status).toBe("succeeded");
    expect(bodies).toEqual([{ auth: "Bearer t", body: { event: "job.finished", result: expect.objectContaining({ id, status: "succeeded" }) } }]);
    expect(JSON.parse(readFileSync(copy, "utf8"))).toMatchObject({ id, report: "notified" });
    expect(readFileSync(`${copy}.hook`, "utf8").trim()).toBe("notify");
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTerminal, parseConfig, type CueConfigInput, type JobId, type JobSpecInput } from "@cue/core";
import { claudeAdapter, codexAdapter } from "@cue/harness";
import { startCued, type Cued, type JobRecordView } from "@cue/daemon";

const FAKE = fileURLToPath(new URL("./fixtures/fake-harness.mjs", import.meta.url));
const adapterFixture = (path: string) => fileURLToPath(new URL(`../../harness/test/fixtures/${path}`, import.meta.url));
/** A "harness" that prints a recorded run and ignores the arguments the adapter adds. */
const replay = (path: string) => [process.execPath, "-e", "process.stdout.write(require('fs').readFileSync(process.argv[1]))", adapterFixture(path)];

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000, label = "condition"): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("cued end to end (fake harness)", () => {
  let dir: string;
  let cued: Cued | null = null;

  const config = (over: Partial<CueConfigInput> = {}) =>
    parseConfig({
      dataDir: join(dir, "data"),
      node: { id: "test-node" },
      limits: { tickMs: 40, leaseTtlSec: 2 },
      pools: [{ harness: "claude", account: "a", bin: [process.execPath, FAKE], concurrency: 2 }],
      ...over,
    });

  const start = async (over: Partial<CueConfigInput> = {}) => {
    cued = await startCued({ config: config(over), adapters: [claudeAdapter], network: { kind: "local" }, killGraceMs: 300 });
    return cued;
  };

  const gw = () => {
    if (!cued) throw new Error("not started");
    return cued.gateway;
  };

  const submit = async (prompt: string, over: Partial<JobSpecInput> = {}): Promise<JobId> =>
    (await gw().submit({ prompt, requester: "tester", ...over })).id;

  const status = async (id: JobId): Promise<JobRecordView> => {
    const rec = await gw().status(id);
    if (!rec) throw new Error(`no job ${id}`);
    return rec;
  };

  const settle = (id: JobId, timeoutMs = 10_000) =>
    waitFor(async () => {
      const rec = await status(id);
      return isTerminal(rec.status) ? rec : undefined;
    }, timeoutMs, `job ${id} to finish`);

  const eventTypes = async (id: JobId) => (await gw().events({ id })).map((e) => e.type);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cue-e2e-"));
  });
  afterEach(async () => {
    await cued?.shutdown();
    cued = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a job to success and records result, events, logs and result.json", async () => {
    await start();
    expect(await gw().ping()).toBe("pong");
    const id = await submit("say hello world");
    const rec = await settle(id);
    expect(rec).toMatchObject({ status: "succeeded", attempt: 1, pool: "claude:a", phase: "done" });
    expect(rec.result).toMatchObject({ report: "hello world", exitCode: 0, costUsd: 0.02, numTurns: 1, permissionDenials: 0, flags: [] });
    expect(rec.result?.sessionId).toMatch(/^fake-/);
    expect(await eventTypes(id)).toEqual(expect.arrayContaining(["submitted", "leased", "started", "session", "message", "result", "finished"]));
    expect((await gw().logs({ id, lines: 1 }))[0]).toContain('"type":"result"');
    const onDisk = JSON.parse(readFileSync(join(dir, "data", "jobs", id, "result.json"), "utf8"));
    expect(onDisk.status).toBe("succeeded");
  });

  it("rejects invalid specs and unroutable jobs", async () => {
    await start();
    await expect(gw().submit({ prompt: "" })).rejects.toThrow(/invalid job spec/);
    await expect(gw().submit({ prompt: "x", requester: "t", harness: "codex" })).rejects.toThrow(/no enabled pool/);
    await expect(gw().status("nope")).rejects.toThrow(/invalid job id/);
  });

  it("reports a failing harness as failed with its error", async () => {
    await start();
    const failed = await settle(await submit("say working; fail could not compile"));
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.result).toMatchObject({ error: "could not compile", exitCode: 1 });

    const silent = await settle(await submit("exit 3"));
    expect(silent.result?.error).toBe("harness exited with code 3");
  });

  it("flags permission denials even when the harness reports success", async () => {
    await start();
    const rec = await settle(await submit("deny Bash; say I could not run it"));
    expect(rec.status).toBe("succeeded");
    expect(rec.result).toMatchObject({ permissionDenials: 1, flags: ["permission-denied"] });
  });

  it("ends a job as blocked under the block policy, with a per-pool override", async () => {
    const fake = [process.execPath, FAKE];
    await start({
      safety: { onDenial: "block" },
      pools: [
        { harness: "claude", account: "a", bin: fake },
        { harness: "claude", account: "lenient", bin: fake, onDenial: "flag" },
      ],
    });
    const blocked = await settle(await submit("deny Bash; deny Edit; deny Bash; say I could not run it", { harness: "claude:a" }));
    expect(blocked.status).toBe("blocked");
    expect(blocked.result).toMatchObject({ status: "blocked", error: "blocked by 3 permission denials (Bash, Edit)", permissionDenials: 3, report: "I could not run it" });
    expect(blocked.result?.flags).toContain("permission-denied");

    // A harness error with denials is still blocked: the denials are the likely cause.
    expect((await settle(await submit("deny Bash; fail gave up", { harness: "claude:a" }))).status).toBe("blocked");
    expect((await settle(await submit("say clean", { harness: "claude:a" }))).status).toBe("succeeded");

    const lenient = await settle(await submit("deny Bash; say done anyway", { harness: "claude:lenient" }));
    expect(lenient.status).toBe("succeeded");
    expect(lenient.result?.flags).toContain("permission-denied");
  });

  it("replays the recorded Claude and Codex denial runs as blocked", async () => {
    cued = await startCued({
      config: config({
        safety: { onDenial: "block" },
        pools: [
          { harness: "claude", account: "a", bin: replay("claude/deny.jsonl") },
          { harness: "codex", bin: replay("codex/command-denied.jsonl") },
          { harness: "codex", account: "prose", bin: replay("codex/sandbox-refusal.jsonl") },
        ],
      }),
      adapters: [claudeAdapter, codexAdapter],
      network: { kind: "local" },
      killGraceMs: 300,
    });
    const claude = await settle(await submit("touch x.txt", { harness: "claude:a" }));
    expect(claude).toMatchObject({ status: "blocked", result: { permissionDenials: 1, error: "blocked by 1 permission denial (Bash)" } });
    const codex = await settle(await submit("touch /var/tmp/probe", { harness: "codex:default" }));
    expect(codex).toMatchObject({ status: "blocked", result: { permissionDenials: 1, error: "blocked by 1 permission denial (shell)" } });
    // A refusal only described in prose is flagged, not blocked.
    const prose = await settle(await submit("touch /var/tmp/probe", { harness: "codex:prose" }));
    expect(prose.status).toBe("succeeded");
    expect(prose.result?.flags).toContain("possible-sandbox-refusal");
  });

  it("cancels queued and running jobs, killing the harness", async () => {
    await start({ pools: [{ harness: "claude", account: "a", bin: [process.execPath, FAKE], concurrency: 1 }] });
    const running = await submit("say started; sleep 30");
    const queued = await submit("say never");
    await waitFor(async () => ((await status(running)).status === "running" ? true : undefined), 5000, "running");
    expect((await status(queued)).status).toBe("queued");

    expect(await gw().cancel(queued)).toMatchObject({ accepted: true, status: "cancelled" });
    const c = await gw().cancel(running);
    expect(c.accepted).toBe(true);
    const rec = await settle(running);
    expect(rec.status).toBe("cancelled");
    const started = (await gw().events({ id: running })).find((e) => e.type === "started");
    const data: unknown = started?.data;
    const pgid = typeof data === "object" && data !== null && "pgid" in data ? Number(data.pgid) : Number.NaN;
    expect(Number.isInteger(pgid)).toBe(true);
    expect(pidAlive(pgid)).toBe(false);
    expect((await gw().cancel(running)).accepted).toBe(false);
  });

  it("times out a run, escalating to SIGKILL when the harness ignores SIGTERM", async () => {
    await start();
    const rec = await settle(await submit("ignore-term; say busy; sleep 30", { maxMinutes: 0.005 }));
    expect(rec.status).toBe("timeout");
    expect(rec.result?.error).toMatch(/exceeded/);
  });

  it("requeues a rate-limited job without spending an attempt and pauses the account", async () => {
    await start();
    const id = await submit("ratelimit");
    await waitFor(async () => ((await eventTypes(id)).includes("requeued") ? true : undefined), 5000, "requeue");
    const rec = await status(id);
    expect(rec).toMatchObject({ status: "queued", attempt: 0 });
    const stats = await gw().stats();
    expect(stats.paused["claude:a"]).toBeGreaterThan(Date.now() + 30 * 60_000);
    await new Promise((r) => setTimeout(r, 300));
    expect((await status(id)).status).toBe("queued");
  });

  it("applies preRun output and runs postRun and onComplete hooks", async () => {
    const marker = join(dir, "hooks.log");
    const work = join(dir, "work");
    const hook = (script: string) => ({ run: ["sh", "-c", script] });
    await start({
      hooks: {
        preRun: [hook(`mkdir -p ${work}; printf '{"workdir":"${work}","env":{"GREETING":"hi from hook"},"promptAppend":"env GREETING"}'`)],
        postRun: [hook(`echo "post $CUE_JOB_ID $(cat $CUE_RESULT_JSON | grep -c succeeded)" >> ${marker}`)],
        onComplete: [hook(`echo "complete $CUE_JOB_ID" >> ${marker}`)],
      },
    });
    const id = await submit("pwd");
    const rec = await settle(id);
    expect(rec.status).toBe("succeeded");
    expect(rec.result?.report).toBe("hi from hook");
    expect(readFileSync(marker, "utf8")).toBe(`post ${id} 1\ncomplete ${id}\n`);
  });

  it("fails the job without starting the harness when a required preRun hook fails", async () => {
    const touched = join(dir, "touched");
    await start({ hooks: { preRun: [{ run: ["sh", "-c", "echo nope >&2; exit 4"] }] } });
    const rec = await settle(await submit(`touch ${touched}`));
    expect(rec.status).toBe("failed");
    expect(rec.result?.error).toMatch(/preRun hook sh exited 4: nope/);
    expect(existsSync(touched)).toBe(false);
  });

  it("respects pool concurrency", async () => {
    await start({ pools: [{ harness: "claude", account: "a", bin: [process.execPath, FAKE], concurrency: 1 }] });
    const a = await submit("sleep 0.5; say a");
    const b = await submit("say b");
    await waitFor(async () => ((await status(a)).status === "running" ? true : undefined));
    expect((await status(b)).status).toBe("queued");
    await settle(a);
    expect((await settle(b)).status).toBe("succeeded");
    expect(Date.parse((await status(b)).startedAt ?? "")).toBeGreaterThanOrEqual(Date.parse((await status(a)).finishedAt ?? ""));
  });

  it("survives a daemon restart mid-job by re-attaching to the running harness", async () => {
    await start();
    const id = await submit("say before; sleep 1.5; say after restart");
    await waitFor(async () => ((await eventTypes(id)).includes("message") ? true : undefined), 5000, "first output");
    await cued?.shutdown();
    cued = null;
    await new Promise((r) => setTimeout(r, 300));

    await start();
    const rec = await settle(id);
    expect(rec).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(rec.result?.report).toBe("after restart");
    const types = await eventTypes(id);
    expect(types).toEqual(expect.arrayContaining(["adopted", "reattached"]));
    expect(types.filter((t) => t === "started")).toHaveLength(1);
  });

  it("finishes a job whose harness exited while the daemon was down", async () => {
    await start();
    const id = await submit("say quick; sleep 0.3; say done");
    await waitFor(async () => ((await status(id)).status === "running" ? true : undefined));
    await cued?.shutdown();
    cued = null;
    await new Promise((r) => setTimeout(r, 800));
    await start();
    const rec = await settle(id);
    expect(rec).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(rec.result?.report).toBe("done");
  });

  it("requeues a job whose lease expired under another owner and runs it once", async () => {
    // Simulate a node that died holding a lease: lease the job directly as a stranger.
    const cfg = config();
    const { openSqliteStore } = await import("@cue/store");
    const { newJobId, JobSpecSchema } = await import("@cue/core");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cfg.dataDir, { recursive: true });
    const store = openSqliteStore(join(cfg.dataDir, "cue.db"));
    const jobId = newJobId();
    store.insertJob({ id: jobId, spec: JobSpecSchema.parse({ prompt: "say recovered", requester: "t" }), candidates: ["claude:a"] });
    store.leaseNext({ pool: "claude:a", owner: "dead-node", ttlMs: 1, now: Date.now() - 10_000 });
    store.close();

    await start();
    const rec = await settle(jobId);
    expect(rec).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(await eventTypes(jobId)).toContain("lease-expired");
  });

  it("writes job.json for hooks", async () => {
    const copy = join(dir, "job-copy.json");
    await start({ hooks: { preRun: [{ run: ["sh", "-c", `cp "$CUE_JOB_JSON" ${copy}`] }] } });
    const id = await submit("say x", { meta: { ticket: "T-1" } });
    await settle(id);
    const job = JSON.parse(readFileSync(copy, "utf8"));
    expect(job).toMatchObject({ id, attempt: 1, pool: "claude:a", spec: { meta: { ticket: "T-1" } } });
    writeFileSync(copy, "");
  });
});

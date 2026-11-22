import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobSpecSchema, parseJobId, type JobId, type JobResult, type JobSpecInput } from "@cue/core";
import { openSqliteStore, SQLITE_SCHEMA, StaleLeaseError, type Store } from "@cue/store";

let seq = 0;
const id = (): JobId => parseJobId(`job-20261120-${(++seq).toString(16).padStart(6, "0")}`);
const spec = (over: Partial<JobSpecInput> = {}) => JobSpecSchema.parse({ prompt: "do it", requester: "alice", ...over });

function result(jobId: JobId, status: JobResult["status"] = "succeeded"): JobResult {
  return {
    id: jobId,
    status,
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
  };
}

const T0 = 1_000_000;
const lease = (s: Store, pool = "claude:a", owner = "node-1", now = T0) => s.leaseNext({ pool, owner, ttlMs: 1000, now });

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/** Contract every Store implementation must satisfy. */
function storeContract(name: string, open: () => Store) {
  describe(`Store contract: ${name}`, () => {
    let s: Store;
    beforeEach(() => {
      s = open();
    });
    afterEach(() => s.close());

    it("inserts and reads back a queued job", () => {
      const j = id();
      const rec = s.insertJob({ id: j, spec: spec({ labels: ["x"] }), candidates: ["claude:a"] });
      expect(rec).toMatchObject({ id: j, status: "queued", attempt: 0, pool: null, cancelRequested: false, result: null });
      expect(s.getJob(j)?.spec.labels).toEqual(["x"]);
      expect(s.getJob(parseJobId("job-20261120-ffffff"))).toBeNull();
    });

    it("leases by priority then age, only for candidate pools", () => {
      const low = id();
      const high = id();
      const other = id();
      s.insertJob({ id: low, spec: spec({ priority: 90 }), candidates: ["claude:a"] });
      s.insertJob({ id: high, spec: spec({ priority: 10 }), candidates: ["claude:a", "claude:b"] });
      s.insertJob({ id: other, spec: spec({ priority: 0 }), candidates: ["codex:a"] });

      const first = lease(s);
      expect(first?.jobId).toBe(high);
      expect(first).toMatchObject({ owner: "node-1", fence: 1, expiresAt: T0 + 1000 });
      expect(s.getJob(high)).toMatchObject({ status: "leased", pool: "claude:a", attempt: 1 });
      expect(lease(s)?.jobId).toBe(low);
      expect(lease(s)).toBeNull();
      expect(lease(s, "codex:a")?.jobId).toBe(other);
    });

    it("walks phases, marks running and finishes", () => {
      const j = id();
      s.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
      const l = must(lease(s));
      s.setPhase({ lease: l, phase: "prepare" });
      expect(s.getJob(j)).toMatchObject({ status: "leased", phase: "prepare", startedAt: null });
      s.setPhase({ lease: l, phase: "run" });
      expect(s.getJob(j)?.status).toBe("running");
      expect(s.getJob(j)?.startedAt).not.toBeNull();
      s.finish({ lease: l, result: result(j) });
      const done = must(s.getJob(j));
      expect(done).toMatchObject({ status: "succeeded", phase: "done" });
      expect(done.result?.report).toBe("ok");
      expect(() => s.setPhase({ lease: l, phase: "post" })).toThrow(StaleLeaseError);
    });

    it("rejects a non-terminal finish", () => {
      const j = id();
      s.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
      const l = must(lease(s));
      expect(() => s.finish({ lease: l, result: { ...result(j), status: JSON.parse('"running"') } })).toThrow();
    });

    it("renews a live lease and rejects a forged one", () => {
      const j = id();
      s.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
      const l = must(lease(s));
      expect(s.renewLease({ lease: l, ttlMs: 5000, now: T0 + 500 }).expiresAt).toBe(T0 + 5500);
      expect(() => s.renewLease({ lease: { ...l, fence: l.fence + 1 }, ttlMs: 1, now: T0 })).toThrow(StaleLeaseError);
      expect(() => s.renewLease({ lease: { ...l, owner: "other" }, ttlMs: 1, now: T0 })).toThrow(StaleLeaseError);
    });

    it("reclaims expired leases exactly once and fences out the old holder", () => {
      const j = id();
      s.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
      const old = must(lease(s));
      expect(s.expiredLeases(T0 + 999)).toEqual([]);
      expect(s.expiredLeases(T0 + 1001).map((l) => l.jobId)).toEqual([j]);

      expect(s.reclaimExpired(T0 + 1001).map((l) => l.jobId)).toEqual([j]);
      expect(s.reclaimExpired(T0 + 1001)).toEqual([]);
      expect(s.getJob(j)).toMatchObject({ status: "queued", attempt: 1, pool: null });
      expect(() => s.setPhase({ lease: old, phase: "run" })).toThrow(StaleLeaseError);

      const next = must(lease(s, "claude:a", "node-2", T0 + 2000));
      expect(next.fence).toBeGreaterThan(old.fence);
      expect(s.getJob(j)?.attempt).toBe(2);
      expect(() => s.finish({ lease: old, result: result(j) })).toThrow(StaleLeaseError);
    });

    it("requeues with and without refunding the attempt", () => {
      const j = id();
      s.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
      s.requeue({ lease: must(lease(s)), refundAttempt: true });
      expect(s.getJob(j)).toMatchObject({ status: "queued", attempt: 0 });
      s.requeue({ lease: must(lease(s)) });
      expect(s.getJob(j)).toMatchObject({ status: "queued", attempt: 1 });
    });

    it("cancels queued jobs at once and flags running ones", () => {
      const queued = id();
      const running = id();
      s.insertJob({ id: queued, spec: spec({ priority: 99 }), candidates: ["claude:a"] });
      s.insertJob({ id: running, spec: spec({ priority: 1 }), candidates: ["claude:a"] });
      const l = must(lease(s));
      expect(l.jobId).toBe(running);

      expect(s.requestCancel(queued)).toMatchObject({ status: "cancelled", cancelRequested: true });
      expect(s.getJob(queued)?.result?.status).toBe("cancelled");
      expect(lease(s)).toBeNull();

      expect(s.requestCancel(running)).toMatchObject({ status: "leased", cancelRequested: true });
      s.finish({ lease: l, result: result(running, "cancelled") });
      expect(s.requestCancel(running)?.status).toBe("cancelled");
      expect(s.requestCancel(parseJobId("job-20261120-eeeeee"))).toBeNull();
    });

    it("turns an expired, cancel-requested lease into cancelled instead of requeueing", () => {
      const j = id();
      s.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
      lease(s);
      s.requestCancel(j);
      s.reclaimExpired(T0 + 5000);
      expect(s.getJob(j)).toMatchObject({ status: "cancelled", phase: "done" });
      expect(s.getJob(j)?.result?.flags).toContain("lease-expired");
    });

    it("lists newest first with status, requester and limit filters", () => {
      const a = id();
      const b = id();
      const c = id();
      s.insertJob({ id: a, spec: spec({ requester: "alice" }), candidates: ["claude:a"] });
      s.insertJob({ id: b, spec: spec({ requester: "bob" }), candidates: ["claude:a"] });
      s.insertJob({ id: c, spec: spec({ requester: "alice" }), candidates: ["claude:a"] });
      s.requestCancel(c);
      expect(s.listJobs({}).map((r) => r.id)).toEqual([c, b, a]);
      expect(s.listJobs({ requester: "alice" }).map((r) => r.id)).toEqual([c, a]);
      expect(s.listJobs({ status: ["queued"] }).map((r) => r.id)).toEqual([b, a]);
      expect(s.listJobs({ limit: 1 }).map((r) => r.id)).toEqual([c]);
    });

    it("lists a node's active leases and keeps fenced runtime data per attempt", () => {
      const j = id();
      s.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
      const l = must(lease(s));
      expect(s.activeLeases("node-1")).toEqual([{ ...l, pool: "claude:a" }]);
      expect(s.activeLeases("node-2")).toEqual([]);
      s.setRuntime({ lease: l, runtime: { pgid: 42, offset: 10 } });
      expect(s.getRuntime(j)).toEqual({ pgid: 42, offset: 10 });
      expect(() => s.setRuntime({ lease: { ...l, fence: 99 }, runtime: {} })).toThrow(StaleLeaseError);
      s.requeue({ lease: l });
      expect(s.getRuntime(j)).toBeNull();
      expect(s.activeLeases("node-1")).toEqual([]);
    });

    it("appends and pages events per job", () => {
      const j = id();
      const k = id();
      s.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
      s.insertJob({ id: k, spec: spec(), candidates: ["claude:a"] });
      const e1 = s.appendEvent({ jobId: j, type: "submitted", data: { by: "alice" } });
      s.appendEvent({ jobId: k, type: "submitted", data: null });
      const e3 = s.appendEvent({ jobId: j, type: "output", data: "line" });
      expect(s.readEvents({ jobId: j }).map((e) => e.type)).toEqual(["submitted", "output"]);
      expect(s.readEvents({ jobId: j })[0]?.data).toEqual({ by: "alice" });
      expect(s.readEvents({ jobId: j, afterSeq: e1.seq }).map((e) => e.seq)).toEqual([e3.seq]);
      expect(s.readEvents({ jobId: j, limit: 1 })).toHaveLength(1);
    });
  });
}

storeContract("sqlite :memory:", () => openSqliteStore(":memory:"));

describe("sqlite file store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cue-store-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  storeContract("sqlite file", () => openSqliteStore(join(dir, `cue-${++seq}.db`)));

  it("survives reopen, and two connections cannot both lease one job", () => {
    const path = join(dir, "shared.db");
    const a = openSqliteStore(path);
    const b = openSqliteStore(path);
    const j = id();
    a.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
    const la = lease(a, "claude:a", "a");
    const lb = lease(b, "claude:a", "b");
    expect([la, lb].filter(Boolean)).toHaveLength(1);
    a.close();
    b.close();

    const c = openSqliteStore(path);
    expect(c.getJob(j)?.status).toBe("leased");
    c.close();
  });

  it("migrates a v1 database by adding the runtime column", async () => {
    const path = join(dir, "v1.db");
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(SQLITE_SCHEMA.replace(",\n  runtime TEXT", ""));
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    const st = openSqliteStore(path);
    const j = id();
    st.insertJob({ id: j, spec: spec(), candidates: ["claude:a"] });
    st.setRuntime({ lease: must(lease(st)), runtime: { ok: true } });
    expect(st.getRuntime(j)).toEqual({ ok: true });
    st.close();
  });

  it("refuses a database from a newer schema", async () => {
    const path = join(dir, "future.db");
    openSqliteStore(path).close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => openSqliteStore(path)).toThrow(/newer/);
  });
});

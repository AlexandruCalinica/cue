import { rmSync } from "node:fs";
import { createActor, type ActorRef } from "libeam";
import { z } from "zod";
import { poolKey, TERMINAL_STATUSES, type HookConfig, type JobResult, type JobSpec, type PoolConfig, type TerminalStatus } from "@cue/core";
import type { HarnessEvent } from "@cue/harness";
import { StaleLeaseError, type Lease } from "@cue/store";
import type { HookPoint, PreRunOutput } from "../hooks.js";
import { tailLines, type LineTail } from "../process.js";
import { ensureDir, errorMessage, jobPaths, writeJson, type Runtime } from "../runtime.js";

/**
 * Per-attempt state kept in the store's `runtime` column, so a restarted
 * JobActor (after a crash or a daemon restart) continues where it stopped.
 */
const AttemptSchema = z.object({
  workdir: z.string().nullable(),
  prompt: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  resumeSession: z.string().nullable(),
  handle: z.object({ pgid: z.number(), unit: z.string().nullable() }).nullable(),
  offset: z.number(),
  runStartedAt: z.number().nullable(),
  killedFor: z.enum(["cancel", "timeout"]).nullable(),
  killSentAt: z.number().nullable(),
  escalated: z.boolean(),
  cancelSeen: z.boolean(),
  exitCode: z.number().nullable(),
  sessionId: z.string().nullable(),
  result: z
    .object({ ok: z.boolean(), text: z.string(), costUsd: z.number().nullable(), numTurns: z.number().nullable(), permissionDenials: z.number() })
    .nullable(),
  denials: z.number(),
  rateLimit: z.object({ resetsAt: z.string().nullable(), detail: z.string() }).nullable(),
  unparsed: z.number(),
  flags: z.array(z.string()),
  /** Outcome decided before the harness ran (preRun failure, cancel before start). */
  verdict: z.enum(TERMINAL_STATUSES).nullable(),
  error: z.string().nullable(),
});
type Attempt = z.infer<typeof AttemptSchema>;

const freshAttempt = (): Attempt => ({
  workdir: null,
  prompt: null,
  env: {},
  resumeSession: null,
  handle: null,
  offset: 0,
  runStartedAt: null,
  killedFor: null,
  killSentAt: null,
  escalated: false,
  cancelSeen: false,
  exitCode: null,
  sessionId: null,
  result: null,
  denials: 0,
  rateLimit: null,
  unparsed: 0,
  flags: [],
  verdict: null,
  error: null,
});

interface Prepared {
  readonly workdir: string;
  readonly env: Record<string, string>;
  readonly promptAppend: string[];
  readonly resumeSession: string | null;
  readonly flags: string[];
  readonly fatal: string | null;
}

const MESSAGE_EVENT_CHARS = 4000;

export function maxRunMs(spec: JobSpec, limits: Runtime["config"]["limits"]): number {
  return Math.min(spec.maxMinutes ?? limits.defaultMaxMinutes, limits.maxMaxMinutes) * 60_000;
}

/**
 * One attempt of one job: prepare (preRun hooks) → run (harness process) →
 * post (postRun hooks) → finalize (result.json, onComplete hooks, finish).
 * Each phase is written to the store before its side effects. Slow work runs
 * off the mailbox and reports back with a cast, so ticks keep renewing the
 * lease and noticing cancel requests.
 */
export const JobActor = createActor((ctx, self, rt: Runtime, initial: Lease, pool: PoolConfig, scheduler: ActorRef) => {
  let lease = initial;
  const id = initial.jobId;
  const key = poolKey(pool);
  const paths = jobPaths(rt.config.dataDir, id);
  const adapter = rt.adapters.get(pool.harness);
  const ttlMs = rt.config.limits.leaseTtlSec * 1000;
  const parsedRuntime = AttemptSchema.safeParse(rt.store.getRuntime(id));
  let st: Attempt = parsedRuntime.success ? parsedRuntime.data : freshAttempt();
  let tail: LineTail | null = null;
  let busy = false;
  let stopped = false;

  const persist = () => rt.store.setRuntime({ lease, runtime: st });
  const event = (type: string, data: unknown = null) => rt.store.appendEvent({ jobId: id, type, data });
  const send = (method: string, ...args: unknown[]) => ctx.self.cast({ method, args });
  const spec = (): JobSpec => {
    const rec = rt.store.getJob(id);
    if (!rec) throw new Error(`job ${id} vanished from the store`);
    return rec.spec;
  };

  function stop(reason: string): void {
    if (stopped) return;
    stopped = true;
    scheduler.cast({ method: "jobDone", args: [id, reason] });
    ctx.exit();
  }

  /** Runs a step; a lost lease stops the attempt, anything else fails the job through the normal phases. */
  function guard(step: () => void): void {
    if (stopped) return;
    try {
      step();
    } catch (err) {
      if (err instanceof StaleLeaseError) {
        // Someone else owns the job now; make sure our harness doesn't keep working on it.
        if (st.handle) rt.processes.kill(st.handle, "SIGKILL");
        event("lease-lost", { owner: lease.owner, fence: lease.fence });
        stop("lease-lost");
        return;
      }
      event("error", { message: errorMessage(err) });
      if (busy) return;
      try {
        if (st.verdict === null) {
          st = { ...st, verdict: "failed", error: errorMessage(err) };
          finalize();
        } else {
          stop("error");
        }
      } catch (inner) {
        event("error", { message: errorMessage(inner) });
        stop("error");
      }
    }
  }

  async function runHooks(point: HookPoint, hooks: readonly HookConfig[], workdir: string, resultPath?: string): Promise<{ outputs: PreRunOutput[]; failures: string[]; fatal: string | null }> {
    const outputs: PreRunOutput[] = [];
    const failures: string[] = [];
    let dir = workdir;
    for (const hook of hooks) {
      const outcome = await rt.hooks.run({
        hook,
        context: { point, jobId: id, jobDir: paths.dir, workdir: dir, ...(resultPath === undefined ? {} : { resultPath }) },
      });
      if (outcome.kind === "ok") {
        outputs.push(outcome.output);
        if (outcome.output.workdir !== undefined) dir = outcome.output.workdir;
        continue;
      }
      const what = outcome.kind === "timeout" ? "timed out" : `exited ${outcome.exitCode ?? "?"}: ${outcome.stderrTail.trim()}`;
      const msg = `${point} hook ${hook.run[0] ?? "?"} ${what}`;
      failures.push(msg);
      if (point === "preRun" && hook.required) return { outputs, failures, fatal: msg };
    }
    return { outputs, failures, fatal: null };
  }

  // --- prepare ---------------------------------------------------------------

  function prepare(): void {
    const s = spec();
    const rec = rt.store.getJob(id);
    rt.store.setPhase({ lease, phase: "prepare" });
    st = freshAttempt();
    ensureDir(paths.dir);
    writeJson(paths.jobJson, { id, attempt: rec?.attempt ?? null, pool: key, spec: s });
    const workdir = s.workdir ?? paths.dir;
    persist();
    busy = true;
    runHooks("preRun", rt.config.hooks.preRun, workdir)
      .then((r): Prepared => {
        const env: Record<string, string> = {};
        let dir = workdir;
        let resumeSession: string | null = null;
        const promptAppend: string[] = [];
        for (const o of r.outputs) {
          Object.assign(env, o.env ?? {});
          if (o.workdir !== undefined) dir = o.workdir;
          if (o.resumeSession !== undefined) resumeSession = o.resumeSession;
          if (o.promptAppend !== undefined && o.promptAppend !== "") promptAppend.push(o.promptAppend);
        }
        return { workdir: dir, env, promptAppend, resumeSession, flags: r.failures.length > 0 ? ["preRun-hook-failed"] : [], fatal: r.fatal };
      })
      .catch((err: unknown): Prepared => ({ workdir, env: {}, promptAppend: [], resumeSession: null, flags: [], fatal: `preRun: ${errorMessage(err)}` }))
      .then((p) => send("prepared", p));
  }

  function onPrepared(p: Prepared): void {
    busy = false;
    st = {
      ...st,
      workdir: p.workdir,
      env: p.env,
      resumeSession: p.resumeSession,
      prompt: [spec().prompt, ...p.promptAppend].join("\n\n"),
      flags: [...st.flags, ...p.flags],
    };
    if (p.fatal !== null) {
      st = { ...st, verdict: "failed", error: p.fatal };
      event("hook-failed", { point: "preRun", error: p.fatal });
    } else if (st.cancelSeen || rt.store.getJob(id)?.cancelRequested) {
      st = { ...st, verdict: "cancelled", error: "cancelled before the harness started" };
    }
    persist();
    if (st.verdict !== null) post();
    else startRun();
  }

  // --- run -------------------------------------------------------------------

  function startRun(): void {
    if (!adapter) throw new Error(`no adapter registered for harness ${pool.harness}`);
    const s = spec();
    const workdir = st.workdir ?? paths.dir;
    const inv = adapter.build({ jobId: id, spec: s, prompt: st.prompt ?? s.prompt, workdir, pool, resumeSession: st.resumeSession });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(rt.baseEnv)) if (v !== undefined) env[k] = v;
    Object.assign(env, pool.env, st.env, inv.env, { CUE_JOB_ID: id });

    rt.store.setPhase({ lease, phase: "run" });
    rmSync(paths.exitCode, { force: true });
    const handle = rt.processes.start({
      jobId: id,
      argv: inv.argv,
      cwd: workdir,
      env,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      exitCodePath: paths.exitCode,
      maxMinutes: maxRunMs(s, rt.config.limits) / 60_000,
    });
    st = { ...st, handle, offset: 0, runStartedAt: rt.now() };
    persist();
    event("started", { pool: key, pgid: handle.pgid, unit: handle.unit });
    tail = tailLines(paths.stdout, 0);
  }

  function resumeRun(): void {
    if (st.handle === null) {
      // Crashed between recording the phase and starting the process.
      startRun();
      return;
    }
    tail = tailLines(paths.stdout, st.offset);
    event("reattached", { pgid: st.handle.pgid, offset: st.offset });
  }

  function consume(lines: readonly string[]): void {
    if (!adapter) return;
    for (const line of lines) {
      for (const ev of adapter.parseLine(line)) record(ev);
    }
  }

  function record(ev: HarnessEvent): void {
    switch (ev.kind) {
      case "session":
        st = { ...st, sessionId: ev.sessionId };
        event("session", ev);
        return;
      case "message":
        event("message", { text: ev.text.slice(0, MESSAGE_EVENT_CHARS) });
        return;
      case "tool":
        event("tool", ev);
        return;
      case "denial":
        st = { ...st, denials: st.denials + 1 };
        event("denial", ev);
        return;
      case "rate_limit":
        // A later signal without a reset time (e.g. the result text) must not erase a known one.
        st = { ...st, rateLimit: { resetsAt: ev.resetsAt ?? st.rateLimit?.resetsAt ?? null, detail: ev.detail } };
        event("rate-limit", ev);
        return;
      case "result":
        st = {
          ...st,
          result: { ok: ev.ok, text: ev.text, costUsd: ev.costUsd, numTurns: ev.numTurns, permissionDenials: ev.permissionDenials },
        };
        event("result", { ok: ev.ok, costUsd: ev.costUsd, numTurns: ev.numTurns, permissionDenials: ev.permissionDenials });
        return;
      case "unparsed":
        st = { ...st, unparsed: st.unparsed + 1 };
        return;
    }
  }

  function kill(reason: "cancel" | "timeout"): void {
    if (st.handle === null) return;
    rt.processes.kill(st.handle, "SIGTERM");
    st = { ...st, killedFor: reason, killSentAt: rt.now() };
    persist();
    event("killing", { reason });
  }

  function poll(): void {
    const handle = st.handle;
    if (tail === null || handle === null) return;
    const before = tail.offset;
    consume(tail.read());
    const now = rt.now();

    if (st.killedFor === null) {
      if (rt.store.getJob(id)?.cancelRequested) kill("cancel");
      else if (st.runStartedAt !== null && now - st.runStartedAt > maxRunMs(spec(), rt.config.limits)) kill("timeout");
    } else if (!st.escalated && st.killSentAt !== null && now - st.killSentAt > rt.killGraceMs) {
      rt.processes.kill(handle, "SIGKILL");
      st = { ...st, escalated: true };
    }

    const status = rt.processes.status(handle, paths.exitCode);
    if (status.kind === "running") {
      if (tail.offset !== before) {
        st = { ...st, offset: tail.offset };
        persist();
      }
      return;
    }
    consume(tail.flush());
    st = { ...st, offset: tail.offset, exitCode: status.kind === "exited" ? status.exitCode : null };
    if (status.kind === "gone" && st.killedFor === null) st = { ...st, error: "harness process disappeared without an exit code" };
    tail = null;
    persist();
    post();
  }

  // --- post ------------------------------------------------------------------

  function decide(): { status: TerminalStatus; error: string | null } {
    if (st.verdict !== null) return { status: st.verdict, error: st.error };
    if (st.killedFor === "cancel") return { status: "cancelled", error: "cancelled while running" };
    if (st.killedFor === "timeout") return { status: "timeout", error: `exceeded ${maxRunMs(spec(), rt.config.limits) / 60_000} minutes` };
    if (st.exitCode === 0 && st.result?.ok === true) return { status: "succeeded", error: null };
    if (st.result !== null && !st.result.ok) return { status: "failed", error: st.result.text || "harness reported an error" };
    if (st.error !== null) return { status: "failed", error: st.error };
    if (st.exitCode !== 0) return { status: "failed", error: `harness exited with code ${st.exitCode ?? "unknown"}` };
    return { status: "failed", error: "harness exited without a result" };
  }

  function buildResult(decision: { status: TerminalStatus; error: string | null }, extraFlags: readonly string[] = []): JobResult {
    const denials = Math.max(st.denials, st.result?.permissionDenials ?? 0);
    const flags = new Set([...st.flags, ...extraFlags]);
    if (denials > 0) flags.add("permission-denied");
    if (st.unparsed > 0) flags.add("unparsed-output");
    return {
      id,
      status: decision.status,
      pool: key,
      exitCode: st.exitCode,
      error: decision.error,
      report: st.result?.text ?? null,
      costUsd: st.result?.costUsd ?? null,
      numTurns: st.result?.numTurns ?? null,
      sessionId: st.sessionId,
      permissionDenials: denials,
      flags: [...flags],
      startedAt: rt.store.getJob(id)?.startedAt ?? null,
      finishedAt: new Date(rt.now()).toISOString(),
    };
  }

  function post(): void {
    const killedOrDecided = st.verdict !== null || st.killedFor !== null;
    if (!killedOrDecided && st.rateLimit !== null && st.result?.ok !== true) {
      // Not the job's fault: put it back without spending an attempt and pause the account.
      event("requeued", { reason: "rate-limit", resetsAt: st.rateLimit.resetsAt });
      rt.store.requeue({ lease, refundAttempt: true });
      scheduler.cast({ method: "rateLimited", args: [key, st.rateLimit.resetsAt] });
      stop("rate-limited");
      return;
    }
    rt.store.setPhase({ lease, phase: "post" });
    writeJson(paths.resultJson, buildResult(decide()));
    busy = true;
    runHooks("postRun", rt.config.hooks.postRun, st.workdir ?? paths.dir, paths.resultJson)
      .then((r) => r.failures)
      .catch((err: unknown) => [`postRun: ${errorMessage(err)}`])
      .then((failures) => send("posted", failures));
  }

  function onPosted(failures: readonly string[]): void {
    busy = false;
    if (failures.length > 0) {
      st = { ...st, flags: [...st.flags, "postRun-hook-failed"] };
      event("hook-failed", { point: "postRun", errors: failures });
    }
    persist();
    finalize();
  }

  // --- finalize --------------------------------------------------------------

  function finalize(): void {
    rt.store.setPhase({ lease, phase: "finalize" });
    ensureDir(paths.dir);
    writeJson(paths.resultJson, buildResult(decide()));
    persist();
    busy = true;
    runHooks("onComplete", rt.config.hooks.onComplete, st.workdir ?? paths.dir, paths.resultJson)
      .then((r) => r.failures)
      .catch((err: unknown) => [`onComplete: ${errorMessage(err)}`])
      .then((failures) => send("completed", failures));
  }

  function onCompleted(failures: readonly string[]): void {
    busy = false;
    if (failures.length > 0) event("hook-failed", { point: "onComplete", errors: failures });
    const result = buildResult(decide(), failures.length > 0 ? ["onComplete-hook-failed"] : []);
    writeJson(paths.resultJson, result);
    rt.store.finish({ lease, result });
    event("finished", { status: result.status, flags: result.flags });
    stop("finished");
  }

  // --- driver ----------------------------------------------------------------

  function begin(): void {
    const rec = rt.store.getJob(id);
    if (!rec || rec.phase === "done") {
      stop("gone");
      return;
    }
    if (rec.phase === null && rec.attempt > rt.config.limits.maxAttempts) {
      st = { ...freshAttempt(), verdict: "failed", error: `gave up after ${rt.config.limits.maxAttempts} attempts` };
      finalize();
      return;
    }
    switch (rec.phase) {
      case null:
      case "prepare":
        prepare();
        return;
      case "run":
        resumeRun();
        return;
      case "post":
        // Re-run post hooks: they must be idempotent.
        post();
        return;
      case "finalize":
        finalize();
        return;
    }
  }

  function tick(): void {
    if (lease.expiresAt - rt.now() < ttlMs / 2) lease = rt.store.renewLease({ lease, ttlMs, now: rt.now() });
    if (busy) {
      if (!st.cancelSeen && rt.store.getJob(id)?.cancelRequested) st = { ...st, cancelSeen: true };
      return;
    }
    poll();
  }

  self.sendInterval({ method: "tick", args: [] }, rt.config.limits.tickMs);
  send("begin");

  return self
    .onCast("begin", () => guard(begin))
    .onCast("tick", () => guard(tick))
    .onCast("prepared", (p: Prepared) => guard(() => onPrepared(p)))
    .onCast("posted", (failures: string[]) => guard(() => onPosted(failures)))
    .onCast("completed", (failures: string[]) => guard(() => onCompleted(failures)))
    .onCall("state", () => ({ id, busy, stopped, phase: rt.store.getJob(id)?.phase ?? null }));
});

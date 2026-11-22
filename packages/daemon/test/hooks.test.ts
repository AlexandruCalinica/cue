import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newJobId, type HookConfig } from "@cue/core";
import { createScriptHookRunner, type HookContext, type HookPoint } from "@cue/daemon";

const hook = (script: string, over: Partial<HookConfig> = {}): HookConfig => ({
  run: ["sh", "-c", script],
  timeoutSec: 5,
  required: true,
  ...over,
});

describe("script hook runner", () => {
  let dir: string;
  const runner = createScriptHookRunner({ killGraceMs: 200 });
  const ctx = (point: HookPoint = "preRun", over: Partial<HookContext> = {}): HookContext => ({
    point,
    jobId: newJobId(),
    jobDir: join(dir, "job"),
    workdir: dir,
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cue-hook-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes context through CUE_* variables and parses preRun output", async () => {
    const c = ctx();
    const out = await runner.run({
      hook: hook(`printf '{"promptAppend":"%s|%s|%s|%s","env":{"A":"1"}}' "$CUE_JOB_ID" "$CUE_HOOK" "$CUE_JOB_JSON" "$PWD"`),
      context: c,
    });
    expect(out).toEqual({
      kind: "ok",
      output: { promptAppend: `${c.jobId}|preRun|${join(c.jobDir, "job.json")}|${dir}`, env: { A: "1" } },
    });
  });

  it("treats empty preRun output as no changes", async () => {
    expect(await runner.run({ hook: hook("true"), context: ctx() })).toEqual({ kind: "ok", output: {} });
  });

  it("rejects invalid JSON and unknown keys from preRun", async () => {
    const bad = await runner.run({ hook: hook("echo not-json"), context: ctx() });
    expect(bad).toMatchObject({ kind: "failed", exitCode: 0 });
    const unknown = await runner.run({ hook: hook(`echo '{"rm":"-rf"}'`), context: ctx() });
    expect(unknown).toMatchObject({ kind: "failed", stderrTail: expect.stringContaining("invalid preRun output") });
  });

  it("ignores stdout for other hook points and exposes CUE_RESULT_JSON", async () => {
    const out = await runner.run({
      hook: hook(`test "$CUE_RESULT_JSON" = /r.json && echo whatever`),
      context: ctx("postRun", { resultPath: "/r.json" }),
    });
    expect(out).toEqual({ kind: "ok", output: {} });
  });

  it("reports failures with a stderr tail", async () => {
    const runnerSmall = createScriptHookRunner({ stderrTailBytes: 8 });
    const out = await runnerSmall.run({ hook: hook("echo 0123456789abcdef >&2; exit 7"), context: ctx() });
    expect(out).toEqual({ kind: "failed", exitCode: 7, stderrTail: "9abcdef\n" });
  });

  it("reports an executable that cannot start", async () => {
    const out = await runner.run({ hook: { run: [join(dir, "nope")], timeoutSec: 5, required: true }, context: ctx() });
    expect(out).toMatchObject({ kind: "failed", exitCode: null });
  });

  it("times out, escalating to SIGKILL for the hook's whole process group", async () => {
    const pidFile = join(dir, "child.pid");
    const started = Date.now();
    const out = await runner.run({
      hook: hook(`trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`, { timeoutSec: 0.3 }),
      context: ctx(),
    });
    expect(out).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
    const { readFileSync } = await import("node:fs");
    const child = Number(readFileSync(pidFile, "utf8"));
    // The group ignored SIGTERM, so only the SIGKILL escalation can have ended it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    await new Promise((r) => setTimeout(r, 50));
    expect(() => process.kill(child, 0)).toThrow();
  });
});

import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import type { HookConfig, JobId } from "@cue/core";

/** Lifecycle points where org-specific behaviour plugs in. */
export type HookPoint = "preRun" | "postRun" | "onComplete";

/**
 * Hooks are plain executables. cue passes context through environment variables
 * and files, never through a shell:
 *   CUE_JOB_ID, CUE_HOOK, CUE_JOB_DIR, CUE_JOB_JSON (path to job.json),
 *   CUE_WORKDIR, CUE_RESULT_JSON (postRun/onComplete only).
 * A preRun hook may print one JSON object on stdout matching {@link PreRunOutput}.
 */
export interface HookContext {
  readonly point: HookPoint;
  readonly jobId: JobId;
  readonly jobDir: string;
  readonly workdir: string;
  /** Path to result.json; set for postRun and onComplete. */
  readonly resultPath?: string;
}

/** What a preRun hook may hand back (all optional). Unknown keys are rejected. */
export const PreRunOutputSchema = z
  .strictObject({
    /** Run the harness here instead (e.g. a freshly created git worktree). */
    workdir: z.string().min(1).optional(),
    /** Extra environment for the harness process. */
    env: z.record(z.string(), z.string()).readonly().optional(),
    /** Text appended to the prompt (e.g. generated instructions). */
    promptAppend: z.string().optional(),
    /** Harness session to resume (e.g. a follow-up on earlier work). */
    resumeSession: z.string().min(1).optional(),
  })
  .readonly();
export type PreRunOutput = z.infer<typeof PreRunOutputSchema>;

export type HookOutcome =
  | { readonly kind: "ok"; readonly output: PreRunOutput }
  | { readonly kind: "failed"; readonly exitCode: number | null; readonly stderrTail: string }
  | { readonly kind: "timeout" };

export interface HookRunner {
  run(input: { hook: HookConfig; context: HookContext }): Promise<HookOutcome>;
}

export interface ScriptHookRunnerOptions {
  /** Base environment for hooks (default: the daemon's own). CUE_* variables are added on top. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Grace between SIGTERM and SIGKILL on timeout. Default 5000 ms. */
  readonly killGraceMs?: number;
  /** Max stdout bytes kept for preRun output. Default 1 MiB. */
  readonly maxStdoutBytes?: number;
  /** Bytes of stderr kept for failure reports. Default 4 KiB. */
  readonly stderrTailBytes?: number;
}

function parsePreRun(stdout: string): { ok: true; output: PreRunOutput } | { ok: false; error: string } {
  const text = stdout.trim();
  if (text === "") return { ok: true, output: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "preRun stdout is not a JSON object" };
  }
  const parsed = PreRunOutputSchema.safeParse(value);
  return parsed.success ? { ok: true, output: parsed.data } : { ok: false, error: `invalid preRun output: ${z.prettifyError(parsed.error)}` };
}

/**
 * Runs hooks as plain executables without a shell, in their own process group
 * so a timeout kills everything they started.
 */
export function createScriptHookRunner(options: ScriptHookRunnerOptions = {}): HookRunner {
  const killGraceMs = options.killGraceMs ?? 5000;
  const maxStdout = options.maxStdoutBytes ?? 1024 * 1024;
  const tailBytes = options.stderrTailBytes ?? 4096;

  return {
    run({ hook, context }) {
      const [cmd, ...args] = hook.run;
      if (cmd === undefined) return Promise.resolve({ kind: "failed", exitCode: null, stderrTail: "hook has an empty run" });
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.baseEnv ?? process.env)) if (v !== undefined) env[k] = v;
      Object.assign(env, {
        CUE_JOB_ID: context.jobId,
        CUE_HOOK: context.point,
        CUE_JOB_DIR: context.jobDir,
        CUE_JOB_JSON: join(context.jobDir, "job.json"),
        CUE_WORKDIR: context.workdir,
      });
      if (context.resultPath !== undefined) env["CUE_RESULT_JSON"] = context.resultPath;

      return new Promise<HookOutcome>((resolve) => {
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let overflow = false;
        let timedOut = false;
        let settled = false;
        const done = (outcome: HookOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          resolve(outcome);
        };
        const tail = () => stderr.toString("utf8");

        const child = spawn(cmd, args, { cwd: context.workdir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        const signal = (sig: NodeJS.Signals) => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, sig);
          } catch {
            // already gone
          }
        };
        let killTimer: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          signal("SIGTERM");
          killTimer = setTimeout(() => {
            signal("SIGKILL");
            // Don't wait for "close": a process that left the group could hold the pipes open.
            done({ kind: "timeout" });
          }, killGraceMs);
        }, hook.timeoutSec * 1000);

        child.stdout.on("data", (chunk: Buffer) => {
          if (stdout.length + chunk.length > maxStdout) overflow = true;
          else stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = Buffer.concat([stderr, chunk]);
          if (stderr.length > tailBytes) stderr = stderr.subarray(stderr.length - tailBytes);
        });
        child.on("error", (err) => done({ kind: "failed", exitCode: null, stderrTail: `failed to start ${cmd}: ${err.message}` }));
        child.on("close", (code) => {
          if (timedOut) return done({ kind: "timeout" });
          if (code !== 0) return done({ kind: "failed", exitCode: code, stderrTail: tail() });
          if (context.point !== "preRun") return done({ kind: "ok", output: {} });
          if (overflow) return done({ kind: "failed", exitCode: 0, stderrTail: `preRun stdout exceeded ${maxStdout} bytes` });
          const parsed = parsePreRun(stdout.toString("utf8"));
          done(parsed.ok ? { kind: "ok", output: parsed.output } : { kind: "failed", exitCode: 0, stderrTail: parsed.error });
        });
      });
    },
  };
}

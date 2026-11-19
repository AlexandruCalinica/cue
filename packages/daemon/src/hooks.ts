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
}

/** What a preRun hook may hand back (all optional). Unknown keys are rejected. */
export interface PreRunOutput {
  /** Run the harness here instead (e.g. a freshly created git worktree). */
  readonly workdir?: string;
  /** Extra environment for the harness process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Text appended to the prompt (e.g. generated instructions). */
  readonly promptAppend?: string;
  /** Harness session to resume (e.g. a follow-up on earlier work). */
  readonly resumeSession?: string;
}

export type HookOutcome =
  | { readonly kind: "ok"; readonly output: PreRunOutput }
  | { readonly kind: "failed"; readonly exitCode: number | null; readonly stderrTail: string }
  | { readonly kind: "timeout" };

export interface HookRunner {
  run(input: { hook: HookConfig; context: HookContext }): Promise<HookOutcome>;
}

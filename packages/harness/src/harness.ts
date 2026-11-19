import type { PoolConfig } from "@cue/core";
import type { JobId, JobSpec } from "@cue/core";

/** Normalised events every adapter maps its own output onto. */
export type HarnessEvent =
  | { readonly kind: "session"; readonly sessionId: string; readonly model: string | null }
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string }
  | { readonly kind: "denial"; readonly tool: string; readonly detail: string }
  | { readonly kind: "rate_limit"; readonly resetsAt: string | null; readonly detail: string }
  | {
      readonly kind: "result";
      readonly ok: boolean;
      readonly text: string;
      readonly costUsd: number | null;
      readonly numTurns: number | null;
      readonly permissionDenials: number;
    }
  | { readonly kind: "unparsed"; readonly line: string };

export type HarnessEventKind = HarnessEvent["kind"];

/** What the daemon hands an adapter when it builds a command. */
export interface BuildInput {
  readonly jobId: JobId;
  readonly spec: JobSpec;
  /** The prompt after pre-run hooks appended their text. */
  readonly prompt: string;
  readonly workdir: string;
  readonly pool: PoolConfig;
  /** Session to resume, when a hook asked for one via `resumeSession`. */
  readonly resumeSession: string | null;
}

export interface Invocation {
  readonly argv: readonly [string, ...string[]];
  /** Extra environment on top of the daemon's, pool `env` and hook `env`. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A coding harness (Claude Code, Codex CLI, Cursor agent, ...). Adapters are pure:
 * they build a command and parse output lines. Starting, watching and killing
 * the process is the daemon's job, so every harness gets the same isolation.
 */
export interface HarnessAdapter {
  readonly id: string;
  /** Default executable when the pool sets no `bin`. */
  readonly defaultBin: readonly [string, ...string[]];
  build(input: BuildInput): Invocation;
  /** Map one stdout line to zero or more events. Must never throw. */
  parseLine(line: string): readonly HarnessEvent[];
}

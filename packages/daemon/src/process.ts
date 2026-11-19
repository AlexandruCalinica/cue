import type { CueConfig, JobId } from "@cue/core";

/**
 * How ProcessActor starts a harness. Output goes to files (not pipes) so a
 * daemon restart never kills the harness; the actor tails `stdoutPath`.
 */
export interface LaunchSpec {
  readonly jobId: JobId;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly exitCodePath: string;
  readonly maxMinutes: number;
}

/** Recorded in the store so a restarted daemon can reattach or reap. */
export interface ProcessHandle {
  readonly pgid: number;
  /** systemd scope unit when isolation is `systemd-scope`. */
  readonly unit: string | null;
}

export type ProcessStatus =
  | { readonly kind: "running" }
  | { readonly kind: "exited"; readonly exitCode: number | null }
  | { readonly kind: "gone" };

export interface ProcessController {
  start(spec: LaunchSpec): ProcessHandle;
  status(handle: ProcessHandle, exitCodePath: string): ProcessStatus;
  /** Kill the whole tree: `systemctl --user stop <unit>` or `kill(-pgid)`. */
  kill(handle: ProcessHandle): void;
}

export function scopeUnit(jobId: JobId): string {
  return `cue-${jobId}.scope`;
}

/** The outer argv: optional systemd-run scope, then a tiny sh wrapper that records the exit code. */
export function wrapArgv({ spec, isolation }: { spec: LaunchSpec; isolation: CueConfig["isolation"] }): string[] {
  const inner = ["sh", "-c", 'out="$1"; err="$2"; code="$3"; shift 3; "$@" >"$out" 2>"$err"; echo $? >"$code"', "cue-run", spec.stdoutPath, spec.stderrPath, spec.exitCodePath, ...spec.argv];
  switch (isolation.kind) {
    case "process-group":
      return inner;
    case "systemd-scope":
      return [
        "systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${scopeUnit(spec.jobId)}`,
        "-p", `MemoryMax=${isolation.memoryMax}`, "-p", `CPUQuota=${isolation.cpuQuota}`,
        "-p", `TasksMax=${isolation.tasksMax}`, "-p", `RuntimeMaxSec=${Math.ceil(spec.maxMinutes * 60) + 120}`,
        "--", ...inner,
      ];
    default: {
      const _exhaustive: never = isolation;
      return _exhaustive;
    }
  }
}

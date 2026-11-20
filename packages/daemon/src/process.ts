import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, fstatSync } from "node:fs";
import type { CueConfig, JobId } from "@cue/core";

/**
 * How ProcessActor starts a harness. Output goes to files (not pipes) so a
 * daemon restart never kills the harness; the actor tails `stdoutPath`.
 */
export interface LaunchSpec {
  readonly jobId: JobId;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  /** The complete environment of the harness process; nothing is inherited implicitly. */
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
  /**
   * Signal the whole tree: `kill(-pgid)`, plus `systemctl --user stop <unit>`
   * for SIGKILL under a scope. Default SIGTERM; callers escalate to SIGKILL.
   */
  kill(handle: ProcessHandle, signal?: NodeJS.Signals): void;
}

export function scopeUnit(jobId: JobId): string {
  return `cue-${jobId}.scope`;
}

/** The outer argv: optional systemd-run scope, then a tiny sh wrapper that records the exit code. */
export function wrapArgv({ spec, isolation }: { spec: LaunchSpec; isolation: CueConfig["isolation"] }): string[] {
  const inner = ["sh", "-c", 'out="$1"; err="$2"; code="$3"; shift 3; "$@" >"$out" 2>"$err"; echo $? >"$code.tmp" && mv "$code.tmp" "$code"', "cue-run", spec.stdoutPath, spec.stderrPath, spec.exitCodePath, ...spec.argv];
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

/** Reads the exit code the wrapper wrote atomically, or `undefined` if it hasn't. */
function readExitCode(path: string): number | null | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
  const code = Number.parseInt(text, 10);
  return Number.isFinite(code) ? code : null;
}

/** True while any process in the group exists. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the pgid was reused by another user's process, so ours is gone too.
    return false;
  }
}

/**
 * The real controller. Each harness runs detached in its own process group
 * (and, with `systemd-scope`, its own transient scope unit) with stdio sent
 * to files, so the daemon can restart without taking harnesses down.
 */
export function createProcessController(isolation: CueConfig["isolation"]): ProcessController {
  return {
    start(spec) {
      const [cmd, ...args] = wrapArgv({ spec, isolation });
      if (cmd === undefined) throw new Error("empty argv");
      const child = spawn(cmd, args, { cwd: spec.cwd, env: { ...spec.env }, detached: true, stdio: "ignore" });
      const pid = child.pid;
      if (pid === undefined) throw new Error(`failed to start ${spec.argv[0]} for ${spec.jobId}`);
      // libuv still reaps the child on exit, so a finished group doesn't linger as a zombie.
      child.on("error", () => undefined);
      child.unref();
      return { pgid: pid, unit: isolation.kind === "systemd-scope" ? scopeUnit(spec.jobId) : null };
    },

    status(handle, exitCodePath) {
      const before = readExitCode(exitCodePath);
      if (before !== undefined) return { kind: "exited", exitCode: before };
      if (groupAlive(handle.pgid)) return { kind: "running" };
      // The wrapper may have written the code between the two checks.
      const after = readExitCode(exitCodePath);
      return after !== undefined ? { kind: "exited", exitCode: after } : { kind: "gone" };
    },

    kill(handle, signal = "SIGTERM") {
      if (handle.unit !== null && signal === "SIGKILL") {
        spawnSync("systemctl", ["--user", "stop", handle.unit], { stdio: "ignore", timeout: 10_000 });
      }
      try {
        process.kill(-handle.pgid, signal);
      } catch {
        // already gone
      }
    },
  };
}

/** Incremental reader for a growing output file; only complete lines are returned. */
export interface LineTail {
  /** Byte offset of the first byte not yet returned (persist it to resume after restart). */
  readonly offset: number;
  /** Reads newly appended complete lines. */
  read(): string[];
  /** Returns everything left, including a trailing partial line (call once the process exited). */
  flush(): string[];
}

export function tailLines(path: string, offset = 0, chunkBytes = 64 * 1024): LineTail {
  let pos = offset;
  let pending = Buffer.alloc(0);

  const pull = (): void => {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(chunkBytes);
      while (pos + pending.length < size) {
        const n = readSync(fd, buf, 0, buf.length, pos + pending.length);
        if (n <= 0) break;
        pending = Buffer.concat([pending, buf.subarray(0, n)]);
      }
    } finally {
      closeSync(fd);
    }
  };

  const take = (all: boolean): string[] => {
    const end = all ? pending.length : pending.lastIndexOf(0x0a) + 1;
    if (end <= 0) return [];
    const text = pending.subarray(0, end).toString("utf8");
    pending = pending.subarray(end);
    pos += end;
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };

  return {
    get offset() {
      return pos;
    },
    read() {
      pull();
      return take(false);
    },
    flush() {
      pull();
      return take(true);
    },
  };
}

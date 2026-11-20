import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolKey, type CueConfig, type JobId, type PoolConfig } from "@cue/core";
import type { HarnessAdapter } from "@cue/harness";
import type { Store } from "@cue/store";
import type { HookRunner } from "./hooks.js";
import type { ProcessController } from "./process.js";

/** Everything the actors share. Built once by {@link startCued}; actors receive it as a spawn arg. */
export interface Runtime {
  readonly config: CueConfig;
  readonly store: Store;
  readonly adapters: ReadonlyMap<string, HarnessAdapter>;
  readonly processes: ProcessController;
  readonly hooks: HookRunner;
  /** Lease owner for this node. Stable across restarts so a restarted daemon adopts its own jobs. */
  readonly owner: string;
  readonly pools: ReadonlyMap<string, PoolConfig>;
  /** Base environment for harness processes (default: the daemon's own). */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Grace between SIGTERM and SIGKILL when stopping a harness. */
  readonly killGraceMs: number;
  readonly now: () => number;
}

export function poolMap(config: CueConfig): Map<string, PoolConfig> {
  return new Map(config.pools.map((p) => [poolKey(p), p]));
}

/** Per-job files: `<dataDir>/jobs/<id>/{job.json,stdout,stderr,exit-code,result.json}`. */
export interface JobPaths {
  readonly dir: string;
  readonly jobJson: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: string;
  readonly resultJson: string;
}

export function jobPaths(dataDir: string, id: JobId): JobPaths {
  const dir = join(dataDir, "jobs", id);
  return {
    dir,
    jobJson: join(dir, "job.json"),
    stdout: join(dir, "stdout"),
    stderr: join(dir, "stderr"),
    exitCode: join(dir, "exit-code"),
    resultJson: join(dir, "result.json"),
  };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Last `n` lines of a file, or `[]` if it doesn't exist. */
export function lastLines(path: string, n: number): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return n <= 0 ? [] : lines.slice(-n);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

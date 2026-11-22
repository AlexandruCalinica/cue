import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Helpers for running the built `cued` and `cue` binaries against each other. */
export const root = fileURLToPath(new URL("../../..", import.meta.url));
export const CUED = join(root, "packages/daemon/dist/cued.js");
export const CUE = join(root, "packages/cli/dist/cue.js");
export const FAKE = join(root, "packages/daemon/test/fixtures/fake-harness.mjs");
export const COOKIE = "test-cookie-0123456789abcdef";

export interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function buildAll(): void {
  execFileSync("npx", ["tsc", "-b", "packages/core", "packages/store", "packages/harness", "packages/router", "packages/daemon", "packages/cli"], {
    cwd: root,
    stdio: "inherit",
  });
}

export function runCue(args: readonly string[], env: NodeJS.ProcessEnv, input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CUE, ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

export interface Daemon {
  readonly dir: string;
  /** Environment for `cue` pointing at this daemon. */
  readonly env: NodeJS.ProcessEnv;
  log(): string;
  stop(): Promise<void>;
}

/** Starts `cued` with one fake-harness pool plus `extraYaml` lines, in a fresh temp dir. */
export async function startDaemon(prefix: string, extraYaml: (dir: string) => readonly string[] = () => []): Promise<Daemon> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const port = 30000 + 3 * Math.floor(Math.random() * 3000);
  writeFileSync(
    join(dir, "cue.yaml"),
    [
      `dataDir: ${join(dir, "data")}`,
      "node: { id: cli-test-node, port: " + port + ", bindAddress: 127.0.0.1, gossipIntervalMs: 100 }",
      "limits: { tickMs: 50 }",
      "pools:",
      `  - { harness: claude, account: a, bin: [${JSON.stringify(process.execPath)}, ${JSON.stringify(FAKE)}] }`,
      ...extraYaml(dir),
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, CUE_COOKIE: COOKIE, CUE_SEEDS: `127.0.0.1:${port + 2}`, CUE_REQUESTER: "cli-tester" };
  let log = "";
  const daemon: ChildProcess = spawn(process.execPath, [CUED, join(dir, "cue.yaml")], { env, stdio: ["ignore", "ignore", "pipe"] });
  daemon.stderr?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  const until = Date.now() + 15_000;
  while (!log.includes("up;")) {
    if (Date.now() > until || daemon.exitCode !== null) throw new Error(`cued did not start: ${log}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    dir,
    env,
    log: () => log,
    async stop() {
      if (daemon.exitCode === null) {
        const exited = new Promise((r) => daemon.once("exit", r));
        daemon.kill("SIGTERM");
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

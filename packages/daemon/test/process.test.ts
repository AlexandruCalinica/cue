import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newJobId } from "@cue/core";
import { createProcessController, tailLines, type LaunchSpec, type ProcessHandle } from "@cue/daemon";

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const groupAlive = (h: ProcessHandle) => {
  try {
    process.kill(-h.pgid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("process-group controller", () => {
  let dir: string;
  const ctl = createProcessController({ kind: "process-group" });
  const handles: ProcessHandle[] = [];
  const spec = (script: string): LaunchSpec => ({
    jobId: newJobId(),
    argv: ["sh", "-c", script],
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    stdoutPath: join(dir, "stdout"),
    stderrPath: join(dir, "stderr"),
    exitCodePath: join(dir, "exit-code"),
    maxMinutes: 1,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cue-proc-"));
  });
  afterEach(() => {
    for (const h of handles.splice(0)) ctl.kill(h, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs to completion, recording output and the exit code", async () => {
    const s = spec("echo one; echo two; echo oops >&2; exit 3");
    const h = ctl.start(s);
    handles.push(h);
    const status = await waitFor(() => {
      const st = ctl.status(h, s.exitCodePath);
      return st.kind === "running" ? undefined : st;
    });
    expect(status).toEqual({ kind: "exited", exitCode: 3 });
    expect(tailLines(s.stdoutPath).flush()).toEqual(["one", "two"]);
    expect(readFileSync(s.stderrPath, "utf8")).toBe("oops\n");
  });

  it("runs with only the given environment and in the given cwd", async () => {
    const s = spec('echo "$PWD:${HOME:-unset}:$CUE_X"');
    const h = ctl.start({ ...s, env: { ...s.env, CUE_X: "x" } });
    handles.push(h);
    await waitFor(() => (ctl.status(h, s.exitCodePath).kind === "exited" ? true : undefined));
    expect(tailLines(s.stdoutPath).flush()).toEqual([`${dir}:unset:x`]);
  });

  it("kills the whole process tree, including background children", async () => {
    const s = spec("sleep 30 & sleep 30 & wait");
    const h = ctl.start(s);
    handles.push(h);
    expect(ctl.status(h, s.exitCodePath)).toEqual({ kind: "running" });
    ctl.kill(h);
    await waitFor(() => (groupAlive(h) ? undefined : true));
    expect(ctl.status(h, s.exitCodePath)).toEqual({ kind: "gone" });
  });

  it("reports a dead group with no exit code as gone", () => {
    expect(ctl.status({ pgid: 2 ** 22 + 12345, unit: null }, join(dir, "missing"))).toEqual({ kind: "gone" });
  });
});

describe("tailLines", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cue-tail-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns only complete lines and resumes from a saved offset", () => {
    const path = join(dir, "out");
    const t = tailLines(path, 0, 4);
    expect(t.read()).toEqual([]);
    writeFileSync(path, "alpha\nbe");
    expect(t.read()).toEqual(["alpha"]);
    expect(t.offset).toBe(6);
    appendFileSync(path, "ta\n{\"x\":1}\npartial");
    expect(t.read()).toEqual(["beta", '{"x":1}']);

    const resumed = tailLines(path, t.offset);
    expect(resumed.read()).toEqual([]);
    expect(resumed.flush()).toEqual(["partial"]);
    expect(resumed.flush()).toEqual([]);
  });

  it("keeps multi-byte characters split across chunks intact", () => {
    const path = join(dir, "utf8");
    writeFileSync(path, "héllo wörld ✓\n");
    expect(tailLines(path, 0, 3).read()).toEqual(["héllo wörld ✓"]);
  });
});

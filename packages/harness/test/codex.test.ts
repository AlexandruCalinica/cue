import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JobSpecSchema, newJobId, parseConfig } from "@cue/core";
import { codexAdapter, codexResetsAt, type HarnessEvent } from "@cue/harness";

const fixture = (name: string): HarnessEvent[] =>
  readFileSync(new URL(`./fixtures/codex/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .flatMap((line) => codexAdapter.parseLine(line));

const poolWith = (extra: Record<string, unknown>) => {
  const pool = parseConfig({ pools: [{ harness: "codex", ...extra }] }).pools[0];
  if (!pool) throw new Error("no pool");
  return pool;
};

const build = (extra: Record<string, unknown>, resumeSession: string | null = null) =>
  codexAdapter.build({
    jobId: newJobId(),
    spec: JobSpecSchema.parse({ prompt: "hello", requester: "bot-a" }),
    prompt: "-hello",
    workdir: "/w",
    pool: poolWith(extra),
    resumeSession,
  }).argv;

describe("codex adapter", () => {
  it("builds a non-interactive json command with a workspace-write sandbox by default", () => {
    expect(build({ model: "gpt-x" })).toEqual([
      "codex", "exec", "--json", "--skip-git-repo-check", "-C", "/w", "--sandbox", "workspace-write", "--model", "gpt-x", "--", "-hello",
    ]);
  });

  it("puts exec options before resume and maps options", () => {
    const argv = build({ options: { bypassSandbox: true, config: { "model_reasoning_effort": '"low"' } } }, "t-1");
    expect(argv).toEqual([
      "codex", "exec", "--json", "--skip-git-repo-check", "-C", "/w", "--dangerously-bypass-approvals-and-sandbox",
      "-c", 'model_reasoning_effort="low"', "resume", "t-1", "--", "-hello",
    ]);
  });

  it("rejects unknown or invalid options", () => {
    expect(() => codexAdapter.validateOptions?.({ sandbox: "yolo" })).toThrow();
    expect(() => codexAdapter.validateOptions?.({ nope: 1 })).toThrow();
    expect(() => codexAdapter.validateOptions?.({ sandbox: "read-only" })).not.toThrow();
  });

  it("parses a recorded successful run; the result defers to the last message", () => {
    const events = fixture("ok");
    expect(events[0]).toEqual({ kind: "session", sessionId: "00000000-0000-7000-8000-000000000001", model: null });
    expect(events).toContainEqual({ kind: "message", text: "cue works" });
    expect(events.at(-1)).toEqual({ kind: "result", ok: true, text: null, costUsd: null, numTurns: 1, permissionDenials: 0 });
    expect(events.some((e) => e.kind === "unparsed")).toBe(false);
  });

  it("maps shell commands to tool events", () => {
    const events = fixture("tool");
    expect(events.filter((e) => e.kind === "tool")).toEqual([{ kind: "tool", name: "shell" }]);
    expect(events.filter((e) => e.kind === "message")).toHaveLength(2);
    expect(events.some((e) => e.kind === "unparsed")).toBe(false);
  });

  it("reports a failed turn as a not-ok result, ignoring non-fatal error items", () => {
    const events = fixture("error-model");
    expect(events.some((e) => e.kind === "unparsed" || e.kind === "rate_limit")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "result", ok: false, text: expect.stringContaining("not supported") });
  });

  it("detects usage limits and their retry time", () => {
    const events = fixture("rate-limited");
    const limits = events.filter((e) => e.kind === "rate_limit");
    expect(limits.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ kind: "result", ok: false });
    expect(codexResetsAt("try again in 2 hours 5 minutes.", 0)).toBe(new Date(2 * 3_600_000 + 5 * 60_000).toISOString());
    expect(codexResetsAt("try again in 1 day, 3 hours and 2 mins", 0)).toBe(new Date(86_400_000 + 3 * 3_600_000 + 2 * 60_000).toISOString());
    expect(codexResetsAt("try again later", 0)).toBeNull();
  });

  it("never throws and marks unknown output as unparsed", () => {
    for (const line of ["not json", "[1]", "null", '{"type":"item.completed","item":{"type":"brand_new"}}']) {
      expect(() => codexAdapter.parseLine(line)).not.toThrow();
    }
    expect(codexAdapter.parseLine('{"type":"brand_new"}')).toEqual([{ kind: "unparsed", line: '{"type":"brand_new"}' }]);
    expect(codexAdapter.parseLine('{"type":"item.completed","item":{"type":"reasoning","text":"x"}}')).toEqual([]);
    expect(codexAdapter.parseLine('{"type":"item.completed","item":{"type":"mcp_tool_call","server":"gh","tool":"search"}}')).toEqual([
      { kind: "tool", name: "gh.search" },
    ]);
  });
});

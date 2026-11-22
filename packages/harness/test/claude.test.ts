import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JobSpecSchema, newJobId, parseConfig } from "@cue/core";
import { claudeAdapter, type HarnessEvent } from "@cue/harness";

const fixture = (name: string): HarnessEvent[] =>
  readFileSync(new URL(`./fixtures/claude/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .flatMap((line) => claudeAdapter.parseLine(line));

describe("claude adapter", () => {
  it("builds a headless stream-json command", () => {
    const pool = parseConfig({ pools: [{ harness: "claude", model: "some-model" }] }).pools[0];
    if (!pool) throw new Error("no pool");
    const spec = JobSpecSchema.parse({ prompt: "hello", requester: "bot-a" });
    const { argv } = claudeAdapter.build({ jobId: newJobId(), spec, prompt: "hello", workdir: "/tmp", pool, resumeSession: "s-1" });
    expect(argv).toEqual(["claude", "-p", "hello", "--output-format", "stream-json", "--verbose", "--resume", "s-1", "--model", "some-model"]);
  });

  it("parses a recorded successful run", () => {
    const events = fixture("ok");
    expect(events[0]).toMatchObject({ kind: "session", model: "claude-haiku-5-5" });
    expect(events).toContainEqual({ kind: "message", text: "hello" });
    expect(events.at(-1)).toMatchObject({ kind: "result", ok: true, text: "hello", numTurns: 1, permissionDenials: 0 });
    expect(events.filter((e) => e.kind === "unparsed" || e.kind === "rate_limit")).toEqual([]);
  });

  it("surfaces permission denials from a recorded run that still reports success", () => {
    const events = fixture("deny");
    expect(events).toContainEqual({ kind: "tool", name: "Bash" });
    expect(events.filter((e) => e.kind === "denial")).toEqual([expect.objectContaining({ kind: "denial", tool: "Bash" })]);
    expect(events.at(-1)).toMatchObject({ kind: "result", ok: true, permissionDenials: 1 });
    expect(events.some((e) => e.kind === "unparsed")).toBe(false);
  });

  it("detects a rejected rate limit with its reset time", () => {
    const limits = fixture("rate-limited").filter((e) => e.kind === "rate_limit");
    expect(limits[0]).toEqual({ kind: "rate_limit", resetsAt: new Date(1795204800 * 1000).toISOString(), detail: "five_hour limit rejected" });
    expect(fixture("rate-limited").at(-1)).toMatchObject({ kind: "result", ok: false });
  });

  it("reports error results as not ok", () => {
    expect(fixture("error-max-turns").at(-1)).toMatchObject({ kind: "result", ok: false, text: "error_max_turns" });
  });

  it("parses the legacy usage-limit text", () => {
    const events = claudeAdapter.parseLine(
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1795204800" }),
    );
    expect(events[0]).toMatchObject({ kind: "rate_limit", resetsAt: new Date(1795204800 * 1000).toISOString() });
  });

  it("never throws and marks garbage as unparsed", () => {
    for (const line of ["not json", "[1,2]", "null", '{"type":"brand_new"}', '{"type":"assistant","message":{"content":"x"}}']) {
      expect(() => claudeAdapter.parseLine(line)).not.toThrow();
    }
    expect(claudeAdapter.parseLine("not json")).toEqual([{ kind: "unparsed", line: "not json" }]);
    expect(claudeAdapter.parseLine('{"type":"brand_new"}')).toEqual([{ kind: "unparsed", line: '{"type":"brand_new"}' }]);
    expect(claudeAdapter.parseLine("   ")).toEqual([]);
  });
});

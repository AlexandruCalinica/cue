import { describe, expect, it } from "vitest";
import { describeWait, formatStats, parseCommand } from "@cue/cli";

describe("cli", () => {
  it("parses the verbs", () => {
    expect(parseCommand(["status", "job-20261119-abcdef", "--json"])).toEqual({ kind: "status", id: "job-20261119-abcdef", json: true });
    expect(parseCommand(["logs", "job-20261119-abcdef", "-n", "5"])).toEqual({ kind: "logs", id: "job-20261119-abcdef", lines: 5 });
    expect(parseCommand(["stats", "--json"])).toEqual({ kind: "stats", json: true });
    expect(parseCommand([])).toEqual({ kind: "help" });
  });

  it("describes why a queued job waits", () => {
    expect(describeWait({ kind: "pool", pool: "claude:a", blocker: "paused", until: Date.parse("2026-11-22T15:00:00Z") })).toBe(
      "pool claude:a paused after a rate limit until 2026-11-22T15:00:00.000Z",
    );
    expect(describeWait({ kind: "pool", pool: "codex:default", blocker: "over-budget", until: null })).toBe("pool codex:default over its spend budget");
    expect(describeWait({ kind: "lane", lane: "team", blocker: "full" })).toBe("lane team at its concurrency limit");
    expect(describeWait({ kind: "queue", pool: "claude:a" })).toBe("pool claude:a has room; other jobs are ahead");
  });

  it("formats stats as tables", () => {
    const now = Date.parse("2026-11-22T12:00:00Z");
    const text = formatStats(
      {
        running: { "claude:a": ["job-20261122-aaaaaa"] },
        paused: { "claude:b": now + 60_000, "claude:c": now - 1 },
        budgets: { "claude:a": { spentUsd: 1.5, limitUsd: 2, exceeded: false } },
        lanes: { team: { active: 1, concurrency: 2, enabled: true } },
      },
      now,
    );
    expect(text).toContain("claude:a  1        -");
    expect(text).toContain("$1.50 / $2.00");
    expect(text).toMatch(/claude:b\s+0\s+until 2026-11-22T12:01:00.000Z/);
    expect(text).toMatch(/claude:c\s+0\s+-/);
    expect(text).toMatch(/team\s+1\s+2\s+yes/);
  });
});

import { describe, expect, it } from "vitest";
import { JobSpecSchema, parseConfig } from "@cue/core";
import { canStart, EMPTY_QUOTA, recordRateLimit, route } from "@cue/router";

const config = parseConfig({
  pools: [{ harness: "claude", account: "a" }, { harness: "codex" }],
  routing: [{ name: "cheap-investigations", match: { labels: ["investigate"] }, use: ["codex", "claude"] }],
});

describe("router", () => {
  it("applies the first matching rule", () => {
    const spec = JobSpecSchema.parse({ prompt: "x", requester: "bot", labels: ["investigate"] });
    expect(route(spec, config)).toEqual({ rule: "cheap-investigations", candidates: ["codex:default", "claude:a"] });
  });

  it("pauses an account after a rate limit", () => {
    const now = 1_000;
    const paused = recordRateLimit({ state: EMPTY_QUOTA, resetsAt: null, now });
    expect(canStart({ state: paused, rule: undefined, now: now + 1 })).toBe(false);
  });
});

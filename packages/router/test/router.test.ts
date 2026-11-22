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

  it("matches rules on the verified client and filters candidates by the client's allow-list", () => {
    const cfg = parseConfig({
      pools: [{ harness: "claude", account: "a" }, { harness: "claude", account: "b" }, { harness: "codex" }],
      routing: [{ name: "bots", match: { client: ["bot"] }, use: ["codex", "claude:a"] }],
    });
    const spec = JobSpecSchema.parse({ prompt: "x", requester: "bot" });
    // `requester` is self-asserted, so it doesn't satisfy `match.client`.
    expect(route(spec, cfg).rule).toBe("default");
    expect(route(spec, cfg, { client: "bot" })).toEqual({ rule: "bots", candidates: ["codex:default", "claude:a"] });
    expect(route(spec, cfg, { client: "bot", allow: ["claude"] })).toEqual({ rule: "bots", candidates: ["claude:a"] });
    // A rule left with no allowed pool falls through to the next one.
    expect(route(spec, cfg, { client: "bot", allow: ["claude:b"] })).toEqual({ rule: "default", candidates: ["claude:b"] });
    const pinned = JobSpecSchema.parse({ prompt: "x", requester: "bot", harness: "codex" });
    expect(route(pinned, cfg, { allow: ["claude"] }).candidates).toEqual([]);
  });

  it("pauses an account after a rate limit", () => {
    const now = 1_000;
    const paused = recordRateLimit({ state: EMPTY_QUOTA, resetsAt: null, now });
    expect(canStart({ state: paused, rule: undefined, now: now + 1 })).toBe(false);
  });
});

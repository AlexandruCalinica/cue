import { describe, expect, it } from "vitest";
import { isTerminal, newJobId, parseConfig, poolKey, JobSpecSchema } from "@cue/core";

describe("core", () => {
  it("parses a minimal cue.yaml with defaults", () => {
    const config = parseConfig({ pools: [{ harness: "claude" }] });
    expect(config.pools.map(poolKey)).toEqual(["claude:default"]);
    expect(config.isolation.kind).toBe("process-group");
    expect(config.limits.defaultMaxMinutes).toBe(60);
  });

  it("rejects duplicate pools", () => {
    expect(() => parseConfig({ pools: [{ harness: "claude" }, { harness: "claude" }] })).toThrow(/duplicate pool/);
  });

  it("validates job specs and ids", () => {
    const spec = JobSpecSchema.parse({ prompt: "fix the flaky test", requester: "bot-a" });
    expect(spec.priority).toBe(50);
    expect(newJobId()).toMatch(/^job-\d{8}-[0-9a-f]{6}$/);
    expect(isTerminal("timeout")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});

describe("cue.example.yaml", () => {
  it("is a valid config", async () => {
    const { loadConfig } = await import("@cue/core");
    const config = loadConfig(new URL("../../../cue.example.yaml", import.meta.url).pathname);
    expect(config.pools).toHaveLength(2);
    expect(config.isolation.kind).toBe("systemd-scope");
  });
});

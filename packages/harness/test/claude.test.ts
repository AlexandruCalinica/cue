import { describe, expect, it } from "vitest";
import { JobSpecSchema, newJobId, parseConfig } from "@cue/core";
import { claudeAdapter } from "@cue/harness";

describe("claude adapter (scaffold)", () => {
  it("builds a headless stream-json command", () => {
    const pool = parseConfig({ pools: [{ harness: "claude", model: "some-model" }] }).pools[0];
    if (!pool) throw new Error("no pool");
    const spec = JobSpecSchema.parse({ prompt: "hello", requester: "bot-a" });
    const { argv } = claudeAdapter.build({ jobId: newJobId(), spec, prompt: "hello", workdir: "/tmp", pool, resumeSession: null });
    expect(argv).toEqual(["claude", "-p", "hello", "--output-format", "stream-json", "--verbose", "--model", "some-model"]);
  });
});

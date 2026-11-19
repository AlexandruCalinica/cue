import { describe, expect, it } from "vitest";
import { parseCommand } from "@cue/cli";

describe("cli", () => {
  it("parses the verbs", () => {
    expect(parseCommand(["status", "job-20261119-abcdef", "--json"])).toEqual({ kind: "status", id: "job-20261119-abcdef", json: true });
    expect(parseCommand(["logs", "job-20261119-abcdef", "-n", "5"])).toEqual({ kind: "logs", id: "job-20261119-abcdef", lines: 5 });
    expect(parseCommand([])).toEqual({ kind: "help" });
  });
});

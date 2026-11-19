import type { HarnessAdapter, HarnessEvent } from "../harness.js";

/**
 * Claude Code in headless mode (`claude -p ... --output-format stream-json`).
 * `build` is real; `parseLine` is a stub until M1 adds fixture-backed parsing.
 */
export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  defaultBin: ["claude"],
  build({ prompt, pool, resumeSession }) {
    const bin = pool.bin ?? claudeAdapter.defaultBin;
    const [exe, ...pre] = bin;
    if (exe === undefined) throw new Error("empty bin");
    const argv: [string, ...string[]] = [exe, ...pre, "-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (resumeSession !== null) argv.push("--resume", resumeSession);
    if (pool.model !== undefined) argv.push("--model", pool.model);
    return { argv, env: {} };
  },
  parseLine(line): readonly HarnessEvent[] {
    return line.trim() === "" ? [] : [{ kind: "unparsed", line }];
  },
};

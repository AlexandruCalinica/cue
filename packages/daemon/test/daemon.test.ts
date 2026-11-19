import { describe, expect, it } from "vitest";
import { newJobId } from "@cue/core";
import { GATEWAY_NAME, scopeUnit, wrapArgv } from "@cue/daemon";

describe("daemon (scaffold)", () => {
  it("wraps a harness in a systemd user scope with limits", () => {
    const jobId = newJobId();
    const argv = wrapArgv({
      spec: { jobId, argv: ["claude", "-p", "hi"], cwd: "/tmp", env: {}, stdoutPath: "o", stderrPath: "e", exitCodePath: "c", maxMinutes: 1 },
      isolation: { kind: "systemd-scope", memoryMax: "2G", cpuQuota: "100%", tasksMax: 64 },
    });
    expect(argv.slice(0, 3)).toEqual(["systemd-run", "--user", "--scope"]);
    expect(argv).toContain(`--unit=${scopeUnit(jobId)}`);
    expect(argv.slice(-3)).toEqual(["claude", "-p", "hi"]);
    expect(GATEWAY_NAME).toBe("cue.gateway");
  });
});

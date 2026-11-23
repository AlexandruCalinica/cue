import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAll, CUE, runCue, startDaemon, type Daemon, type Run } from "./support.js";

/**
 * Real binaries over the network: `cued` (built dist) runs as its own process
 * with a YAML config, and the `cue` CLI joins the libeam cluster as a client
 * node with the shared cookie.
 */
describe("cue CLI against a real cued", () => {
  let daemon: Daemon;
  let env: NodeJS.ProcessEnv;
  const cue = (args: string[], input?: string): Promise<Run> => runCue(args, env, input);

  beforeAll(async () => {
    buildAll();
    daemon = await startDaemon("cue-cli-");
    env = daemon.env;
    expect(daemon.log()).toMatch(/warning: no clients configured/);
  }, 120_000);

  afterAll(async () => {
    await daemon?.stop();
  });

  it("submits from stdin, then shows status, list and logs", async () => {
    const submitted = await cue(["submit"], JSON.stringify({ prompt: "say hello over the wire" }));
    expect(submitted.stderr).toBe("");
    expect(submitted.code).toBe(0);
    const id = submitted.stdout.trim();
    expect(id).toMatch(/^job-\d{8}-[0-9a-f]+$/);

    let status: Run = { code: 1, stdout: "", stderr: "" };
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      status = await cue(["status", id, "--json"]);
      if (status.code === 0 && JSON.parse(status.stdout).status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const rec = JSON.parse(status.stdout);
    expect(rec).toMatchObject({ id, status: "succeeded", spec: { requester: "cli-tester" }, result: { report: "hello over the wire" } });

    const human = await cue(["status", id]);
    expect(human.stdout).toContain(`${id}  succeeded`);
    expect(human.stdout).toContain("hello over the wire");

    const list = await cue(["list", "-n", "5"]);
    expect(list.stdout.split("\n")[0]).toMatch(/^ID\s+STATUS\s+POOL/);
    expect(list.stdout).toContain(id);

    const logs = await cue(["logs", id, "-n", "1"]);
    expect(logs.stdout).toContain('"type":"result"');
  }, 60_000);

  it("cancels a running job", async () => {
    const id = (await cue(["submit"], JSON.stringify({ prompt: "say working; sleep 30" }))).stdout.trim();
    const cancel = await cue(["cancel", id]);
    expect(cancel.code).toBe(0);
    expect(cancel.stdout).toContain("cancel accepted");
    const until = Date.now() + 20_000;
    let state = "";
    while (Date.now() < until) {
      state = JSON.parse((await cue(["status", id, "--json"])).stdout).status;
      if (state === "cancelled") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(state).toBe("cancelled");
  }, 60_000);

  it("reports gateway errors and connection problems on stderr", async () => {
    const bad = await cue(["submit"], JSON.stringify({ prompt: "" }));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/invalid job spec/);

    const unknown = await cue(["status", "job-20261120-ffffff"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/no such job/);

    const wrongCookie = await new Promise<Run>((resolve) => {
      execFile(process.execPath, [CUE, "list"], { env: { ...env, CUE_COOKIE: "wrong-cookie-0123456789", CUE_CONNECT_TIMEOUT_MS: "2000" }, timeout: 30_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? 1 : 0, stdout, stderr }),
      );
    });
    expect(wrongCookie.code).toBe(1);
    expect(wrongCookie.stderr).toMatch(/no cue.gateway reachable/);
  }, 60_000);
});

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAll, runCue, startDaemon, type Daemon, type Run } from "./support.js";

/** `cue keygen`, then signed calls from the real CLI to a `cued` that requires client signatures. */
describe("cue CLI with client keys", () => {
  let daemon: Daemon;
  let keyDir = "";
  const pub: Record<string, string> = {};
  let files: Record<string, string> = {};

  const keygen = async (dir: string, name: string): Promise<void> => {
    const file = join(dir, `${name}.pem`);
    const r = await runCue(["keygen", "--out", file], process.env);
    expect(r.code).toBe(0);
    pub[name] = /public key: (\S+)/.exec(r.stderr)?.[1] ?? "";
    files[name] = file;
  };
  const as = (name: string | null, keyName = name): NodeJS.ProcessEnv => {
    const { CUE_CLIENT: _c, CUE_KEY_FILE: _k, ...base } = daemon.env;
    return name === null ? base : { ...base, CUE_CLIENT: name, CUE_KEY_FILE: files[keyName ?? name] ?? "" };
  };
  const cue = (who: string | null, args: string[], input?: string, keyName?: string): Promise<Run> => runCue(args, as(who, keyName), input);

  beforeAll(async () => {
    buildAll();
    // Keys are made with the CLI before the daemon config can name them.
    keyDir = mkdtempSync(join(tmpdir(), "cue-keys-"));
    files = {};
    for (const name of ["dev", "ops", "stranger"]) await keygen(keyDir, name);
    daemon = await startDaemon("cue-cli-auth-", () => [
      "clients:",
      `  dev: { publicKey: ${pub["dev"]} }`,
      `  ops: { publicKey: ${pub["ops"]}, verbs: [status, list, stats, audit], scope: all }`,
    ]);
  }, 120_000);

  afterAll(async () => {
    await daemon?.stop();
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  });

  it("writes the private key with mode 0600 and refuses to overwrite it", async () => {
    const file = files["dev"] ?? "";
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("BEGIN PRIVATE KEY");
    expect(pub["dev"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await runCue(["keygen", "--out", file], process.env)).code).toBe(1);
  });

  it("accepts signed calls and rejects unsigned or wrong-key ones", async () => {
    expect(daemon.log()).not.toMatch(/no clients configured/);
    const submitted = await cue("dev", ["submit"], JSON.stringify({ prompt: "say signed" }));
    expect(submitted.stderr).toBe("");
    const id = submitted.stdout.trim();
    expect(id).toMatch(/^job-/);
    expect(JSON.parse((await cue("dev", ["status", id, "--json"])).stdout)).toMatchObject({ id, client: "dev" });
    expect((await cue("dev", ["status", id])).stdout).toContain("client dev  requester cli-tester");

    const unsigned = await cue(null, ["list"]);
    expect(unsigned.code).toBe(1);
    expect(unsigned.stderr).toMatch(/unauthorized: unsigned request/);

    const wrongKey = await cue("dev", ["list"], undefined, "stranger");
    expect(wrongKey.code).toBe(1);
    expect(wrongKey.stderr).toMatch(/bad signature/);

    const forbidden = await cue("ops", ["submit"], JSON.stringify({ prompt: "say nope" }));
    expect(forbidden.stderr).toMatch(/may not call submit/);

    const stats = await cue("ops", ["stats"]);
    expect(stats.stdout).toMatch(/^POOL\s+RUNNING/);

    const audit = await cue("ops", ["audit", "-n", "10"]);
    expect(audit.stdout.split("\n")[0]).toMatch(/^AT\s+CLIENT\s+METHOD\s+RESULT/);
    expect(audit.stdout).toMatch(/dev\s+submit\s+ok\s+job-/);
    expect(audit.stdout).toMatch(/dev\s+list\s+denied\s+-\s+unauthorized: bad signature/);
  }, 60_000);

  it("needs both CUE_CLIENT and CUE_KEY_FILE", async () => {
    const r = await runCue(["list"], { ...as(null), CUE_CLIENT: "dev" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/both CUE_CLIENT and CUE_KEY_FILE/);
  });
});

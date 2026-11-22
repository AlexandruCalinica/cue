import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTerminal, parseConfig, type CueConfigInput, type JobId, type JobSpecInput } from "@cue/core";
import { claudeAdapter } from "@cue/harness";
import { z } from "zod";
import { startCued, type Cued, type JobRecordView } from "@cue/daemon";

/** The parts of `stats` these tests read. */
const StatsSchema = z.object({
  paused: z.record(z.string(), z.number().nullable()),
  budgets: z.record(z.string(), z.object({ spentUsd: z.number(), limitUsd: z.number(), exceeded: z.boolean() })),
  lanes: z.record(z.string(), z.object({ active: z.number(), concurrency: z.number().nullable(), enabled: z.boolean() })),
});

const FAKE = fileURLToPath(new URL("./fixtures/fake-harness.mjs", import.meta.url));
const bin = [process.execPath, FAKE];

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000, label = "condition"): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("routing, pauses, budgets and lanes (fake harness)", () => {
  let dir: string;
  let cued: Cued | null = null;

  const start = async (over: Partial<CueConfigInput>) => {
    const config = parseConfig({ dataDir: join(dir, "data"), node: { id: "test-node" }, limits: { tickMs: 40, leaseTtlSec: 2 }, pools: [], ...over });
    cued = await startCued({ config, adapters: [claudeAdapter], network: { kind: "local" }, killGraceMs: 300 });
    return cued;
  };
  const gw = () => {
    if (!cued) throw new Error("not started");
    return cued.gateway;
  };
  const submit = async (prompt: string, over: Partial<JobSpecInput> = {}): Promise<JobId> => (await gw().submit({ prompt, requester: "tester", ...over })).id;
  const status = async (id: JobId): Promise<JobRecordView> => {
    const rec = await gw().status(id);
    if (!rec) throw new Error(`no job ${id}`);
    return rec;
  };
  const settle = (id: JobId) =>
    waitFor(async () => {
      const rec = await status(id);
      return isTerminal(rec.status) ? rec : undefined;
    }, 10_000, `job ${id}`);
  const runningOn = (id: JobId) => waitFor(async () => ((await status(id)).status === "running" ? (await status(id)).pool : undefined), 5000, `${id} running`);
  const stats = async () => StatsSchema.parse(await gw().stats());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cue-routing-"));
  });
  afterEach(async () => {
    await cued?.shutdown();
    cued = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps work on the preferred pool and falls back only when it is full", async () => {
    // `b` is listed first in pools, but the rule prefers `a`.
    await start({
      pools: [
        { harness: "claude", account: "b", bin, concurrency: 1 },
        { harness: "claude", account: "a", bin, concurrency: 1 },
      ],
      routing: [{ name: "prefer-a", use: ["claude:a", "claude:b"] }],
    });
    const first = await submit("say one; sleep 1.5");
    expect(await runningOn(first)).toBe("claude:a");
    const second = await submit("say two; sleep 1.5");
    expect(await runningOn(second)).toBe("claude:b");
    expect((await settle(first)).status).toBe("succeeded");
    expect((await settle(second)).status).toBe("succeeded");
    const third = await settle(await submit("say three"));
    expect(third.pool).toBe("claude:a");
  });

  it("falls back from a rate-limited pool and keeps the pause across a restart", async () => {
    const over: Partial<CueConfigInput> = {
      pools: [
        { harness: "claude", account: "a", bin, env: { LIMITED: "1" } },
        { harness: "claude", account: "b", bin },
      ],
      routing: [{ name: "prefer-a", use: ["claude:a", "claude:b"] }],
    };
    await start(over);
    const id = await submit("ratelimit-if LIMITED; say done elsewhere");
    const rec = await settle(id);
    // The rate-limited attempt on `a` is refunded.
    expect(rec).toMatchObject({ status: "succeeded", pool: "claude:b", attempt: 1 });
    expect((await gw().events({ id })).map((e) => e.type)).toContain("requeued");
    expect((await stats()).paused["claude:a"]).toBeGreaterThan(Date.now());

    await cued?.shutdown();
    cued = null;
    await start(over);
    expect((await stats()).paused["claude:a"]).toBeGreaterThan(Date.now());
    const next = await settle(await submit("say still b"));
    expect(next.pool).toBe("claude:b");
  });

  it("pauses a pool once its spend budget is used up", async () => {
    // Each fake run costs $0.02; a $0.03 budget allows two runs on `a`.
    await start({
      pools: [
        { harness: "claude", account: "a", bin, budget: { usd: 0.03, windowSec: 3600 } },
        { harness: "claude", account: "b", bin },
      ],
      routing: [{ name: "prefer-a", use: ["claude:a", "claude:b"] }],
    });
    const pools: (string | null)[] = [];
    for (const n of [1, 2, 3]) pools.push((await settle(await submit(`say ${n}`))).pool);
    expect(pools).toEqual(["claude:a", "claude:a", "claude:b"]);
    expect((await stats()).budgets["claude:a"]).toMatchObject({ limitUsd: 0.03, exceeded: true });
    expect((await stats()).budgets["claude:a"]?.spentUsd).toBeCloseTo(0.04);
  });

  it("caps a lane across pools and holds jobs in a disabled lane", async () => {
    await start({
      pools: [
        { harness: "claude", account: "a", bin, concurrency: 2 },
        { harness: "claude", account: "b", bin, concurrency: 2 },
      ],
      lanes: { team: { concurrency: 1 }, frozen: { concurrency: 5, enabled: false } },
    });
    const one = await submit("say one; sleep 1", { lane: "team" });
    const two = await submit("say two; sleep 1", { lane: "team" });
    const free = await submit("say free; sleep 1");
    const held = await submit("say held", { lane: "frozen" });
    await runningOn(one);
    await runningOn(free);
    expect((await status(two)).status).toBe("queued");
    expect((await stats()).lanes["team"]).toEqual({ active: 1, concurrency: 1, enabled: true });
    expect((await settle(two)).status).toBe("succeeded");
    expect((await status(held)).status).toBe("queued");
  });
});

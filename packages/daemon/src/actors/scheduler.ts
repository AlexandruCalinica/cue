import { createActor, type ActorRef } from "libeam";
import { budgetWindowStart, canStart, EMPTY_QUOTA, overBudget, recordRateLimit, recordStart, type QuotaState } from "@cue/router";
import type { JobId } from "@cue/core";
import type { Lease } from "@cue/store";
import { errorMessage, type Runtime } from "../runtime.js";
import { JobActor } from "./job.js";

interface Running {
  readonly pool: string;
  readonly ref: ActorRef;
}

export interface SchedulerStats {
  readonly running: Readonly<Record<string, readonly string[]>>;
  /** Rate-limit pauses (epoch ms), including ones that already ended. */
  readonly paused: Readonly<Record<string, number | null>>;
  /** Spend in the current window for pools with a budget. */
  readonly budgets: Readonly<Record<string, { readonly spentUsd: number; readonly limitUsd: number; readonly exceeded: boolean }>>;
  /** Leased or running jobs per lane, with each configured lane's cap. */
  readonly lanes: Readonly<Record<string, { readonly active: number; readonly concurrency: number | null; readonly enabled: boolean }>>;
}

/**
 * Pulls queued jobs from the store into per-pool JobActors. Concurrency,
 * quota, rate-limit pauses, spend budgets and lane caps are enforced here; the
 * store's lease is the source of truth, so a JobActor that dies is recovered
 * when its lease expires.
 *
 * Routing preference: a job only goes to a later candidate pool while every
 * pool it prefers is unavailable (full, paused, over budget or disabled).
 *
 * Plays the QueueProducer and QuotaActor roles from the original design: the
 * store is polled on every tick and on `poke`, rather than through GenStage
 * demand, because the queue lives in SQLite.
 */
export const Scheduler = createActor((ctx, self, rt: Runtime) => {
  const running = new Map<JobId, Running>();
  const quotas = new Map<string, QuotaState>();
  // Pauses survive restarts; pools no longer configured are ignored.
  for (const [pool, until] of Object.entries(rt.store.poolPauses())) {
    if (rt.pools.has(pool)) quotas.set(pool, { ...EMPTY_QUOTA, pausedUntil: until });
  }

  const count = (pool: string) => [...running.values()].filter((r) => r.pool === pool).length;

  function spawnJob(lease: Lease, pool: string): void {
    const cfg = rt.pools.get(pool);
    if (!cfg) {
      rt.store.appendEvent({ jobId: lease.jobId, type: "error", data: { message: `unknown pool ${pool}` } });
      rt.store.requeue({ lease, refundAttempt: true });
      return;
    }
    const ref = ctx.spawn(JobActor, { args: [rt, lease, cfg, ctx.self] });
    ctx.watch(ref);
    running.set(lease.jobId, { pool, ref });
  }

  /** Re-attaches to jobs this node held before a restart. */
  function adopt(): void {
    const ttlMs = rt.config.limits.leaseTtlSec * 1000;
    for (const held of rt.store.activeLeases(rt.owner)) {
      if (running.has(held.jobId)) continue;
      try {
        const lease = rt.store.renewLease({ lease: held, ttlMs, now: rt.now() });
        rt.store.appendEvent({ jobId: lease.jobId, type: "adopted", data: { owner: rt.owner } });
        spawnJob(lease, held.pool);
      } catch (err) {
        rt.store.appendEvent({ jobId: held.jobId, type: "error", data: { message: `adopt failed: ${errorMessage(err)}` } });
      }
    }
  }

  function spentUsd(key: string, now: number): number | null {
    const budget = rt.pools.get(key)?.budget;
    return budget ? rt.store.spendSince({ pool: key, since: budgetWindowStart(budget, now) }) : null;
  }

  function blockedLanes(counts: Readonly<Record<string, number>>): string[] {
    return Object.entries(rt.config.lanes)
      .filter(([name, lane]) => !lane.enabled || (counts[name] ?? 0) >= lane.concurrency)
      .map(([name]) => name);
  }

  function schedule(): void {
    const now = rt.now();
    for (const lease of rt.store.reclaimExpired(now)) {
      running.delete(lease.jobId);
      rt.store.appendEvent({ jobId: lease.jobId, type: "lease-expired", data: { owner: lease.owner, fence: lease.fence } });
    }
    const overSpent = new Set([...rt.pools.keys()].filter((key) => overBudget(rt.pools.get(key)?.budget, spentUsd(key, now) ?? 0)));
    const available = (key: string): boolean => {
      const pool = rt.pools.get(key);
      if (!pool?.enabled || count(key) >= pool.concurrency || overSpent.has(key)) return false;
      return canStart({ state: quotas.get(key) ?? EMPTY_QUOTA, rule: pool.rate, now });
    };
    const laneCounts: Record<string, number> = { ...rt.store.activeLaneCounts() };
    const ttlMs = rt.config.limits.leaseTtlSec * 1000;

    // Repeat until no pool can take anything: a pool filling up can make jobs
    // that preferred it eligible for a pool visited earlier in this pass.
    for (let progress = true; progress; ) {
      progress = false;
      for (const key of rt.pools.keys()) {
        if (!available(key)) continue;
        const lease = rt.store.leaseNext({
          pool: key,
          owner: rt.owner,
          ttlMs,
          now,
          available: [...rt.pools.keys()].filter(available),
          blockedLanes: blockedLanes(laneCounts),
        });
        if (lease === null) continue;
        const pool = rt.pools.get(key);
        quotas.set(key, recordStart({ state: quotas.get(key) ?? EMPTY_QUOTA, rule: pool?.rate, now }));
        const lane = rt.store.getJob(lease.jobId)?.spec.lane;
        if (lane !== undefined) laneCounts[lane] = (laneCounts[lane] ?? 0) + 1;
        rt.store.appendEvent({ jobId: lease.jobId, type: "leased", data: { pool: key, fence: lease.fence } });
        spawnJob(lease, key);
        progress = true;
      }
    }
  }

  function forget(match: (id: JobId, r: Running) => boolean): void {
    for (const [id, r] of running) if (match(id, r)) running.delete(id);
  }

  adopt();
  self.sendInterval({ method: "tick", args: [] }, rt.config.limits.tickMs);

  return self
    .onCast("tick", () => schedule())
    .onCast("poke", () => schedule())
    .onCast("jobDone", (id: JobId) => {
      forget((jobId) => jobId === id);
      schedule();
    })
    .onCast("rateLimited", (pool: string, resetsAt: string | null) => {
      const next = recordRateLimit({ state: quotas.get(pool) ?? EMPTY_QUOTA, resetsAt, now: rt.now() });
      quotas.set(pool, next);
      rt.store.setPoolPause({ pool, until: next.pausedUntil });
    })
    .onInfo("down", (msg: { actorRef: ActorRef }) => {
      forget((_id, r) => r.ref.id.id === msg.actorRef.id.id);
    })
    .onCall("stats", (): SchedulerStats => {
      const byPool: Record<string, string[]> = {};
      for (const [id, r] of running) (byPool[r.pool] ??= []).push(id);
      const paused: Record<string, number | null> = {};
      for (const [k, q] of quotas) paused[k] = q.pausedUntil;
      const now = rt.now();
      const budgets: Record<string, { spentUsd: number; limitUsd: number; exceeded: boolean }> = {};
      for (const [k, pool] of rt.pools) {
        const spent = spentUsd(k, now);
        if (pool.budget && spent !== null) budgets[k] = { spentUsd: spent, limitUsd: pool.budget.usd, exceeded: overBudget(pool.budget, spent) };
      }
      const counts = rt.store.activeLaneCounts();
      const lanes: Record<string, { active: number; concurrency: number | null; enabled: boolean }> = {};
      for (const [name, n] of Object.entries(counts)) lanes[name] = { active: n, concurrency: null, enabled: true };
      for (const [name, lane] of Object.entries(rt.config.lanes)) {
        lanes[name] = { active: counts[name] ?? 0, concurrency: lane.concurrency, enabled: lane.enabled };
      }
      return { running: byPool, paused, budgets, lanes };
    })
    .childSupervision({ strategy: "one-for-one", maxRestarts: 0, periodMs: 1000 });
});

import { createActor, type ActorRef } from "libeam";
import { canStart, EMPTY_QUOTA, recordRateLimit, recordStart, type QuotaState } from "@cue/router";
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
  readonly paused: Readonly<Record<string, number | null>>;
}

/**
 * Pulls queued jobs from the store into per-pool JobActors. Concurrency and
 * quota are enforced here; the store's lease is the source of truth, so a
 * JobActor that dies is recovered when its lease expires.
 *
 * Plays the QueueProducer and QuotaActor roles from the original design: the
 * store is polled on every tick and on `poke`, rather than through GenStage
 * demand, because the queue lives in SQLite.
 */
export const Scheduler = createActor((ctx, self, rt: Runtime) => {
  const running = new Map<JobId, Running>();
  const quotas = new Map<string, QuotaState>();

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

  function schedule(): void {
    const now = rt.now();
    for (const lease of rt.store.reclaimExpired(now)) {
      running.delete(lease.jobId);
      rt.store.appendEvent({ jobId: lease.jobId, type: "lease-expired", data: { owner: lease.owner, fence: lease.fence } });
    }
    for (const [key, pool] of rt.pools) {
      if (!pool.enabled) continue;
      while (count(key) < pool.concurrency) {
        const quota = quotas.get(key) ?? EMPTY_QUOTA;
        if (!canStart({ state: quota, rule: pool.rate, now })) break;
        const ttlMs = rt.config.limits.leaseTtlSec * 1000;
        const lease = rt.store.leaseNext({ pool: key, owner: rt.owner, ttlMs, now });
        if (lease === null) break;
        quotas.set(key, recordStart({ state: quota, rule: pool.rate, now }));
        rt.store.appendEvent({ jobId: lease.jobId, type: "leased", data: { pool: key, fence: lease.fence } });
        spawnJob(lease, key);
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
      const until = recordRateLimit({ state: quotas.get(pool) ?? EMPTY_QUOTA, resetsAt, now: rt.now() });
      quotas.set(pool, until);
    })
    .onInfo("down", (msg: { actorRef: ActorRef }) => {
      forget((_id, r) => r.ref.id.id === msg.actorRef.id.id);
    })
    .onCall("stats", (): SchedulerStats => {
      const byPool: Record<string, string[]> = {};
      for (const [id, r] of running) (byPool[r.pool] ??= []).push(id);
      const paused: Record<string, number | null> = {};
      for (const [k, q] of quotas) paused[k] = q.pausedUntil;
      return { running: byPool, paused };
    })
    .childSupervision({ strategy: "one-for-one", maxRestarts: 0, periodMs: 1000 });
});

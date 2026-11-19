import { NotImplementedError, type CueConfig } from "@cue/core";
import type { HarnessAdapter } from "@cue/harness";

/**
 * Supervision tree (M1):
 *
 *   root Supervisor (one-for-one)
 *   ├── Gateway          named "cue.gateway"; validates, routes, writes jobs, pokes the scheduler
 *   ├── QueueProducer    pulls queued rows per pool when the pool has room and quota allows
 *   ├── QuotaActor       one per account: start budget + rate-limit pause
 *   ├── Notifier         webhook / command notifiers on job events
 *   └── HarnessPool[harness:account]   DynamicSupervisor (maxChildren = concurrency)
 *       └── JobActor     one per attempt; resumes from the stored phase after a restart
 *           └── ProcessActor  starts the harness via ProcessController, tails output, kills on cancel/timeout
 */
export interface CuedOptions {
  readonly config: CueConfig;
  readonly adapters: readonly HarnessAdapter[];
}

export interface Cued {
  readonly nodeId: string;
  shutdown(): Promise<void>;
}

export function startCued(_options: CuedOptions): Promise<Cued> {
  return Promise.reject(new NotImplementedError("startCued (M1)"));
}

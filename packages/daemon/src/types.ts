import type { JobRecord } from "@cue/store";
import type { WaitReason } from "./actors/scheduler.js";
export type { JobId, JobSpecInput } from "@cue/core";
export type { PoolBlocker, SchedulerStats, WaitReason } from "./actors/scheduler.js";

/** What the Gateway returns to clients. `waiting` is set on queued jobs by `status`. */
export type JobRecordView = JobRecord & { readonly waiting?: readonly WaitReason[] };

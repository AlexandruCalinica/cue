import { z } from "zod";

/** A job id, e.g. `job-20261119-1a2b3c`. Only produced by {@link newJobId} or {@link parseJobId}. */
export type JobId = string & { readonly __brand: "JobId" };

const JOB_ID_RE = /^job-[0-9]{8}-[0-9a-f]{6,12}$/;

export function isJobId(value: string): value is JobId {
  return JOB_ID_RE.test(value);
}

export function parseJobId(value: string): JobId {
  if (!isJobId(value)) throw new Error(`invalid job id: ${value}`);
  return value;
}

export function newJobId(now: Date = new Date()): JobId {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return parseJobId(`job-${day}-${rand}`);
}

/** What a client submits. Unknown keys are kept in `meta` by convention, never interpreted by cue. */
export const JobSpecSchema = z.object({
  /** Free-form task text handed to the harness. */
  prompt: z.string().min(1),
  /** Who asked. M4 replaces this self-asserted value with a verified client identity. */
  requester: z.string().min(1).max(200),
  /** Directory the harness runs in. A pre-run hook may override it. */
  workdir: z.string().min(1).optional(),
  /** Labels used by routing rules (`match.labels`). */
  labels: z.array(z.string().min(1)).default([]),
  /** Optional lane, e.g. a team or project with its own concurrency cap. */
  lane: z.string().min(1).optional(),
  /** Pin to one harness (`claude`) or one pool (`claude:work`). */
  harness: z.string().min(1).optional(),
  /** Lower runs first. */
  priority: z.number().int().min(0).max(1000).default(50),
  /** Wall-clock budget for the run phase. */
  maxMinutes: z.number().positive().max(24 * 60).optional(),
  /** Opaque data for hooks and plugins (ticket keys, repo lists, ...). cue never reads it. */
  meta: z.record(z.string(), z.unknown()).default({}),
});

export type JobSpec = z.infer<typeof JobSpecSchema>;
export type JobSpecInput = z.input<typeof JobSpecSchema>;

export const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timeout"] as const;
export const JOB_STATUSES = ["queued", "leased", "running", ...TERMINAL_STATUSES] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];

export function isTerminal(status: JobStatus): status is TerminalStatus {
  return TERMINAL_STATUSES.some((s) => s === status);
}

/** Phases inside one attempt. Each is written to the store before its side effects start. */
export const PHASES = ["prepare", "run", "post", "finalize", "done"] as const;
export type Phase = (typeof PHASES)[number];

/** Summary written to `result.json` and returned by `cue status`. */
export interface JobResult {
  readonly id: JobId;
  readonly status: TerminalStatus;
  readonly pool: string | null;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly report: string | null;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly sessionId: string | null;
  readonly permissionDenials: number;
  /** Things a human should look at even when the status is `succeeded`. */
  readonly flags: readonly string[];
  readonly startedAt: string | null;
  readonly finishedAt: string;
}

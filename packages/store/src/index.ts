import { NotImplementedError, type JobId, type JobResult, type JobSpec, type JobStatus, type Phase } from "@cue/core";

/** A row in the `jobs` table. The store is the source of truth; actors are rebuilt from it at boot. */
export interface JobRecord {
  readonly id: JobId;
  readonly spec: JobSpec;
  readonly status: JobStatus;
  readonly phase: Phase | null;
  /** Ordered pool keys from the router. */
  readonly candidates: readonly string[];
  readonly pool: string | null;
  readonly attempt: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly cancelRequested: boolean;
}

/** A granted lease. Every write by the holder must present `fence`; stale holders are rejected. */
export interface Lease {
  readonly jobId: JobId;
  readonly owner: string;
  readonly fence: number;
  readonly expiresAt: number;
}

export interface StoredEvent {
  readonly seq: number;
  readonly jobId: JobId;
  readonly at: string;
  readonly type: string;
  readonly data: unknown;
}

export interface ListQuery {
  readonly status?: readonly JobStatus[];
  readonly requester?: string;
  readonly limit?: number;
}

/**
 * Persistence port. The SQLite implementation (node:sqlite, WAL) lands in M1;
 * anything else (Postgres for multi-host) can implement the same interface.
 */
export interface Store {
  insertJob(input: { id: JobId; spec: JobSpec; candidates: readonly string[] }): JobRecord;
  getJob(id: JobId): JobRecord | null;
  listJobs(query: ListQuery): readonly JobRecord[];
  /** Atomically take the best queued job that can run on `pool`, bumping its fence. */
  leaseNext(input: { pool: string; owner: string; ttlMs: number; now: number }): Lease | null;
  renewLease(input: { lease: Lease; ttlMs: number; now: number }): Lease;
  /** Write-ahead phase change: recorded before the phase's side effects start. */
  setPhase(input: { lease: Lease; phase: Phase }): void;
  finish(input: { lease: Lease; result: JobResult }): void;
  requestCancel(id: JobId): JobRecord | null;
  /** Expired leases, for recovery at boot and on every scheduler tick. */
  expiredLeases(now: number): readonly Lease[];
  appendEvent(input: { jobId: JobId; type: string; data: unknown }): StoredEvent;
  readEvents(input: { jobId: JobId; afterSeq?: number; limit?: number }): readonly StoredEvent[];
  close(): void;
}

/** Schema the SQLite store will create (kept here so reviews see the data model early). */
export const SQLITE_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  candidates TEXT NOT NULL,
  pool TEXT,
  priority INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  fence INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, priority, created_at);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id, seq);
`;

export function openSqliteStore(_path: string): Store {
  throw new NotImplementedError("openSqliteStore (M1)");
}

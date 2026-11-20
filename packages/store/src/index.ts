import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
  JOB_STATUSES,
  JobIdSchema,
  JobResultSchema,
  JobSpecSchema,
  PHASES,
  isTerminal,
  type JobId,
  type JobResult,
  type JobSpec,
  type JobStatus,
  type Phase,
} from "@cue/core";

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
  /** Set once the job reaches a terminal status. */
  readonly result: JobResult | null;
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

/** A write was attempted with a lease the store no longer honours (expired and reclaimed, or superseded). */
export class StaleLeaseError extends Error {
  constructor(readonly lease: Lease) {
    super(`stale lease for ${lease.jobId} (owner ${lease.owner}, fence ${lease.fence})`);
    this.name = "StaleLeaseError";
  }
}

/**
 * Persistence port. The SQLite implementation uses node:sqlite in WAL mode;
 * anything else (Postgres for multi-host) can implement the same interface
 * and must pass the same contract tests.
 */
export interface Store {
  insertJob(input: { id: JobId; spec: JobSpec; candidates: readonly string[] }): JobRecord;
  getJob(id: JobId): JobRecord | null;
  /** Newest first. */
  listJobs(query: ListQuery): readonly JobRecord[];
  /**
   * Atomically take the best queued job that can run on `pool` (lowest priority,
   * then oldest), bumping its fence and its attempt counter.
   */
  leaseNext(input: { pool: string; owner: string; ttlMs: number; now: number }): Lease | null;
  /** Extends a live lease. Throws {@link StaleLeaseError} if the lease was superseded. */
  renewLease(input: { lease: Lease; ttlMs: number; now: number }): Lease;
  /** Write-ahead phase change: recorded before the phase's side effects start. `run` marks the job running. */
  setPhase(input: { lease: Lease; phase: Phase }): void;
  /** Records the terminal result and releases the lease. */
  finish(input: { lease: Lease; result: JobResult }): void;
  /**
   * Puts a leased job back in the queue and releases the lease. With
   * `refundAttempt` (rate limits, shutdown) the attempt doesn't count.
   */
  requeue(input: { lease: Lease; refundAttempt?: boolean }): void;
  /**
   * Cancels a queued job immediately; flags a leased or running job so its
   * holder stops it. Terminal jobs are returned unchanged. `null` if unknown.
   */
  requestCancel(id: JobId): JobRecord | null;
  /** Expired leases, for recovery at boot and on every scheduler tick. */
  expiredLeases(now: number): readonly Lease[];
  /** Live (leased or running) leases held by `owner`, so a restarted node can adopt its jobs. */
  activeLeases(owner: string): readonly (Lease & { readonly pool: string })[];
  /**
   * Holder-private runtime data for the current attempt (process handle,
   * output offset, ...), kept so a restarted holder can reattach. Fenced.
   */
  setRuntime(input: { lease: Lease; runtime: unknown }): void;
  getRuntime(id: JobId): unknown;
  /**
   * Atomically requeues every job whose lease expired before `now`, fencing
   * out the old holders, and returns the leases it revoked. Jobs flagged for
   * cancellation become `cancelled` instead.
   */
  reclaimExpired(now: number): readonly Lease[];
  appendEvent(input: { jobId: JobId; type: string; data: unknown }): StoredEvent;
  readEvents(input: { jobId: JobId; afterSeq?: number; limit?: number }): readonly StoredEvent[];
  close(): void;
}

export const SCHEMA_VERSION = 2;

/** Schema of the SQLite store (version {@link SCHEMA_VERSION}). */
export const SQLITE_SCHEMA = `
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
  result TEXT,
  runtime TEXT
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_lease ON jobs (lease_expires) WHERE lease_owner IS NOT NULL;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id, seq);
`;

/** Parses a JSON text column, then validates it with `schema`. */
const json = <T extends z.ZodType>(schema: T) =>
  z.string().transform((text, ctx) => {
    try {
      const value: unknown = JSON.parse(text);
      return value;
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid JSON" });
      return z.NEVER;
    }
  }).pipe(schema);

const JobRowSchema = z.object({
  id: JobIdSchema,
  spec: json(JobSpecSchema),
  status: z.enum(JOB_STATUSES),
  phase: z.enum(PHASES).nullable(),
  candidates: json(z.array(z.string())),
  pool: z.string().nullable(),
  attempt: z.number(),
  fence: z.number(),
  lease_owner: z.string().nullable(),
  lease_expires: z.number().nullable(),
  cancel_requested: z.number(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  result: json(JobResultSchema).nullable(),
  runtime: json(z.unknown()).nullable(),
});
type JobRow = z.infer<typeof JobRowSchema>;

const LeaseRowSchema = JobRowSchema.pick({ id: true, lease_owner: true, fence: true, lease_expires: true });
const PoolLeaseRowSchema = LeaseRowSchema.extend({ pool: z.string() });
const EventRowSchema = z.object({
  seq: z.number(),
  job_id: JobIdSchema,
  at: z.string(),
  type: z.string(),
  data: json(z.unknown()),
});
const IdRowSchema = z.object({ id: z.string() });
const VersionRowSchema = z.object({ user_version: z.number() });

const ACTIVE = `status IN ('leased', 'running')`;

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    spec: row.spec,
    status: row.status,
    phase: row.phase,
    candidates: row.candidates,
    pool: row.pool,
    attempt: row.attempt,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelRequested: row.cancel_requested !== 0,
    result: row.result,
  };
}

function toLease(row: z.infer<typeof LeaseRowSchema>): Lease {
  return { jobId: row.id, owner: row.lease_owner ?? "", fence: row.fence, expiresAt: row.lease_expires ?? 0 };
}

function toEvent(row: z.infer<typeof EventRowSchema>): StoredEvent {
  return { seq: row.seq, jobId: row.job_id, at: row.at, type: row.type, data: row.data };
}

const iso = (ms?: number) => new Date(ms ?? Date.now()).toISOString();

export interface SqliteStoreOptions {
  /** Milliseconds a writer waits on a locked database before failing. Default 5000. */
  readonly busyTimeoutMs?: number;
}

/** Opens (and migrates) a SQLite store. Use `:memory:` for tests. */
export function openSqliteStore(path: string, options: SqliteStoreOptions = {}): Store {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return new SqliteStore(db);
}

function migrate(db: DatabaseSync): void {
  const version = VersionRowSchema.parse(db.prepare("PRAGMA user_version").get()).user_version;
  if (version > SCHEMA_VERSION) {
    throw new Error(`store schema v${version} is newer than this cue (v${SCHEMA_VERSION})`);
  }
  if (version < SCHEMA_VERSION) {
    tx(db, () => {
      if (version === 0) db.exec(SQLITE_SCHEMA);
      if (version === 1) db.exec("ALTER TABLE jobs ADD COLUMN runtime TEXT");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
}

/** Runs `fn` in an IMMEDIATE transaction so concurrent writers serialise at BEGIN. */
function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

class SqliteStore implements Store {
  constructor(private readonly db: DatabaseSync) {}

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  private job(id: string): JobRow | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row === undefined ? undefined : JobRowSchema.parse(row);
  }

  /** Runs a fenced update; throws {@link StaleLeaseError} if it touched no row. */
  private fenced(lease: Lease, set: string, ...params: SQLInputValue[]): void {
    const changed = this.run(
      `UPDATE jobs SET ${set} WHERE id = ? AND fence = ? AND lease_owner = ? AND ${ACTIVE}`,
      ...params,
      lease.jobId,
      lease.fence,
      lease.owner,
    );
    if (changed === 0) throw new StaleLeaseError(lease);
  }

  insertJob(input: { id: JobId; spec: JobSpec; candidates: readonly string[] }): JobRecord {
    this.run(
      `INSERT INTO jobs (id, spec, status, candidates, priority, created_at) VALUES (?, ?, 'queued', ?, ?, ?)`,
      input.id,
      JSON.stringify(input.spec),
      JSON.stringify(input.candidates),
      input.spec.priority,
      iso(),
    );
    const row = this.job(input.id);
    if (!row) throw new Error(`insert of ${input.id} did not persist`);
    return toRecord(row);
  }

  getJob(id: JobId): JobRecord | null {
    const row = this.job(id);
    return row ? toRecord(row) : null;
  }

  listJobs(query: ListQuery): readonly JobRecord[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.status && query.status.length > 0) {
      where.push(`status IN (${query.status.map(() => "?").join(", ")})`);
      params.push(...query.status);
    }
    if (query.requester !== undefined) {
      where.push(`json_extract(spec, '$.requester') = ?`);
      params.push(query.requester);
    }
    const sql =
      `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    params.push(Math.max(1, Math.trunc(query.limit ?? 100)));
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => toRecord(JobRowSchema.parse(row)));
  }

  leaseNext(input: { pool: string; owner: string; ttlMs: number; now: number }): Lease | null {
    return tx(this.db, () => {
      const found = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE status = 'queued' AND cancel_requested = 0
             AND EXISTS (SELECT 1 FROM json_each(jobs.candidates) WHERE value = ?)
           ORDER BY priority ASC, created_at ASC, rowid ASC LIMIT 1`,
        )
        .get(input.pool);
      if (found === undefined) return null;
      const row = IdRowSchema.parse(found);
      const expires = input.now + input.ttlMs;
      this.run(
        `UPDATE jobs SET status = 'leased', pool = ?, phase = NULL, fence = fence + 1, attempt = attempt + 1,
           lease_owner = ?, lease_expires = ?, runtime = NULL WHERE id = ?`,
        input.pool,
        input.owner,
        expires,
        row.id,
      );
      const updated = this.job(row.id);
      if (!updated) throw new Error(`leased job ${row.id} vanished`);
      return toLease(updated);
    });
  }

  renewLease(input: { lease: Lease; ttlMs: number; now: number }): Lease {
    const expiresAt = input.now + input.ttlMs;
    this.fenced(input.lease, "lease_expires = ?", expiresAt);
    return { ...input.lease, expiresAt };
  }

  setPhase(input: { lease: Lease; phase: Phase }): void {
    if (input.phase === "run") {
      this.fenced(input.lease, `phase = ?, status = 'running', started_at = COALESCE(started_at, ?)`, input.phase, iso());
    } else {
      this.fenced(input.lease, "phase = ?", input.phase);
    }
  }

  finish(input: { lease: Lease; result: JobResult }): void {
    if (!isTerminal(input.result.status)) throw new Error(`finish needs a terminal status, got ${input.result.status}`);
    this.fenced(
      input.lease,
      `status = ?, phase = 'done', finished_at = ?, result = ?, lease_owner = NULL, lease_expires = NULL`,
      input.result.status,
      input.result.finishedAt,
      JSON.stringify(input.result),
    );
  }

  requeue(input: { lease: Lease; refundAttempt?: boolean }): void {
    this.fenced(
      input.lease,
      `status = 'queued', phase = NULL, pool = NULL, fence = fence + 1, lease_owner = NULL, lease_expires = NULL,
       runtime = NULL, attempt = attempt - ?`,
      input.refundAttempt ? 1 : 0,
    );
  }

  requestCancel(id: JobId): JobRecord | null {
    return tx(this.db, () => {
      const row = this.job(id);
      if (!row) return null;
      if (row.status === "queued") {
        const now = iso();
        const result: JobResult = {
          id,
          status: "cancelled",
          pool: null,
          exitCode: null,
          error: "cancelled before start",
          report: null,
          costUsd: null,
          numTurns: null,
          sessionId: null,
          permissionDenials: 0,
          flags: [],
          startedAt: null,
          finishedAt: now,
        };
        this.run(
          `UPDATE jobs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, result = ? WHERE id = ?`,
          now,
          JSON.stringify(result),
          id,
        );
      } else if (!isTerminal(row.status)) {
        this.run(`UPDATE jobs SET cancel_requested = 1 WHERE id = ?`, id);
      }
      const updated = this.job(id);
      return updated ? toRecord(updated) : null;
    });
  }

  expiredLeases(now: number): readonly Lease[] {
    return this.db
      .prepare(`SELECT id, lease_owner, fence, lease_expires FROM jobs WHERE ${ACTIVE} AND lease_expires < ?`)
      .all(now)
      .map((row) => toLease(LeaseRowSchema.parse(row)));
  }

  activeLeases(owner: string): readonly (Lease & { readonly pool: string })[] {
    return this.db
      .prepare(`SELECT id, lease_owner, fence, lease_expires, pool FROM jobs WHERE ${ACTIVE} AND lease_owner = ? AND pool IS NOT NULL`)
      .all(owner)
      .map((raw) => {
        const row = PoolLeaseRowSchema.parse(raw);
        return { ...toLease(row), pool: row.pool };
      });
  }

  setRuntime(input: { lease: Lease; runtime: unknown }): void {
    this.fenced(input.lease, "runtime = ?", JSON.stringify(input.runtime ?? null));
  }

  getRuntime(id: JobId): unknown {
    return this.job(id)?.runtime ?? null;
  }

  reclaimExpired(now: number): readonly Lease[] {
    return tx(this.db, () => {
      const expired = this.expiredLeases(now);
      for (const lease of expired) {
        const row = this.job(lease.jobId);
        if (row?.cancel_requested) {
          const result: JobResult = {
            id: lease.jobId,
            status: "cancelled",
            pool: row.pool,
            exitCode: null,
            error: "lease expired after cancel was requested",
            report: null,
            costUsd: null,
            numTurns: null,
            sessionId: null,
            permissionDenials: 0,
            flags: ["lease-expired"],
            startedAt: row.started_at,
            finishedAt: iso(now),
          };
          this.fenced(
            lease,
            `status = 'cancelled', phase = 'done', fence = fence + 1, finished_at = ?, result = ?,
             lease_owner = NULL, lease_expires = NULL`,
            result.finishedAt,
            JSON.stringify(result),
          );
        } else {
          this.requeue({ lease });
        }
      }
      return expired;
    });
  }

  appendEvent(input: { jobId: JobId; type: string; data: unknown }): StoredEvent {
    const row = this.db
      .prepare(`INSERT INTO events (job_id, at, type, data) VALUES (?, ?, ?, ?) RETURNING *`)
      .get(input.jobId, iso(), input.type, JSON.stringify(input.data ?? null));
    return toEvent(EventRowSchema.parse(row));
  }

  readEvents(input: { jobId: JobId; afterSeq?: number; limit?: number }): readonly StoredEvent[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(input.jobId, input.afterSeq ?? 0, Math.max(1, Math.trunc(input.limit ?? 1000)))
      .map((row) => toEvent(EventRowSchema.parse(row)));
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

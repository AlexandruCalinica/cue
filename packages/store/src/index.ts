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
  /** Verified client that submitted the job; `null` when the Gateway ran without clients. */
  readonly client: string | null;
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
  readonly client?: string;
  readonly limit?: number;
}

export interface LeaseQuery {
  readonly pool: string;
  readonly owner: string;
  readonly ttlMs: number;
  readonly now: number;
  /**
   * Pools that can start a job right now. A job is only eligible for `pool` when
   * no candidate it prefers over `pool` is in this list, so work stays on the
   * preferred pool while it has room. Omitted: preference is not enforced.
   */
  readonly available?: readonly string[];
  /** Lanes that may not start jobs (disabled or at their concurrency cap). */
  readonly blockedLanes?: readonly string[];
}

/** One Gateway call as recorded in the audit log. */
export interface AuditRecord {
  readonly seq: number;
  readonly at: string;
  /** Client name, `null` for unsigned calls (open mode or rejected without a known client). */
  readonly client: string | null;
  readonly method: string;
  readonly ok: boolean;
  /** Why the call was rejected or failed; `null` on success. */
  readonly reason: string | null;
  readonly jobId: string | null;
}

/** Whether a queued job may be leased by `pool` under a {@link LeaseQuery}. */
export function isEligible(
  job: { readonly candidates: readonly string[]; readonly lane?: string | undefined },
  query: Pick<LeaseQuery, "pool" | "available" | "blockedLanes">,
): boolean {
  const at = job.candidates.indexOf(query.pool);
  if (at < 0) return false;
  if (job.lane !== undefined && query.blockedLanes?.includes(job.lane)) return false;
  const available = query.available;
  if (available === undefined) return true;
  return !job.candidates.slice(0, at).some((p) => available.includes(p));
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
  insertJob(input: { id: JobId; spec: JobSpec; candidates: readonly string[]; client?: string | null }): JobRecord;
  /** Queued, leased or running jobs submitted by `client`. */
  countUnfinished(client: string): number;
  /**
   * Records a request nonce until `expiresAt` (epoch ms). Returns false when the
   * nonce was already used by this client and has not expired. Prunes expired nonces.
   */
  useNonce(input: { client: string; nonce: string; expiresAt: number; now: number }): boolean;
  appendAudit(input: { client: string | null; method: string; ok: boolean; reason: string | null; jobId: string | null }): AuditRecord;
  /** Newest first. */
  readAudit(input: { limit?: number; client?: string }): readonly AuditRecord[];
  getJob(id: JobId): JobRecord | null;
  /** Newest first. */
  listJobs(query: ListQuery): readonly JobRecord[];
  /**
   * Atomically take the best queued job that can run on `pool` (lowest priority,
   * then oldest), bumping its fence and its attempt counter. See {@link LeaseQuery}
   * for preference order and lane filtering.
   */
  leaseNext(input: LeaseQuery): Lease | null;
  /** Sum of `costUsd` over jobs that finished on `pool` at or after `since` (epoch ms). */
  spendSince(input: { pool: string; since: number }): number;
  /** Leased or running jobs per lane (jobs without a lane are not counted). */
  activeLaneCounts(): Readonly<Record<string, number>>;
  /** Persisted rate-limit pauses: pool key to epoch ms. */
  poolPauses(): Readonly<Record<string, number>>;
  /** Records (or with `null` clears) a pool's pause so it survives a restart. */
  setPoolPause(input: { pool: string; until: number | null }): void;
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

export const SCHEMA_VERSION = 4;

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS nonces (
  client TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (client, nonce)
);
CREATE INDEX IF NOT EXISTS nonces_expires ON nonces (expires);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  client TEXT,
  method TEXT NOT NULL,
  ok INTEGER NOT NULL,
  reason TEXT,
  job_id TEXT
);
CREATE INDEX IF NOT EXISTS jobs_client ON jobs (client, status);
`;

const POOL_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pool_state (
  pool TEXT PRIMARY KEY,
  paused_until INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_finished ON jobs (pool, finished_at) WHERE finished_at IS NOT NULL;
`;

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
  runtime TEXT,
  client TEXT
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
${POOL_STATE_SCHEMA}${AUTH_SCHEMA}`;

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
  client: z.string().nullable(),
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
const CandidateRowSchema = z.object({ id: z.string(), candidates: json(z.array(z.string())), lane: z.string().nullable() });
const SumRowSchema = z.object({ total: z.number().nullable() });
const LaneCountRowSchema = z.object({ lane: z.string(), n: z.number() });
const PauseRowSchema = z.object({ pool: z.string(), paused_until: z.number() });
const CountRowSchema = z.object({ n: z.number() });
const AuditRowSchema = z.object({
  seq: z.number(),
  at: z.string(),
  client: z.string().nullable(),
  method: z.string(),
  ok: z.number(),
  reason: z.string().nullable(),
  job_id: z.string().nullable(),
});
const VersionRowSchema = z.object({ user_version: z.number() });

const ACTIVE = `status IN ('leased', 'running')`;

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    spec: row.spec,
    client: row.client,
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

function toAudit(row: z.infer<typeof AuditRowSchema>): AuditRecord {
  return { seq: row.seq, at: row.at, client: row.client, method: row.method, ok: row.ok !== 0, reason: row.reason, jobId: row.job_id };
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
      if (version >= 1 && version < 3) db.exec(POOL_STATE_SCHEMA);
      if (version >= 1 && version < 4) {
        db.exec("ALTER TABLE jobs ADD COLUMN client TEXT");
        db.exec(AUTH_SCHEMA);
      }
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

  insertJob(input: { id: JobId; spec: JobSpec; candidates: readonly string[]; client?: string | null }): JobRecord {
    this.run(
      `INSERT INTO jobs (id, spec, status, candidates, priority, created_at, client) VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
      input.id,
      JSON.stringify(input.spec),
      JSON.stringify(input.candidates),
      input.spec.priority,
      iso(),
      input.client ?? null,
    );
    const row = this.job(input.id);
    if (!row) throw new Error(`insert of ${input.id} did not persist`);
    return toRecord(row);
  }

  countUnfinished(client: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE client = ? AND status IN ('queued', 'leased', 'running')`).get(client);
    return CountRowSchema.parse(row).n;
  }

  useNonce(input: { client: string; nonce: string; expiresAt: number; now: number }): boolean {
    return tx(this.db, () => {
      this.run("DELETE FROM nonces WHERE expires < ?", input.now);
      return this.run("INSERT OR IGNORE INTO nonces (client, nonce, expires) VALUES (?, ?, ?)", input.client, input.nonce, input.expiresAt) === 1;
    });
  }

  appendAudit(input: { client: string | null; method: string; ok: boolean; reason: string | null; jobId: string | null }): AuditRecord {
    const row = this.db
      .prepare(`INSERT INTO audit (at, client, method, ok, reason, job_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(iso(), input.client, input.method, input.ok ? 1 : 0, input.reason, input.jobId);
    return toAudit(AuditRowSchema.parse(row));
  }

  readAudit(input: { limit?: number; client?: string }): readonly AuditRecord[] {
    const limit = Math.max(1, Math.trunc(input.limit ?? 100));
    const rows =
      input.client === undefined
        ? this.db.prepare(`SELECT * FROM audit ORDER BY seq DESC LIMIT ?`).all(limit)
        : this.db.prepare(`SELECT * FROM audit WHERE client = ? ORDER BY seq DESC LIMIT ?`).all(input.client, limit);
    return rows.map((row) => toAudit(AuditRowSchema.parse(row)));
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
    if (query.client !== undefined) {
      where.push(`client = ?`);
      params.push(query.client);
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

  leaseNext(input: LeaseQuery): Lease | null {
    return tx(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT id, candidates, json_extract(spec, '$.lane') AS lane FROM jobs
           WHERE status = 'queued' AND cancel_requested = 0
             AND EXISTS (SELECT 1 FROM json_each(jobs.candidates) WHERE value = ?)
           ORDER BY priority ASC, created_at ASC, rowid ASC`,
        )
        .iterate(input.pool);
      let found: string | null = null;
      for (const raw of rows) {
        const row = CandidateRowSchema.parse(raw);
        if (isEligible({ candidates: row.candidates, lane: row.lane ?? undefined }, input)) {
          found = row.id;
          break;
        }
      }
      if (found === null) return null;
      const expires = input.now + input.ttlMs;
      this.run(
        `UPDATE jobs SET status = 'leased', pool = ?, phase = NULL, fence = fence + 1, attempt = attempt + 1,
           lease_owner = ?, lease_expires = ?, runtime = NULL WHERE id = ?`,
        input.pool,
        input.owner,
        expires,
        found,
      );
      const updated = this.job(found);
      if (!updated) throw new Error(`leased job ${found} vanished`);
      return toLease(updated);
    });
  }

  spendSince(input: { pool: string; since: number }): number {
    const row = SumRowSchema.parse(
      this.db
        .prepare(
          `SELECT SUM(json_extract(result, '$.costUsd')) AS total FROM jobs
           WHERE pool = ? AND finished_at IS NOT NULL AND finished_at >= ?`,
        )
        .get(input.pool, iso(input.since)),
    );
    return row.total ?? 0;
  }

  activeLaneCounts(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    const rows = this.db
      .prepare(
        `SELECT json_extract(spec, '$.lane') AS lane, COUNT(*) AS n FROM jobs
         WHERE ${ACTIVE} AND json_extract(spec, '$.lane') IS NOT NULL GROUP BY lane`,
      )
      .all();
    for (const raw of rows) {
      const row = LaneCountRowSchema.parse(raw);
      out[row.lane] = row.n;
    }
    return out;
  }

  poolPauses(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const raw of this.db.prepare("SELECT pool, paused_until FROM pool_state WHERE paused_until IS NOT NULL").all()) {
      const row = PauseRowSchema.parse(raw);
      out[row.pool] = row.paused_until;
    }
    return out;
  }

  setPoolPause(input: { pool: string; until: number | null }): void {
    this.run(
      `INSERT INTO pool_state (pool, paused_until) VALUES (?, ?)
       ON CONFLICT (pool) DO UPDATE SET paused_until = excluded.paused_until`,
      input.pool,
      input.until,
    );
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

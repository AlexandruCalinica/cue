import { createActor, type ActorRefFrom } from "libeam";
import { z } from "zod";
import { JOB_STATUSES, JobIdSchema, JobSpecSchema, isTerminal, newJobId, type ClientVerb, type JobId } from "@cue/core";
import { route } from "@cue/router";
import type { AuditRecord, JobRecord, StoredEvent } from "@cue/store";
import { AuthError, canSee, clientName, createAuthenticator, GatewayError, type Caller } from "../auth.js";
import { errorMessage, jobPaths, lastLines, type Runtime } from "../runtime.js";
import type { JobRecordView } from "../types.js";
import type { Scheduler, SchedulerStats } from "./scheduler.js";

export { GatewayError } from "../auth.js";

const ListQuerySchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  status: z.array(z.enum(JOB_STATUSES)).optional(),
  requester: z.string().min(1).optional(),
});

const LogsQuerySchema = z.object({ id: JobIdSchema, lines: z.number().int().positive().max(100_000).optional() });
const EventsQuerySchema = z.object({ id: JobIdSchema, afterSeq: z.number().int().min(0).optional() });
const AuditQuerySchema = z.object({ limit: z.number().int().positive().max(10_000).optional(), client: z.string().min(1).optional() });

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new GatewayError(`invalid ${what}: ${z.prettifyError(r.error)}`);
  return r.data;
}

export interface SubmitReply {
  readonly id: JobId;
  readonly rule: string;
  readonly candidates: readonly string[];
}

export interface CancelReply {
  readonly id: JobId;
  /** True when the job was cancelled now or will be stopped by its runner. */
  readonly accepted: boolean;
  readonly status: JobRecord["status"];
}

/** Verbs whose successful calls are audited; reads are audited only when rejected. */
const AUDITED: ReadonlySet<ClientVerb> = new Set(["submit", "cancel"]);

/**
 * The cluster-facing API, registered as `cue.gateway`. Every call (except
 * `ping`) carries a request `{ auth, args }`: when `clients` are configured the
 * signature, timestamp, nonce and verb are checked before anything else, and
 * mutations plus every rejection are written to the audit log. Validates and
 * routes submissions, writes them to the store and pokes the scheduler. All
 * replies are plain JSON so they cross node boundaries unchanged.
 */
export const Gateway = createActor((_ctx, self, rt: Runtime, scheduler: ActorRefFrom<typeof Scheduler>) => {
  const auth = createAuthenticator(rt.config, rt.store);

  function audit(caller: string | null, method: ClientVerb, ok: boolean, reason: string | null, jobId: string | null): void {
    try {
      rt.store.appendAudit({ client: caller, method, ok, reason, jobId });
    } catch {
      // Auditing must not turn a served call into a failure.
    }
  }

  /** Authenticates, runs the handler and audits the outcome. */
  async function serve<T>(method: ClientVerb, request: unknown, handler: (caller: Caller, args: readonly unknown[]) => T | Promise<T>, jobOf?: (reply: T, args: readonly unknown[]) => string | null): Promise<T> {
    let caller: Caller;
    let args: readonly unknown[];
    try {
      ({ caller, args } = auth.authenticate(method, request, rt.now()));
    } catch (err) {
      audit(err instanceof AuthError ? err.claimedClient : null, method, false, errorMessage(err), null);
      throw err;
    }
    try {
      const reply = await handler(caller, args);
      if (AUDITED.has(method)) audit(clientName(caller), method, true, null, jobOf?.(reply, args) ?? null);
      return reply;
    } catch (err) {
      const jobId = typeof args[0] === "string" ? args[0] : null;
      audit(clientName(caller), method, false, err instanceof GatewayError ? err.message : `internal error: ${errorMessage(err)}`, jobId);
      throw err;
    }
  }

  /** A job the caller may see; others are reported as missing so their ids don't leak. */
  function visibleJob(caller: Caller, id: JobId): JobRecord {
    const rec = rt.store.getJob(id);
    if (!rec || !canSee(caller, rec.client)) throw new GatewayError(`no such job: ${id}`);
    return rec;
  }

  function submit(caller: Caller, input: unknown): SubmitReply {
    const spec = parse(JobSpecSchema, input, "job spec");
    const limits = rt.config.limits;
    const client = caller.kind === "client" ? caller.config : null;
    const lane = spec.lane ?? client?.defaultLane;
    if (client?.lanes !== undefined && (lane === undefined || !client.lanes.includes(lane))) {
      throw new GatewayError(lane === undefined ? `client must submit to one of its lanes: ${client.lanes.join(", ")}` : `lane ${lane} is not allowed for this client`);
    }
    if (caller.kind === "client" && caller.config.maxActive !== undefined) {
      const active = rt.store.countUnfinished(caller.name);
      if (active >= caller.config.maxActive) throw new GatewayError(`client ${caller.name} already has ${active} unfinished jobs (limit ${caller.config.maxActive})`);
    }
    const maxMinutes = Math.min(spec.maxMinutes ?? limits.defaultMaxMinutes, limits.maxMaxMinutes, client?.maxMinutes ?? Infinity);
    const normalised = { ...spec, maxMinutes, ...(lane === undefined ? {} : { lane }) };
    const decision = route(normalised, rt.config, { client: clientName(caller), ...(client?.pools === undefined ? {} : { allow: client.pools }) });
    if (decision.candidates.length === 0) {
      throw new GatewayError(
        spec.harness === undefined ? "no enabled pool can run this job" : `no enabled pool matches harness "${spec.harness}"`,
      );
    }
    const id = newJobId();
    rt.store.insertJob({ id, spec: normalised, candidates: decision.candidates, client: clientName(caller) });
    rt.store.appendEvent({
      jobId: id,
      type: "submitted",
      data: { client: clientName(caller), requester: spec.requester, rule: decision.rule, candidates: decision.candidates },
    });
    scheduler.cast("poke");
    return { id, rule: decision.rule, candidates: decision.candidates };
  }

  async function status(caller: Caller, input: unknown): Promise<JobRecordView | null> {
    const rec = rt.store.getJob(parse(JobIdSchema, input, "job id"));
    if (!rec || !canSee(caller, rec.client)) return null;
    if (rec.status !== "queued") return rec;
    return { ...rec, waiting: await scheduler.call("waitReasons", rec.id) };
  }

  function list(caller: Caller, input: unknown): readonly JobRecord[] {
    const q = parse(ListQuerySchema, input ?? {}, "list query");
    const own = caller.kind === "client" && caller.config.scope === "own";
    return rt.store.listJobs({
      ...(q.limit === undefined ? {} : { limit: q.limit }),
      ...(q.status === undefined ? {} : { status: q.status }),
      ...(q.requester === undefined ? {} : { requester: q.requester }),
      ...(own ? { client: caller.name } : {}),
    });
  }

  function cancel(caller: Caller, input: unknown): CancelReply {
    const jobId = parse(JobIdSchema, input, "job id");
    const before = visibleJob(caller, jobId);
    const after = rt.store.requestCancel(jobId) ?? before;
    const accepted = !isTerminal(before.status);
    if (accepted) rt.store.appendEvent({ jobId, type: "cancel-requested", data: { client: clientName(caller) } });
    return { id: jobId, accepted, status: after.status };
  }

  function logs(caller: Caller, input: unknown): string[] {
    const q = parse(LogsQuerySchema, input, "logs query");
    visibleJob(caller, q.id);
    return lastLines(jobPaths(rt.config.dataDir, q.id).stdout, q.lines ?? 100);
  }

  function events(caller: Caller, input: unknown): readonly StoredEvent[] {
    const q = parse(EventsQuerySchema, input, "events query");
    visibleJob(caller, q.id);
    return rt.store.readEvents({ jobId: q.id, ...(q.afterSeq === undefined ? {} : { afterSeq: q.afterSeq }) });
  }

  function readAudit(caller: Caller, input: unknown): readonly AuditRecord[] {
    const q = parse(AuditQuerySchema, input ?? {}, "audit query");
    // A client with scope `own` only reads its own audit trail.
    const client = caller.kind === "client" && caller.config.scope === "own" ? caller.name : q.client;
    return rt.store.readAudit({ ...(q.limit === undefined ? {} : { limit: q.limit }), ...(client === undefined ? {} : { client }) });
  }

  return self
    .onCall("ping", () => "pong" as const)
    .onCall("submit", (req: unknown) => serve("submit", req, (c, a) => submit(c, a[0]), (reply) => reply.id))
    .onCall("status", (req: unknown) => serve("status", req, (c, a) => status(c, a[0])))
    .onCall("list", (req: unknown) => serve("list", req, (c, a) => list(c, a[0])))
    .onCall("cancel", (req: unknown) => serve("cancel", req, (c, a) => cancel(c, a[0]), (reply) => reply.id))
    .onCall("logs", (req: unknown) => serve("logs", req, (c, a) => logs(c, a[0])))
    .onCall("events", (req: unknown) => serve("events", req, (c, a) => events(c, a[0])))
    .onCall("stats", (req: unknown) => serve("stats", req, (): Promise<SchedulerStats> => scheduler.call("stats")))
    .onCall("audit", (req: unknown) => serve("audit", req, (c, a) => readAudit(c, a[0])));
});

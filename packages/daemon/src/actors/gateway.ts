import { createActor, type ActorRef } from "libeam";
import { z } from "zod";
import { JOB_STATUSES, JobIdSchema, JobSpecSchema, isTerminal, newJobId, type JobId } from "@cue/core";
import { route } from "@cue/router";
import type { JobRecord } from "@cue/store";
import { jobPaths, lastLines, type Runtime } from "../runtime.js";

const ListQuerySchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  status: z.array(z.enum(JOB_STATUSES)).optional(),
  requester: z.string().min(1).optional(),
});

const LogsQuerySchema = z.object({ id: JobIdSchema, lines: z.number().int().positive().max(100_000).optional() });

/** A client error; the message is meant for the person running `cue`. */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

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

/**
 * The cluster-facing API, registered as `cue.gateway`. Validates and routes
 * submissions, writes them to the store and pokes the scheduler. All replies
 * are plain JSON so they cross node boundaries unchanged.
 */
export const Gateway = createActor((_ctx, self, rt: Runtime, scheduler: ActorRef) => {
  return self
    .onCall("ping", () => "pong" as const)
    .onCall("submit", (input: unknown): SubmitReply => {
      const spec = parse(JobSpecSchema, input, "job spec");
      const limits = rt.config.limits;
      const normalised = { ...spec, maxMinutes: Math.min(spec.maxMinutes ?? limits.defaultMaxMinutes, limits.maxMaxMinutes) };
      const decision = route(normalised, rt.config);
      if (decision.candidates.length === 0) {
        throw new GatewayError(
          spec.harness === undefined ? "no enabled pool can run this job" : `no enabled pool matches harness "${spec.harness}"`,
        );
      }
      const id = newJobId();
      rt.store.insertJob({ id, spec: normalised, candidates: decision.candidates });
      rt.store.appendEvent({ jobId: id, type: "submitted", data: { requester: spec.requester, rule: decision.rule, candidates: decision.candidates } });
      scheduler.cast({ method: "poke", args: [] });
      return { id, rule: decision.rule, candidates: decision.candidates };
    })
    .onCall("status", (id: unknown): JobRecord | null => rt.store.getJob(parse(JobIdSchema, id, "job id")))
    .onCall("list", (query: unknown): readonly JobRecord[] => {
      const q = parse(ListQuerySchema, query ?? {}, "list query");
      return rt.store.listJobs({
        ...(q.limit === undefined ? {} : { limit: q.limit }),
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.requester === undefined ? {} : { requester: q.requester }),
      });
    })
    .onCall("cancel", (id: unknown): CancelReply => {
      const jobId = parse(JobIdSchema, id, "job id");
      const before = rt.store.getJob(jobId);
      if (!before) throw new GatewayError(`no such job: ${jobId}`);
      const after = rt.store.requestCancel(jobId) ?? before;
      const accepted = !isTerminal(before.status);
      if (accepted) rt.store.appendEvent({ jobId, type: "cancel-requested", data: null });
      return { id: jobId, accepted, status: after.status };
    })
    .onCall("logs", (query: unknown): string[] => {
      const q = parse(LogsQuerySchema, query, "logs query");
      if (!rt.store.getJob(q.id)) throw new GatewayError(`no such job: ${q.id}`);
      return lastLines(jobPaths(rt.config.dataDir, q.id).stdout, q.lines ?? 100);
    })
    .onCall("events", (query: unknown) => {
      const q = parse(z.object({ id: JobIdSchema, afterSeq: z.number().int().min(0).optional() }), query, "events query");
      return rt.store.readEvents({ jobId: q.id, ...(q.afterSeq === undefined ? {} : { afterSeq: q.afterSeq }) });
    })
    .onCall("stats", () => scheduler.call({ method: "stats", args: [] }));
});

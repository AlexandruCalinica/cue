import type { ActorRef } from "libeam";
import type { SignedRequest } from "@cue/core";
import type { AuditRecord, StoredEvent } from "@cue/store";
import type { CancelReply, SubmitReply } from "./actors/gateway.js";
import type { JobRecordView, SchedulerStats } from "./types.js";

/**
 * Wire protocol of the Gateway. This module has no runtime dependencies on the
 * daemon (types only), so clients can import `@cue/daemon/protocol` without
 * loading the store or the actors.
 */

/** Registered name of the Gateway actor that client nodes look up. */
export const GATEWAY_NAME = "cue.gateway";

export type GatewayMethod = "ping" | "submit" | "status" | "list" | "cancel" | "logs" | "events" | "stats" | "audit";

/** Wraps a call's arguments into the request the Gateway expects, signing it when the client has a key. */
export type Signer = (method: string, args: readonly unknown[]) => SignedRequest;

/** For daemons without `clients`: requests carry no signature. */
export const unsigned: Signer = (_method, args) => ({ auth: null, args: [...args] });

/** Typed Gateway calls, each resolving to the handler's reply. */
export interface GatewayClient {
  ping(): Promise<"pong">;
  submit(spec: unknown): Promise<SubmitReply>;
  status(id: string): Promise<JobRecordView | null>;
  list(query?: { limit?: number; status?: readonly string[]; requester?: string }): Promise<readonly JobRecordView[]>;
  cancel(id: string): Promise<CancelReply>;
  logs(query: { id: string; lines?: number }): Promise<string[]>;
  events(query: { id: string; afterSeq?: number }): Promise<readonly StoredEvent[]>;
  stats(): Promise<SchedulerStats>;
  audit(query?: { limit?: number; client?: string }): Promise<readonly AuditRecord[]>;
}

/**
 * Wraps any reference to the Gateway (local or remote). Always sends the
 * explicit `{ method, args }` message form, with one argument: the (signed)
 * request. A remote ref returned by `getActorByName` is an untyped `ActorRef`,
 * whose `call(a, b)` would read the second argument as a timeout.
 */
export function gatewayClient(ref: ActorRef, options: { signer?: Signer; timeoutMs?: number } = {}): GatewayClient {
  const signer = options.signer ?? unsigned;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const call = (method: GatewayMethod, args: unknown[]) => ref.call({ method, args: [signer(method, args)] }, timeoutMs);
  return {
    ping: () => ref.call({ method: "ping", args: [] }, timeoutMs),
    submit: (spec) => call("submit", [spec]),
    status: (id) => call("status", [id]),
    list: (query) => call("list", query === undefined ? [] : [query]),
    cancel: (id) => call("cancel", [id]),
    logs: (query) => call("logs", [query]),
    events: (query) => call("events", [query]),
    stats: () => call("stats", []),
    audit: (query) => call("audit", query === undefined ? [] : [query]),
  };
}

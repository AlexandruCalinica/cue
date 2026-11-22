import type { ActorRef, ExtractCalls } from "libeam";
import type { Gateway } from "./actors/gateway.js";

/**
 * Wire protocol of the Gateway. This module has no runtime dependencies on the
 * daemon (types only), so clients can import `@cue/daemon/protocol` without
 * loading the store or the actors.
 */

/** Registered name of the Gateway actor that client nodes look up. */
export const GATEWAY_NAME = "cue.gateway";

type Calls = ExtractCalls<typeof Gateway>;

export type GatewayMethod = "ping" | "submit" | "status" | "list" | "cancel" | "logs" | "events" | "stats";

/** Typed Gateway calls, each resolving to the handler's reply. */
export type GatewayClient = {
  readonly [K in GatewayMethod]: (...args: Parameters<Calls[K]>) => Promise<Awaited<ReturnType<Calls[K]>>>;
};

/**
 * Wraps any reference to the Gateway (local or remote). Always sends the
 * explicit `{ method, args }` message form: a remote ref returned by
 * `getActorByName` is an untyped `ActorRef`, whose `call(a, b)` would read the
 * second argument as a timeout.
 */
export function gatewayClient(ref: ActorRef, timeoutMs = 15_000): GatewayClient {
  const call = (method: string, args: unknown[]) => ref.call({ method, args }, timeoutMs);
  return {
    ping: () => call("ping", []),
    submit: (spec) => call("submit", [spec]),
    status: (id) => call("status", [id]),
    list: (query) => call("list", [query]),
    cancel: (id) => call("cancel", [id]),
    logs: (query) => call("logs", [query]),
    events: (query) => call("events", [query]),
    stats: () => call("stats", []),
  };
}

import type { ActorRefFrom } from "libeam";
import type { Gateway } from "./actors/gateway.js";

/** Registered name of the Gateway actor that client nodes look up. */
export const GATEWAY_NAME = "cue.gateway";

/**
 * Typed reference to the Gateway: `ref.call("submit", spec)`, `ref.call("status", id)`,
 * `ref.call("list", { limit })`, `ref.call("cancel", id)`, `ref.call("logs", { id, lines })`,
 * `ref.call("events", { id, afterSeq })`, `ref.call("ping")`.
 */
export type GatewayRef = ActorRefFrom<typeof Gateway>;

declare module "libeam" {
  interface ActorRegistry {
    "cue.gateway": typeof Gateway;
  }
}

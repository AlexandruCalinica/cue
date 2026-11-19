import type { JobId, JobRecordView, JobSpecInput } from "./types.js";

/** Registered name of the Gateway actor that client nodes look up. */
export const GATEWAY_NAME = "cue.gateway";

/** Calls a client node may make on the Gateway (`ref.call({ method, args })`). */
export interface GatewayCalls {
  ping(): "pong";
  submit(spec: JobSpecInput): { id: JobId };
  status(id: JobId): JobRecordView | null;
  list(query: { limit?: number; status?: string[] }): JobRecordView[];
  cancel(id: JobId): { id: JobId; accepted: boolean };
  logs(query: { id: JobId; lines?: number }): string[];
}

export type GatewayMethod = keyof GatewayCalls;

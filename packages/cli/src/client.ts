import { NotImplementedError } from "@cue/core";

/**
 * The CLI is itself a short-lived libeam node: it joins the cluster via
 * CUE_SEEDS with CUE_COOKIE, looks up "cue.gateway" and calls it with
 * `ref.call({ method, args })`. Implemented in M1.
 */
export interface ClientOptions {
  readonly seeds: readonly string[];
  readonly cookie: string;
}

export function connect(_options: ClientOptions): Promise<never> {
  return Promise.reject(new NotImplementedError("client connect (M1)"));
}

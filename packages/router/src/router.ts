import { poolKey, type CueConfig, type PoolConfig } from "@cue/core";
import type { JobSpec } from "@cue/core";

export interface RouteDecision {
  /** Matching rule, or `default` / `pinned`. */
  readonly rule: string;
  /** Candidate pool keys in preference order; the scheduler takes the first with room. */
  readonly candidates: readonly string[];
}

function expand(target: string, pools: readonly PoolConfig[]): string[] {
  const enabled = pools.filter((p) => p.enabled);
  if (target.includes(":")) return enabled.some((p) => poolKey(p) === target) ? [target] : [];
  return enabled.filter((p) => p.harness === target).map(poolKey);
}

/** Who is submitting, as far as routing cares. */
export interface RouteContext {
  /** Verified client name, or `null` when the Gateway runs without clients. */
  readonly client?: string | null;
  /** Pool keys or harness ids the client may use. Omitted: any. */
  readonly allow?: readonly string[];
}

function matches(rule: CueConfig["routing"][number], spec: JobSpec, client: string | null): boolean {
  const { labels, requester, lane } = rule.match;
  if (rule.match.client && (client === null || !rule.match.client.includes(client))) return false;
  if (labels && !labels.every((l) => spec.labels.includes(l))) return false;
  if (requester && !requester.includes(spec.requester)) return false;
  if (lane && (spec.lane === undefined || !lane.includes(spec.lane))) return false;
  return true;
}

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

/**
 * Pure routing: first matching rule wins; a pinned `harness` overrides the rules.
 * A client's pool allow-list then filters the candidates (rules whose pools are all
 * disallowed are skipped).
 */
export function route(spec: JobSpec, config: CueConfig, context: RouteContext = {}): RouteDecision {
  const allowed = context.allow === undefined ? null : new Set(context.allow.flatMap((t) => expand(t, config.pools)));
  const permit = (keys: readonly string[]) => unique(allowed === null ? keys : keys.filter((k) => allowed.has(k)));
  if (spec.harness !== undefined) {
    return { rule: "pinned", candidates: permit(expand(spec.harness, config.pools)) };
  }
  for (const rule of config.routing) {
    if (!matches(rule, spec, context.client ?? null)) continue;
    const candidates = permit(rule.use.flatMap((t) => expand(t, config.pools)));
    if (candidates.length > 0) return { rule: rule.name, candidates };
  }
  return { rule: "default", candidates: permit(config.pools.filter((p) => p.enabled).map(poolKey)) };
}

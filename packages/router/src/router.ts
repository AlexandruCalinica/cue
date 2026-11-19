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

function matches(rule: CueConfig["routing"][number], spec: JobSpec): boolean {
  const { labels, requester, lane } = rule.match;
  if (labels && !labels.every((l) => spec.labels.includes(l))) return false;
  if (requester && !requester.includes(spec.requester)) return false;
  if (lane && (spec.lane === undefined || !lane.includes(spec.lane))) return false;
  return true;
}

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

/** Pure routing: first matching rule wins; a pinned `harness` overrides the rules. */
export function route(spec: JobSpec, config: CueConfig): RouteDecision {
  if (spec.harness !== undefined) {
    return { rule: "pinned", candidates: expand(spec.harness, config.pools) };
  }
  for (const rule of config.routing) {
    if (!matches(rule, spec)) continue;
    const candidates = unique(rule.use.flatMap((t) => expand(t, config.pools)));
    if (candidates.length > 0) return { rule: rule.name, candidates };
  }
  return { rule: "default", candidates: unique(config.pools.filter((p) => p.enabled).map(poolKey)) };
}

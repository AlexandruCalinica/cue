/**
 * Per-account start budget and rate-limit pause. Pure state transitions so the
 * QuotaActor stays a thin shell and the logic is unit-testable.
 */
export interface QuotaState {
  readonly starts: readonly number[];
  readonly pausedUntil: number | null;
}

export interface QuotaRule {
  readonly jobs: number;
  readonly windowSec: number;
}

export const EMPTY_QUOTA: QuotaState = { starts: [], pausedUntil: null };

/** Default pause when a harness reports a rate limit without a reset time. */
export const DEFAULT_PAUSE_MS = 15 * 60 * 1000;

export function canStart({ state, rule, now }: { state: QuotaState; rule: QuotaRule | undefined; now: number }): boolean {
  if (state.pausedUntil !== null && now < state.pausedUntil) return false;
  if (!rule) return true;
  const since = now - rule.windowSec * 1000;
  return state.starts.filter((t) => t > since).length < rule.jobs;
}

export function recordStart({ state, rule, now }: { state: QuotaState; rule: QuotaRule | undefined; now: number }): QuotaState {
  const since = rule ? now - rule.windowSec * 1000 : now;
  return { ...state, starts: [...state.starts.filter((t) => t > since), now] };
}

export function recordRateLimit({ state, resetsAt, now }: { state: QuotaState; resetsAt: string | null; now: number }): QuotaState {
  const parsed = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  const until = Number.isFinite(parsed) && parsed > now ? parsed : now + DEFAULT_PAUSE_MS;
  return { ...state, pausedUntil: Math.max(until, state.pausedUntil ?? 0) };
}

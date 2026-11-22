/** Per-pool spend cap over a sliding window, as configured in `pools[].budget`. */
export interface BudgetRule {
  readonly usd: number;
  readonly windowSec: number;
}

/** Start of the budget window ending at `now`. */
export function budgetWindowStart(rule: BudgetRule, now: number): number {
  return now - rule.windowSec * 1000;
}

/** A pool is over budget once its spend in the window reaches the cap. */
export function overBudget(rule: BudgetRule | undefined, spentUsd: number): boolean {
  return rule !== undefined && spentUsd >= rule.usd;
}

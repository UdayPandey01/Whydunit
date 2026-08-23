import { COST_RETRY_RUPEES, DEFAULT_COST_RATIO, P_RETRY_SUCCEEDS } from "./config.ts";
import type { Cause } from "./world/types.ts";

export function stopThreshold(ratio: number = DEFAULT_COST_RATIO): number {
  return ratio / (ratio + 1);
}

export function stopThresholdFor(
  amountRupees: number,
  retryCostRupees: number = COST_RETRY_RUPEES,
): number {
  if (amountRupees <= 0) return 1;
  return amountRupees / (amountRupees + Math.max(retryCostRupees, 1e-9));
}

export const RETRYABLE: Cause[] = [
  "C1_EXECUTION_WINDOW",
  "C2_NOTIFICATION_FAIL",
  "C3_BALANCE_SHORTFALL",
];

export function decideCause(
  proba: Record<Cause, number>,
  threshold: number,
): { cause: Cause; stop: boolean } {
  if ((proba.C4_CANCELLATION ?? 0) >= threshold) {
    return { cause: "C4_CANCELLATION", stop: true };
  }
  let best: Cause = "C3_BALANCE_SHORTFALL";
  let bestP = -1;
  for (const c of RETRYABLE) {
    const p = proba[c] ?? 0;
    if (p > bestP) {
      bestP = p;
      best = c;
    }
  }
  return { cause: best, stop: false };
}

export function retryBudgetFor(
  amountRupees: number,
  maxRetries: number,
  retryCostRupees: number = COST_RETRY_RUPEES,
  pSuccess: number = P_RETRY_SUCCEEDS,
): number {
  const breakeven = retryCostRupees / Math.max(pSuccess, 1e-9);
  return Math.max(0, Math.min(maxRetries, Math.floor(amountRupees / breakeven)));
}

import { COST_RETRY_RUPEES, DEFAULT_COST_RATIO, P_RETRY_SUCCEEDS } from "./config.ts";
import type { Cause } from "./world/types.ts";

/**
 * The cost-sensitive stop rule, shared by the live agent and the offline policy
 * comparison so the two can never disagree about when to give up on a mandate.
 *
 * Argmax was the bug. It stops whenever C4 is merely the most likely class, which
 * treats a wrongful stop and a wrongful retry as equally bad. They are not: a
 * wrongful stop forfeits the entire mandate, a wrongful retry costs one retry.
 */
export function stopThreshold(ratio: number = DEFAULT_COST_RATIO): number {
  return ratio / (ratio + 1);
}

/**
 * Amount-aware form of the same inequality.
 *
 * Stop iff the expected cost of stopping beats the expected cost of retrying:
 *   (1 − p)·V  <  p·R   ⟺   p > V / (V + R)
 * where V is what a wrongful stop forfeits — the mandate itself — and R is what a
 * wrongful retry costs, which is a fixed number of rupees regardless of mandate
 * size. The flat `stopThreshold` is the special case where V/R is assumed constant.
 *
 * The practical effect: give up sooner on a ₹149 mandate (0.819) and fight much
 * harder for a ₹4,999 one (0.993), instead of charging both the same 0.952.
 */
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

/**
 * Decide whether to stop, and if not, which recoverable cause to act on.
 *
 * When P(C4) sits below the threshold we do NOT fall back to "C4 was argmax so
 * escalate" — we act on the best retryable explanation, because the money is
 * still worth chasing. That is the whole point of the fix.
 */
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

/**
 * How many retries a mandate is worth, as opposed to whether to stop at all.
 *
 * The stop threshold answers "is this customer gone?" and touches only C4. It does
 * nothing about a ₹149 balance shortfall being retried three times at ₹33 a go —
 * which is where the retry budget actually leaks. This answers the other question:
 * spend retry k only while its expected return still clears its cost.
 *
 *   EV(retry) = P(success) x V − R  >  0   ⟺   V > R / P
 *
 * Retries are assumed independent at P, so a mandate worth n x (R/P) is worth n
 * retries, capped at the per-cycle limit.
 */
export function retryBudgetFor(
  amountRupees: number,
  maxRetries: number,
  retryCostRupees: number = COST_RETRY_RUPEES,
  pSuccess: number = P_RETRY_SUCCEEDS,
): number {
  const breakeven = retryCostRupees / Math.max(pSuccess, 1e-9);
  return Math.max(0, Math.min(maxRetries, Math.floor(amountRupees / breakeven)));
}

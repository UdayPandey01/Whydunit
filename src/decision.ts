import { DEFAULT_COST_RATIO } from "./config.ts";
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

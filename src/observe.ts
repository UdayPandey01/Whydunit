import { OBSERVATION_SEED, RECEIPT_VISIBLE_RATE } from "./config.ts";
import { bernoulli, makeRng } from "./rng.ts";
import type { WorldRecord } from "./world/types.ts";

export type PriorAttempt = {
  timestamp: string;
  success: boolean;
  error_code: string | null;
};

export type LifecycleEvent = {
  type: "mandate.revoked";
  timestamp: string;
};

// Everything a merchant could actually pull from its own systems plus the PSP
// webhook stream. Defined positively, field by field -- NOT as Omit<WorldRecord,
// ...>, because subtraction would make the visible set a residue of the world
// type and any new world field would silently become visible.
export type ObservedAttempt = {
  attempt_id: string;
  mandate_id: string;
  timestamp: string;
  bank: string;
  amount: number;
  max_amount: number;
  frequency: "monthly";
  mandate_age_days: number;
  attempt_index: number;
  success: boolean;
  error_code: string | null;
  notification: {
    dispatched_at: string;
    hours_before_debit: number;
    receipt: "delivered" | "failed" | null;
  };
  prior_attempts: PriorAttempt[];
  lifecycle_events: LifecycleEvent[];
};

// Written out by hand on purpose. Deriving this from WorldRecord would make the
// guard self-defeating: adding a ground-truth field to ObservedAttempt would
// remove it from the derived union and the assertion would silently pass.
export const HIDDEN_KEYS = [
  "cause",
  "blockers",
  "multi_cause",
  "world",
  "customer_id",
  "timestamp_ms",
  "restricted_window",
  "balance_at_attempt",
  "salary_day",
  "days_since_salary",
  "notification_delivered_by_bank",
  "bank_outage_active",
  "churned_at",
  "churn_emits_event",
  "income",
  "spend_ratio",
] as const;

type HiddenKey = (typeof HIDDEN_KEYS)[number];
type AssertNever<T extends never> = T;

// Compile-time half of the boundary: `tsc --noEmit` fails the moment a hidden
// name appears anywhere in the observation shape. Runtime half is tests/boundary.
type _NoLeakTopLevel = AssertNever<Extract<keyof ObservedAttempt, HiddenKey>>;
type _NoLeakNested = AssertNever<
  Extract<
    | keyof ObservedAttempt["notification"]
    | keyof PriorAttempt
    | keyof LifecycleEvent,
    HiddenKey
  >
>;

// THE BOUNDARY. Every field is copied explicitly; there is deliberately no
// spread of a world record anywhere in this file, because a spread is exactly
// how a newly added world field would leak through unnoticed.
export function observe(world: WorldRecord[], seed: number = OBSERVATION_SEED): ObservedAttempt[] {
  const rng = makeRng(seed);
  const priors = new Map<string, PriorAttempt[]>();
  const out: ObservedAttempt[] = [];

  for (const w of world) {
    const prior = priors.get(w.mandate_id) ?? [];

    // Partial observability: the merchant always knows it dispatched, but only
    // sometimes gets a delivery receipt back from the PSP.
    const receipt = bernoulli(rng, RECEIPT_VISIBLE_RATE)
      ? w.world.notification_delivered_by_bank
        ? "delivered"
        : "failed"
      : null;

    // Only the ~60% of cancellations that actually fire a webhook are visible.
    const lifecycle_events: LifecycleEvent[] =
      w.world.churned_at !== null && w.world.churn_emits_event
        ? [{ type: "mandate.revoked", timestamp: w.world.churned_at }]
        : [];

    out.push({
      attempt_id: w.attempt_id,
      mandate_id: w.mandate_id,
      timestamp: w.timestamp,
      bank: w.bank,
      amount: w.amount,
      max_amount: w.max_amount,
      frequency: w.frequency,
      mandate_age_days: w.mandate_age_days,
      attempt_index: w.attempt_index,
      success: w.success,
      error_code: w.error_code,
      notification: {
        dispatched_at: w.notification_dispatched_at,
        hours_before_debit: w.notification_hours_before_debit,
        receipt,
      },
      prior_attempts: prior.map((p) => ({
        timestamp: p.timestamp,
        success: p.success,
        error_code: p.error_code,
      })),
      lifecycle_events,
    });

    prior.push({ timestamp: w.timestamp, success: w.success, error_code: w.error_code });
    priors.set(w.mandate_id, prior);
  }

  return out;
}

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

type _NoLeakTopLevel = AssertNever<Extract<keyof ObservedAttempt, HiddenKey>>;
type _NoLeakNested = AssertNever<
  Extract<
    | keyof ObservedAttempt["notification"]
    | keyof PriorAttempt
    | keyof LifecycleEvent,
    HiddenKey
  >
>;

export function observe(world: WorldRecord[], seed: number = OBSERVATION_SEED): ObservedAttempt[] {
  const rng = makeRng(seed);
  const priors = new Map<string, PriorAttempt[]>();
  const out: ObservedAttempt[] = [];

  for (const w of world) {
    const prior = priors.get(w.mandate_id) ?? [];

    const receipt = bernoulli(rng, RECEIPT_VISIBLE_RATE)
      ? w.world.notification_delivered_by_bank
        ? "delivered"
        : "failed"
      : null;

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

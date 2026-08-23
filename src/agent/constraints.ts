import { NOTIFY_MIN_LEAD_HOURS } from "../config.ts";
import { isRestrictedTime } from "../schedule.ts";
import { HOUR_MS } from "../time.ts";
import type { Cause } from "../world/types.ts";

export const MAX_INTERVENTIONS_PER_CYCLE = 3;

export type ActionName =
  | "reschedule"
  | "refire_notification_then_reschedule"
  | "escalate_to_human"
  | "stop";

export const EFFECTFUL: ActionName[] = ["reschedule", "refire_notification_then_reschedule"];

export const CHECKS = {
  MAX_INTERVENTIONS: "max_interventions_per_cycle",
  NOT_RESTRICTED: "never_schedule_in_restricted_window",
  NOTIFY_LEAD: "never_schedule_debit_within_24h_of_notification",
  NOT_CANCELLED: "never_retry_after_cancellation",
} as const;

export type Plan = {
  idempotency_key: string;
  mandate_id: string;
  cycle: string;
  attempt_no: number;
  source_attempt: string;
  cause: Cause | null;
  confidence: number;
  action: ActionName;
  decided_at: number;
  scheduled_at: number | null;
  notification_dispatch_at: number | null;
};

export type ConstraintContext = {
  interventions_used: number;
  revoked_at: number | null;
};

declare const CHECKED: unique symbol;
export type CheckedPlan = Plan & { readonly [CHECKED]: true };

export type CheckResult = {
  ok: boolean;
  plan: CheckedPlan | null;
  passed: string[];
  failed: string[];
  skipped: string[];
};

export function checkConstraints(plan: Plan, ctx: ConstraintContext): CheckResult {
  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const effectful = EFFECTFUL.includes(plan.action);

  const record = (name: string, applies: boolean, ok: boolean) => {
    if (!applies) skipped.push(name);
    else if (ok) passed.push(name);
    else failed.push(name);
  };

  record(CHECKS.MAX_INTERVENTIONS, effectful, ctx.interventions_used < MAX_INTERVENTIONS_PER_CYCLE);

  record(
    CHECKS.NOT_CANCELLED,
    effectful,
    plan.cause !== "C4_CANCELLATION" &&
      (ctx.revoked_at === null || (plan.scheduled_at !== null && plan.scheduled_at < ctx.revoked_at)),
  );

  const schedules = plan.scheduled_at !== null;
  record(CHECKS.NOT_RESTRICTED, schedules, schedules && !isRestrictedTime(plan.scheduled_at!));

  record(
    CHECKS.NOTIFY_LEAD,
    schedules,
    schedules &&
      plan.notification_dispatch_at !== null &&
      (plan.scheduled_at! - plan.notification_dispatch_at) / HOUR_MS >= NOTIFY_MIN_LEAD_HOURS,
  );

  const ok = failed.length === 0;
  return { ok, plan: ok ? (plan as CheckedPlan) : null, passed, failed, skipped };
}

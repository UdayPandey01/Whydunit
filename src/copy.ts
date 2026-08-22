import type { Cause } from "./world/types.ts";

export const CAUSE_CODE: Record<Cause, string> = {
  C1_EXECUTION_WINDOW: "C1",
  C2_NOTIFICATION_FAIL: "C2",
  C3_BALANCE_SHORTFALL: "C3",
  C4_CANCELLATION: "C4",
};

export const CAUSE_NAME: Record<Cause, string> = {
  C1_EXECUTION_WINDOW: "Execution Window",
  C2_NOTIFICATION_FAIL: "Notification Failure",
  C3_BALANCE_SHORTFALL: "Balance Shortfall",
  C4_CANCELLATION: "Cancellation / Churn",
};

export const CAUSE_MEANING: Record<Cause, string> = {
  C1_EXECUTION_WINDOW: "Debited inside the NPCI 10:00-13:00 restricted window",
  C2_NOTIFICATION_FAIL: "Pre-debit notice not delivered 24h before the debit",
  C3_BALANCE_SHORTFALL: "Customer likely lacked sufficient balance",
  C4_CANCELLATION: "Customer has decided to stop paying",
};

export const CAUSE_ACTION: Record<Cause, string> = {
  C1_EXECUTION_WINDOW: "RESCHEDULE",
  C2_NOTIFICATION_FAIL: "NOTIFY → RETRY",
  C3_BALANCE_SHORTFALL: "SMART RETRY",
  C4_CANCELLATION: "STOP",
};

export const CAUSE_ACTION_DETAIL: Record<Cause, string> = {
  C1_EXECUTION_WINDOW: "move to a safe hour",
  C2_NOTIFICATION_FAIL: "resend notice + retry",
  C3_BALANCE_SHORTFALL: "retry at next credit",
  C4_CANCELLATION: "no further retries",
};

export const ACTION_LABEL: Record<string, string> = {
  reschedule: "RESCHEDULE",
  refire_notification_then_reschedule: "NOTIFY → RETRY",
  escalate_to_human: "HUMAN REVIEW",
  stop: "STOP",
};

export const OUTCOME_LABEL: Record<string, string> = {
  recovered: "Recovered",
  failed: "Still failing",
  not_applicable: "No retry attempted",
  blocked_by_constraint: "Blocked by a safety rule",
};

export const CYCLE_LABEL: Record<string, string> = {
  recovered: "Recovered",
  escalated: "Sent to human review",
  exhausted: "Retry budget spent",
  stopped: "Stopped (cancelled)",
};

/** The four hard constraints, in plain language. */
export const CHECK_LABEL: Record<string, string> = {
  max_interventions_per_cycle: "Retry limit not exceeded",
  never_schedule_in_restricted_window: "Outside NPCI restricted window",
  never_schedule_debit_within_24h_of_notification: "Notice sent 24h+ before debit",
  never_retry_after_cancellation: "Mandate still active",
};

export const REASON_LABEL: Record<string, string> = {
  insufficient_history: "Too little history to judge",
  ambiguous_top_two: "Two causes equally likely",
  multi_cause_conflict: "Conflicting evidence",
  outside_training_support: "Unfamiliar bank or pattern",
};

export const POLICY_LABEL: Record<string, string> = {
  do_nothing: "Do nothing",
  naive_retry: "Naive retry (T+24/72/168h)",
  window_aware_retry: "Window-aware retry",
  rule_policy: "Rule-based",
  model_policy: "WhyDunit",
  oracle_policy: "Oracle (ground truth)",
};

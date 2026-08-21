import { RESTRICTED_END_HOUR, RESTRICTED_START_HOUR } from "./config.ts";
import type { ObservedAttempt } from "./observe.ts";
import { DAY_MS, HOUR_MS, istParts, istWeekday, round } from "./time.ts";

// Identity fields live OUTSIDE `features` so they can be used for splitting but
// can never end up in the design matrix. `label` is not part of this type at all:
// the join against ground truth happens in cli.ts, after this function has run.
export type FeatureRow = {
  attempt_id: string;
  mandate_id: string;
  bank: string;
  day_index: number;
  timestamp: string;
  features: Record<string, number | null>;
};

const FLEET_WINDOW_MS = 14 * DAY_MS;
const BANK_WINDOW_MS = 7 * DAY_MS;
const BURST_WINDOW_MS = 24 * HOUR_MS;
const BURST_BASELINE_MS = 30 * DAY_MS;
const DECLINE_CODES = ["Z9", "U30", "U69", "ZM", "ZA"];

type Point = { ms: number; failed: number; receipt_seen: number; receipt_failed: number };

// Prefix-summed, time-sorted series. Built once per key (fleet, per hour, per
// bank) so every trailing-window question is a pair of binary searches.
type Index = { ms: number[]; n: number[]; failed: number[]; seen: number[]; recv_failed: number[] };

function buildIndex(points: Point[]): Index {
  const sorted = [...points].sort((a, b) => a.ms - b.ms);
  const idx: Index = { ms: [], n: [0], failed: [0], seen: [0], recv_failed: [0] };
  for (const p of sorted) {
    idx.ms.push(p.ms);
    idx.n.push(idx.n[idx.n.length - 1]! + 1);
    idx.failed.push(idx.failed[idx.failed.length - 1]! + p.failed);
    idx.seen.push(idx.seen[idx.seen.length - 1]! + p.receipt_seen);
    idx.recv_failed.push(idx.recv_failed[idx.recv_failed.length - 1]! + p.receipt_failed);
  }
  return idx;
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Half-open [from, to). `to` is always the attempt's own timestamp, so an attempt
// never contributes to its own trailing statistics.
function rangeStats(idx: Index, from: number, to: number) {
  const a = lowerBound(idx.ms, from);
  const b = lowerBound(idx.ms, to);
  const n = idx.n[b]! - idx.n[a]!;
  const failed = idx.failed[b]! - idx.failed[a]!;
  const seen = idx.seen[b]! - idx.seen[a]!;
  const recvFailed = idx.recv_failed[b]! - idx.recv_failed[a]!;
  return {
    n,
    fail_rate: n === 0 ? null : failed / n,
    receipt_fail_rate: seen === 0 ? null : recvFailed / seen,
  };
}

function toPoint(o: ObservedAttempt, ms: number): Point {
  return {
    ms,
    failed: o.success ? 0 : 1,
    receipt_seen: o.notification.receipt === null ? 0 : 1,
    receipt_failed: o.notification.receipt === "failed" ? 1 : 0,
  };
}

function excess(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : round(a - b, 5);
}

// ---------- the six families, one per invariance dimension ----------

// Varies with hour of day. C1's whole signature.
function temporal(ms: number, dayIndex: number): Record<string, number | null> {
  const p = istParts(ms);
  const restricted = p.hour >= RESTRICTED_START_HOUR && p.hour < RESTRICTED_END_HOUR;
  return {
    hour: p.hour,
    minute_of_day: p.hour * 60 + p.minute,
    day_of_month: p.day,
    day_of_week: istWeekday(ms),
    day_index: dayIndex,
    // NPCI publishes the restricted window, so knowing the rule is not world state.
    in_restricted_window: restricted ? 1 : 0,
    hours_into_restricted_window: restricted ? round(p.hour - RESTRICTED_START_HOUR + p.minute / 60, 3) : 0,
  };
}

// How this attempt's clock position is behaving across the whole fleet right now.
function clockRelative(ms: number, hourIdx: Index, fleetIdx: Index): Record<string, number | null> {
  const hour = rangeStats(hourIdx, ms - FLEET_WINDOW_MS, ms);
  const fleet = rangeStats(fleetIdx, ms - FLEET_WINDOW_MS, ms);
  return {
    hour_fail_rate_14d: hour.fail_rate === null ? null : round(hour.fail_rate, 5),
    hour_fail_excess_14d: excess(hour.fail_rate, fleet.fail_rate),
    hour_n_14d: hour.n,
  };
}

// Varies with bank and burst window. C2's signature. Deliberately RELATIVE, with
// no raw bank identity anywhere -- otherwise the bank-holdout split is meaningless.
function bankRelative(ms: number, bankIdx: Index, fleetIdx: Index): Record<string, number | null> {
  const wk = rangeStats(bankIdx, ms - BANK_WINDOW_MS, ms);
  const day = rangeStats(bankIdx, ms - BURST_WINDOW_MS, ms);
  const base = rangeStats(bankIdx, ms - BURST_BASELINE_MS, ms);
  const fleetWk = rangeStats(fleetIdx, ms - BANK_WINDOW_MS, ms);
  const fleetDay = rangeStats(fleetIdx, ms - BURST_WINDOW_MS, ms);

  // Binomial z of the last 24h against the bank's own 30d baseline: a spike in one
  // bank while the fleet is calm is what an outage looks like from outside.
  let burstZ: number | null = null;
  if (day.n > 0 && base.fail_rate !== null && base.fail_rate > 0 && base.fail_rate < 1 && day.fail_rate !== null) {
    const se = Math.sqrt((base.fail_rate * (1 - base.fail_rate)) / day.n);
    burstZ = se > 0 ? round((day.fail_rate - base.fail_rate) / se, 4) : null;
  }
  return {
    bank_fail_rate_7d: wk.fail_rate === null ? null : round(wk.fail_rate, 5),
    bank_fail_excess_7d: excess(wk.fail_rate, fleetWk.fail_rate),
    bank_fail_rate_24h: day.fail_rate === null ? null : round(day.fail_rate, 5),
    bank_fail_excess_24h: excess(day.fail_rate, fleetDay.fail_rate),
    bank_burst_z: burstZ,
    bank_receipt_fail_rate_24h: day.receipt_fail_rate === null ? null : round(day.receipt_fail_rate, 5),
    bank_n_24h: day.n,
  };
}

// Varies with customer and day-of-month. C3's signature. Mandate identity is the
// merchant-visible stand-in for the customer.
function customerRelative(o: ObservedAttempt, fleetIdx: Index, ms: number): Record<string, number | null> {
  const priors = o.prior_attempts;
  const successes = priors.filter((p) => p.success);
  const last = successes[successes.length - 1];
  const fleet = rangeStats(fleetIdx, ms - FLEET_WINDOW_MS, ms);
  const rate = priors.length === 0 ? null : successes.length / priors.length;
  const fleetSuccess = fleet.fail_rate === null ? null : 1 - fleet.fail_rate;
  return {
    amount: o.amount,
    log_amount: round(Math.log(o.amount), 5),
    amount_over_max: round(o.amount / o.max_amount, 5),
    mandate_prior_n: priors.length,
    mandate_prior_success_rate: rate,
    mandate_success_excess: excess(rate, fleetSuccess),
    days_since_last_success: last === undefined ? null : round((ms - Date.parse(last.timestamp)) / DAY_MS, 3),
  };
}

function notification(o: ObservedAttempt): Record<string, number | null> {
  const lead = o.notification.hours_before_debit;
  return {
    notify_lead_hours: lead,
    notify_lead_under_24: lead < 24 ? 1 : 0,
    notify_dispatch_hour: istParts(Date.parse(o.notification.dispatched_at)).hour,
    // Three-state on purpose: null is "no receipt came back", which is itself
    // informative and must not be collapsed into "not delivered".
    receipt_delivered: o.notification.receipt === null ? null : o.notification.receipt === "delivered" ? 1 : 0,
    receipt_missing: o.notification.receipt === null ? 1 : 0,
  };
}

// The invariance probe. If prior failures are spread across different hours,
// different days and a delivered notification, nothing situational explains them.
function history(o: ObservedAttempt, ms: number): Record<string, number | null> {
  const priors = o.prior_attempts;
  const failures = priors.filter((p) => !p.success);
  const failHours = failures.map((p) => istParts(Date.parse(p.timestamp)).hour);

  let consecutive = 0;
  for (let i = priors.length - 1; i >= 0; i--) {
    if (priors[i]!.success) break;
    consecutive++;
  }

  // Causal filter: a revoke webhook that arrives AFTER this attempt was not
  // available when the attempt was made, so it must not be visible here.
  const revoked = o.lifecycle_events
    .map((e) => Date.parse(e.timestamp))
    .filter((t) => t <= ms)
    .sort((a, b) => a - b)[0];

  return {
    attempt_index: o.attempt_index,
    mandate_age_days: o.mandate_age_days,
    consecutive_prior_failures: consecutive,
    all_prior_failed: priors.length === 0 ? null : failures.length === priors.length ? 1 : 0,
    prior_distinct_fail_hours: new Set(failHours).size,
    prior_fail_hour_spread: failHours.length < 2 ? null : Math.max(...failHours) - Math.min(...failHours),
    prior_distinct_error_codes: new Set(failures.map((p) => p.error_code)).size,
    revoked_before_attempt: revoked === undefined ? 0 : 1,
    hours_since_revoke: revoked === undefined ? null : round((ms - revoked) / HOUR_MS, 3),
  };
}

// The attempt's own decline code. Not a derived family -- it is the rawest thing
// the merchant has, and omitting it would be perverse. Kept lossy by construction
// in config.ERROR_CODE_WEIGHTS.
function decline(o: ObservedAttempt): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const c of DECLINE_CODES) out[`code_${c}`] = o.error_code === c ? 1 : 0;
  return out;
}

/**
 * Reads observations ONLY. Every trailing window is half-open on the attempt's own
 * timestamp and mandate history comes from `prior_attempts`, so no feature can see
 * anything that had not happened yet -- the Phase 3 agent has to decide at failure
 * time, and a model trained on look-ahead would be useless to it.
 *
 * Rows are emitted for FAILED attempts only; successes still feed the trailing
 * statistics and the mandate history.
 */
export function computeFeatures(observations: ObservedAttempt[]): FeatureRow[] {
  const withMs = observations.map((o) => ({ o, ms: Date.parse(o.timestamp) }));
  withMs.sort((a, b) => a.ms - b.ms || a.o.attempt_id.localeCompare(b.o.attempt_id));
  const originMs = withMs.length === 0 ? 0 : withMs[0]!.ms;

  const fleetPoints: Point[] = [];
  const byHour = new Map<number, Point[]>();
  const byBank = new Map<string, Point[]>();
  for (const { o, ms } of withMs) {
    const p = toPoint(o, ms);
    fleetPoints.push(p);
    const h = istParts(ms).hour;
    (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(p);
    (byBank.get(o.bank) ?? byBank.set(o.bank, []).get(o.bank)!).push(p);
  }
  const fleetIdx = buildIndex(fleetPoints);
  const hourIdx = new Map([...byHour].map(([k, v]) => [k, buildIndex(v)]));
  const bankIdx = new Map([...byBank].map(([k, v]) => [k, buildIndex(v)]));

  const rows: FeatureRow[] = [];
  for (const { o, ms } of withMs) {
    if (o.success) continue;
    const dayIndex = Math.floor((ms - originMs) / DAY_MS);
    const hIdx = hourIdx.get(istParts(ms).hour)!;
    const bIdx = bankIdx.get(o.bank)!;
    rows.push({
      attempt_id: o.attempt_id,
      mandate_id: o.mandate_id,
      bank: o.bank,
      day_index: dayIndex,
      timestamp: o.timestamp,
      features: {
        ...temporal(ms, dayIndex),
        ...clockRelative(ms, hIdx, fleetIdx),
        ...bankRelative(ms, bIdx, fleetIdx),
        ...customerRelative(o, fleetIdx, ms),
        ...notification(o),
        ...history(o, ms),
        ...decline(o),
      },
    });
  }
  return rows;
}

export const FEATURE_FAMILIES: Record<string, string> = {
  temporal: "raw clock position of the attempt (C1)",
  clock_relative: "this hour vs the fleet, trailing 14d (C1)",
  bank_relative: "this bank vs the fleet, trailing 24h/7d/30d burst z (C2)",
  customer_relative: "this mandate vs its own history and the fleet (C3)",
  notification: "dispatch lead and partial delivery receipts (C2)",
  history: "prior-failure invariance probes and revoke webhooks (C4)",
  decline: "the attempt's own decline code, one-hot",
};

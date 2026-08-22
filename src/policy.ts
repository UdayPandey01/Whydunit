import { COST_RETRY_RUPEES, DEFAULT_COST_RATIO, NOTIFY_MIN_LEAD_HOURS, START_MS, HORIZON_DAYS } from "./config.ts";
import { decideCause, retryBudgetFor, stopThreshold, stopThresholdFor } from "./decision.ts";
import { clusterBootstrapCI } from "./bootstrap.ts";
import { makeRng } from "./rng.ts";
import { nextMonthDay, SAFE_HOUR, toSafeHour } from "./schedule.ts";
import { attemptAt } from "./world/replay.ts";
import type { Notify } from "./world/replay.ts";
import { DAY_MS, HOUR_MS, istMs, istParts } from "./time.ts";
import { wasDeliveredByBank } from "./world/notification.ts";
import type { Cause, Customer, Mandate, WorldRecord } from "./world/types.ts";

const POLICY_SEED = 777001;
const RETRY_BUDGET = 3;
const HORIZON_END_MS = START_MS + HORIZON_DAYS * DAY_MS;

export type Action = { at: number; renotify: boolean };

// ---------- the policies ----------

function naiveSchedule(t: number): Action[] {
  return [24, 72, 168].map((h) => ({ at: t + h * HOUR_MS, renotify: false }));
}

function windowAwareSchedule(t: number): Action[] {
  return [24, 72, 168].map((h) => ({ at: toSafeHour(t + h * HOUR_MS), renotify: false }));
}

// Cause-matched. Each branch is the cheapest action that addresses THAT cause and
// nothing else; C4 deliberately spends no retries at all.
function modelSchedule(t: number, predicted: Cause): Action[] {
  switch (predicted) {
    case "C1_EXECUTION_WINDOW": {
      const p = istParts(t);
      const sameDay = istMs(p.year, p.month, p.day, SAFE_HOUR, p.minute);
      const first = sameDay > t ? sameDay : toSafeHour(t + 24 * HOUR_MS);
      return [
        { at: first, renotify: false },
        { at: toSafeHour(first + 24 * HOUR_MS), renotify: false },
        { at: toSafeHour(first + 72 * HOUR_MS), renotify: false },
      ];
    }
    case "C2_NOTIFICATION_FAIL":
      return [26, 50, 96].map((h) => ({ at: toSafeHour(t + h * HOUR_MS), renotify: true }));
    case "C3_BALANCE_SHORTFALL":
      return [
        { at: toSafeHour(t + 72 * HOUR_MS), renotify: false },
        { at: toSafeHour(t + 168 * HOUR_MS), renotify: false },
        { at: nextMonthDay(t, 2), renotify: false },
      ];
    case "C4_CANCELLATION":
      return [];
  }
}

export type PolicyOutcome = {
  attempt_id: string;
  mandate_id: string;
  amount: number;
  recovered: boolean;
  retries_spent: number;
};

export function runPolicy(
  failures: WorldRecord[],
  customers: Map<string, Customer>,
  mandates: Map<string, Mandate>,
  schedule: (rec: WorldRecord) => Action[],
): PolicyOutcome[] {
  return failures.map((rec, i) => {
    const customer = customers.get(rec.customer_id)!;
    const mandate = mandates.get(rec.mandate_id)!;
    const rng = makeRng(POLICY_SEED + i);
    const t = rec.timestamp_ms;

    let notify: Notify = {
      dispatchMs: Date.parse(rec.notification_dispatched_at),
      delivered: rec.world.notification_delivered_by_bank,
    };

    let recovered = false;
    let spent = 0;
    for (const action of schedule(rec).slice(0, RETRY_BUDGET)) {
      // A retry that falls outside the observation horizon cannot be adjudicated,
      // so it is neither spent nor credited.
      if (action.at > HORIZON_END_MS || action.at <= t) continue;
      if (action.renotify) {
        const dispatchMs = action.at - (NOTIFY_MIN_LEAD_HOURS + 2) * HOUR_MS;
        notify = { dispatchMs, delivered: wasDeliveredByBank(rec.bank, dispatchMs, rng) };
      }
      spent++;
      if (attemptAt(customer, mandate, action.at, notify).success) {
        recovered = true;
        break;
      }
    }
    return {
      attempt_id: rec.attempt_id,
      mandate_id: rec.mandate_id,
      amount: rec.amount,
      recovered,
      retries_spent: spent,
    };
  });
}

export function schedulesFor(
  probabilities: Map<string, Record<Cause, number>>,
  rulePredictions: Map<string, Cause>,
  threshold: number = stopThreshold(DEFAULT_COST_RATIO),
  retryCostRupees: number = COST_RETRY_RUPEES,
): Record<string, (rec: WorldRecord) => Action[]> {
  // The rule scores one class with certainty, so an amount-aware threshold has to
  // be applied to the same belief the flat one saw: P(C4) = 1 when the rule says
  // C4, 0 otherwise. That keeps the flat/EV comparison about the THRESHOLD.
  const ruleProba = (c: Cause): Record<Cause, number> => ({
    C1_EXECUTION_WINDOW: c === "C1_EXECUTION_WINDOW" ? 1 : 0,
    C2_NOTIFICATION_FAIL: c === "C2_NOTIFICATION_FAIL" ? 1 : 0,
    C3_BALANCE_SHORTFALL: c === "C3_BALANCE_SHORTFALL" ? 1 : 0,
    C4_CANCELLATION: c === "C4_CANCELLATION" ? 1 : 0,
  });

  const drive = (
    r: WorldRecord,
    proba: Record<Cause, number> | undefined,
    th: number,
  ): Action[] => {
    if (proba === undefined) return naiveSchedule(r.timestamp_ms);
    const d = decideCause(proba, th);
    return d.stop ? [] : modelSchedule(r.timestamp_ms, d.cause);
  };

  return {
    do_nothing: () => [],
    naive_retry: (r) => naiveSchedule(r.timestamp_ms),
    // Cost-sensitive: stop only when P(C4) clears the threshold, otherwise act on
    // the best RETRYABLE cause rather than abandoning recoverable money.
    model_policy: (r) => drive(r, probabilities.get(r.attempt_id), threshold),
    // Same predictions, same actions, but the threshold is priced from THIS
    // mandate's value rather than a fleet-wide ratio.
    model_ev: (r) => drive(r, probabilities.get(r.attempt_id), stopThresholdFor(r.amount, retryCostRupees)),
    // The same cause-matched actions, driven by four if-statements instead of a
    // gradient-boosted model. If this matches model_policy, the classifier is
    // decorative and the value lives entirely in the action mapping.
    rule_policy: (r) => {
      const p = rulePredictions.get(r.attempt_id);
      return p === undefined ? naiveSchedule(r.timestamp_ms) : modelSchedule(r.timestamp_ms, p);
    },
    // Amount-weighting is a POLICY change, not a model change, so the rule gets it
    // too. Comparing an EV model against a flat rule would be a rigged fight.
    rule_ev: (r) => {
      const p = rulePredictions.get(r.attempt_id);
      return p === undefined
        ? naiveSchedule(r.timestamp_ms)
        : drive(r, ruleProba(p), stopThresholdFor(r.amount, retryCostRupees));
    },
    // Amount-weighted BUDGET rather than amount-weighted threshold: same cause,
    // same timings, but a mandate only buys as many retries as its expected return
    // pays for. This is the knob that touches C1/C2/C3 spend, not just C4 stopping.
    model_ev_budget: (r) => {
      const acts = drive(r, probabilities.get(r.attempt_id), stopThresholdFor(r.amount, retryCostRupees));
      return acts.slice(0, retryBudgetFor(r.amount, RETRY_BUDGET, retryCostRupees));
    },
    // Diagnostic, not one of the three requested baselines: the naive schedule
    // with the published NPCI window applied. Isolates how much the CLASSIFIER
    // adds over simply knowing the rule.
    window_aware_retry: (r) => windowAwareSchedule(r.timestamp_ms),
    // Diagnostic ceiling: the same cause-matched actions driven by ground truth.
    oracle_policy: (r) => modelSchedule(r.timestamp_ms, r.cause!),
  };
}

export function bootstrapCI(
  outcomes: PolicyOutcome[],
  metric: (rows: PolicyOutcome[]) => number,
  n = 1000,
  seed = 4242,
): [number, number] {
  return clusterBootstrapCI(outcomes, (o) => o.mandate_id, metric, n, seed);
}

// Paired on the SAME resampled mandates. Comparing two independent CIs answers a
// weaker question than "is the difference non-zero", and these policies run over
// an identical batch, so the paired version is the right test.
export function pairedDeltaCI(
  a: PolicyOutcome[],
  b: PolicyOutcome[],
  metric: (rows: PolicyOutcome[]) => number,
  n = 1000,
  seed = 4242,
): { delta: number; ci: [number, number] } {
  const byMandate = new Map<string, { a: PolicyOutcome[]; b: PolicyOutcome[] }>();
  const bById = new Map(b.map((o) => [o.attempt_id, o]));
  for (const o of a) {
    const e = byMandate.get(o.mandate_id) ?? { a: [], b: [] };
    e.a.push(o);
    e.b.push(bById.get(o.attempt_id)!);
    byMandate.set(o.mandate_id, e);
  }
  const keys = [...byMandate.keys()];
  const rng = makeRng(seed);
  const draws: number[] = [];
  for (let i = 0; i < n; i++) {
    const sa: PolicyOutcome[] = [];
    const sb: PolicyOutcome[] = [];
    for (let j = 0; j < keys.length; j++) {
      const e = byMandate.get(keys[Math.floor(rng() * keys.length)]!)!;
      sa.push(...e.a);
      sb.push(...e.b);
    }
    draws.push(metric(sa) - metric(sb));
  }
  draws.sort((x, y) => x - y);
  return { delta: metric(a) - metric(b), ci: [draws[Math.floor(0.025 * n)]!, draws[Math.floor(0.975 * n)]!] };
}

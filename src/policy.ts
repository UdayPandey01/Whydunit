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

function naiveSchedule(t: number): Action[] {
  return [24, 72, 168].map((h) => ({ at: t + h * HOUR_MS, renotify: false }));
}

function windowAwareSchedule(t: number): Action[] {
  return [24, 72, 168].map((h) => ({ at: toSafeHour(t + h * HOUR_MS), renotify: false }));
}

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

    model_policy: (r) => drive(r, probabilities.get(r.attempt_id), threshold),

    model_ev: (r) => drive(r, probabilities.get(r.attempt_id), stopThresholdFor(r.amount, retryCostRupees)),

    rule_policy: (r) => {
      const p = rulePredictions.get(r.attempt_id);
      return p === undefined ? naiveSchedule(r.timestamp_ms) : modelSchedule(r.timestamp_ms, p);
    },

    rule_ev: (r) => {
      const p = rulePredictions.get(r.attempt_id);
      return p === undefined
        ? naiveSchedule(r.timestamp_ms)
        : drive(r, ruleProba(p), stopThresholdFor(r.amount, retryCostRupees));
    },

    model_ev_budget: (r) => {
      const acts = drive(r, probabilities.get(r.attempt_id), stopThresholdFor(r.amount, retryCostRupees));
      return acts.slice(0, retryBudgetFor(r.amount, RETRY_BUDGET, retryCostRupees));
    },

    window_aware_retry: (r) => windowAwareSchedule(r.timestamp_ms),

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

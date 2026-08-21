import { NOTIFY_MIN_LEAD_HOURS, START_MS, HORIZON_DAYS } from "./config.ts";
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
  predictions: Map<string, Cause>,
  rulePredictions: Map<string, Cause>,
): Record<string, (rec: WorldRecord) => Action[]> {
  return {
    do_nothing: () => [],
    naive_retry: (r) => naiveSchedule(r.timestamp_ms),
    model_policy: (r) => {
      const p = predictions.get(r.attempt_id);
      return p === undefined ? naiveSchedule(r.timestamp_ms) : modelSchedule(r.timestamp_ms, p);
    },
    // The same cause-matched actions, driven by four if-statements instead of a
    // gradient-boosted model. If this matches model_policy, the classifier is
    // decorative and the value lives entirely in the action mapping.
    rule_policy: (r) => {
      const p = rulePredictions.get(r.attempt_id);
      return p === undefined ? naiveSchedule(r.timestamp_ms) : modelSchedule(r.timestamp_ms, p);
    },
    // Diagnostic, not one of the three requested baselines: the naive schedule
    // with the published NPCI window applied. Isolates how much the CLASSIFIER
    // adds over simply knowing the rule.
    window_aware_retry: (r) => windowAwareSchedule(r.timestamp_ms),
    // Diagnostic ceiling: the same cause-matched actions driven by ground truth.
    oracle_policy: (r) => modelSchedule(r.timestamp_ms, r.cause!),
  };
}

// Resamples MANDATES, matching the cluster bootstrap in evaluate.py.
export function bootstrapCI(
  outcomes: PolicyOutcome[],
  metric: (rows: PolicyOutcome[]) => number,
  n = 1000,
  seed = 4242,
): [number, number] {
  const byMandate = new Map<string, PolicyOutcome[]>();
  for (const o of outcomes) {
    const arr = byMandate.get(o.mandate_id) ?? [];
    arr.push(o);
    byMandate.set(o.mandate_id, arr);
  }
  const keys = [...byMandate.keys()];
  const rng = makeRng(seed);
  const draws: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample: PolicyOutcome[] = [];
    for (let j = 0; j < keys.length; j++) {
      sample.push(...byMandate.get(keys[Math.floor(rng() * keys.length)]!)!);
    }
    draws.push(metric(sample));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * n)]!, draws[Math.floor(0.975 * n)]!];
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

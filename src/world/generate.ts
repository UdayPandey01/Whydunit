import {
  AMOUNT_WEIGHTS, BANKS, BUFFER_RATIO_MEDIAN, BUFFER_RATIO_SIGMA, CHURN_HAZARD_SIGMA,
  ERROR_CODE_WEIGHTS, HORIZON_DAYS, INCOME_MEDIAN, INCOME_SIGMA, LATE_DISPATCH_RATE,
  LATE_LEAD_HOURS_MAX, LATE_LEAD_HOURS_MIN, MAX_AMOUNT_MULTIPLE, N_MANDATES,
  NOTIFY_LEAD_HOURS_MAX, NOTIFY_LEAD_HOURS_MIN, NOTIFY_MIN_LEAD_HOURS,
  PREEXISTING_AGE_DAYS_MAX, PREEXISTING_RATE, RESTRICTED_HOURS, SAFE_HOUR_WEIGHTS,
  SALARY_DAY_WEIGHTS, SALARY_DELAY_MAX_DAYS, SALARY_DELAY_PROB, SEED,
  SHOCK_FRACTION_MAX, SHOCK_FRACTION_MIN, SHOCK_PROB_PER_MONTH, SPEND_RATIO_MAX,
  SPEND_RATIO_MEAN, SPEND_RATIO_MIN, SPEND_RATIO_SD, START_MS, WINDOW_HIT_RATE,
} from "../config.ts";
import { bernoulli, clamp, int, lognormal, makeRng, normal, uniform, weighted } from "../rng.ts";
import type { Rng } from "../rng.ts";
import { DAY_MS, HOUR_MS, daysInMonth, istMs, istParts, round, toIso } from "../time.ts";
import { balanceAt } from "./balance.ts";
import { drawChurn } from "./churn.ts";
import { isBankOutage, wasDeliveredByBank } from "./notification.ts";
import type { Cause, Customer, Mandate, Shock, WorldRecord } from "./types.ts";

export type GenerateOptions = {
  seed?: number;
  mandates?: number;
  horizonDays?: number;
};

const MONTHS_SPANNED = 6;

function drawCustomer(rng: Rng, i: number): Customer {
  const bankShares = Object.fromEntries(
    Object.entries(BANKS).map(([b, v]) => [b, v.share]),
  ) as Record<string, number>;

  const salary_delays: number[] = [];
  for (let m = 0; m < MONTHS_SPANNED; m++) {
    salary_delays.push(bernoulli(rng, SALARY_DELAY_PROB) ? int(rng, 1, SALARY_DELAY_MAX_DAYS) : 0);
  }
  const income = round(clamp(lognormal(rng, INCOME_MEDIAN, INCOME_SIGMA), 9000, 600000), 2);
  const spend_ratio = round(
    clamp(normal(rng, SPEND_RATIO_MEAN, SPEND_RATIO_SD), SPEND_RATIO_MIN, SPEND_RATIO_MAX), 4,
  );
  const buffer = round(income * clamp(lognormal(rng, BUFFER_RATIO_MEDIAN, BUFFER_RATIO_SIGMA), 0.002, 0.8), 2);

  const shocks: Shock[] = [];
  for (let m = 0; m < MONTHS_SPANNED; m++) {
    if (!bernoulli(rng, SHOCK_PROB_PER_MONTH)) continue;
    const day = int(rng, 0, 29);
    const hour = int(rng, 0, 23);
    shocks.push({
      ms: START_MS + (m - 1) * 30 * DAY_MS + day * DAY_MS + hour * HOUR_MS,
      amount: round(income * uniform(rng, SHOCK_FRACTION_MIN, SHOCK_FRACTION_MAX), 2),
    });
  }

  return {
    customer_id: `cust_${String(i).padStart(5, "0")}`,
    bank: weighted(rng, bankShares),
    salary_day: Number(weighted(rng, SALARY_DAY_WEIGHTS)),
    salary_delays,
    income,
    spend_ratio,
    buffer,
    shocks,
    churn_hazard_scale: round(clamp(lognormal(rng, 1, CHURN_HAZARD_SIGMA), 0.05, 12), 4),
  };
}

function drawMandate(rng: Rng, c: Customer, i: number, endMs: number): Mandate {
  const created_at = bernoulli(rng, PREEXISTING_RATE)
    ? START_MS - int(rng, 1, PREEXISTING_AGE_DAYS_MAX) * DAY_MS
    : START_MS + int(rng, 1, 70) * DAY_MS;
  const amount = Number(weighted(rng, AMOUNT_WEIGHTS));
  const churn = drawChurn(c.churn_hazard_scale, Math.max(created_at, START_MS), endMs, rng);
  return {
    mandate_id: `mdt_${String(i).padStart(5, "0")}`,
    customer_id: c.customer_id,
    created_at,
    frequency: "monthly",
    amount,
    max_amount: amount * MAX_AMOUNT_MULTIPLE,
    debit_day_of_month: int(rng, 1, 31),
    churned_at: churn ? churn.at : null,
    churn_emits_event: churn ? churn.emits_event : false,
  };
}

// The merchant's scheduler. Mostly sane, occasionally naive -- WINDOW_HIT_RATE is
// what actually sets C1's base rate. Drawn per attempt, not per mandate: a fixed
// per-mandate hour would make C1 repeat forever for the same mandate and become
// indistinguishable from C4 under the invariance test.
function drawAttemptHour(rng: Rng): number {
  if (bernoulli(rng, WINDOW_HIT_RATE)) {
    return RESTRICTED_HOURS[int(rng, 0, RESTRICTED_HOURS.length - 1)]!;
  }
  return Number(weighted(rng, SAFE_HOUR_WEIGHTS));
}

function errorCodeFor(cause: Cause, m: Mandate, rng: Rng): string {
  const key =
    cause === "C4_CANCELLATION"
      ? m.churn_emits_event ? "C4_EXPLICIT" : "C4_SILENT"
      : cause;
  return weighted(rng, ERROR_CODE_WEIGHTS[key]!);
}

// Phase 2 needs the drawn population to replay counterfactual retries against the
// same four processes. Exposed as a separate entry point so the RNG stream -- and
// therefore every byte of Phase 1 output -- is untouched.
export type World = {
  records: WorldRecord[];
  customers: Map<string, Customer>;
  mandates: Map<string, Mandate>;
};

export function generateWorld(opts: GenerateOptions = {}): WorldRecord[] {
  return generateWorldFull(opts).records;
}

export function generateWorldFull(opts: GenerateOptions = {}): World {
  const seed = opts.seed ?? SEED;
  const nMandates = opts.mandates ?? N_MANDATES;
  const horizonDays = opts.horizonDays ?? HORIZON_DAYS;
  const endMs = START_MS + horizonDays * DAY_MS;
  const rng = makeRng(seed);
  // Decline codes are a reporting artifact, not a world process. Giving them
  // their own stream means retuning the code table cannot perturb who churned.
  const codeRng = makeRng(seed ^ 0x9e3779b9);

  const records: WorldRecord[] = [];
  const customers = new Map<string, Customer>();
  const mandates = new Map<string, Mandate>();
  const start = istParts(START_MS);

  for (let i = 0; i < nMandates; i++) {
    const customer = drawCustomer(rng, i);
    const mandate = drawMandate(rng, customer, i, endMs);
    customers.set(customer.customer_id, customer);
    mandates.set(mandate.mandate_id, mandate);

    let attemptIndex = 0;
    for (let mo = 0; mo <= Math.ceil(horizonDays / 28); mo++) {
      const d = new Date(Date.UTC(start.year, start.month + mo, 1));
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth();
      const day = Math.min(mandate.debit_day_of_month, daysInMonth(year, month));
      const hour = drawAttemptHour(rng);
      const minute = int(rng, 0, 59);
      const ts = istMs(year, month, day, hour, minute);
      if (ts < START_MS || ts >= endMs || ts <= mandate.created_at) continue;

      const leadHours = bernoulli(rng, LATE_DISPATCH_RATE)
        ? uniform(rng, LATE_LEAD_HOURS_MIN, LATE_LEAD_HOURS_MAX)
        : uniform(rng, NOTIFY_LEAD_HOURS_MIN, NOTIFY_LEAD_HOURS_MAX);
      const dispatchMs = ts - leadHours * HOUR_MS;
      const delivered = wasDeliveredByBank(customer.bank, dispatchMs, rng);

      const restricted = hour >= 10 && hour < 13;
      const { balance, days_since_salary } = balanceAt(customer, ts);

      // Every process is asked; we do not short-circuit, because multi_cause
      // needs to know who else would have blocked. Push order IS precedence:
      // churn (mandate already dead) -> notification (fails before presentment)
      // -> window (rejected at presentment) -> balance (declined at the bank).
      const blockers: Cause[] = [];
      if (mandate.churned_at !== null && ts >= mandate.churned_at) blockers.push("C4_CANCELLATION");
      if (leadHours < NOTIFY_MIN_LEAD_HOURS || !delivered) blockers.push("C2_NOTIFICATION_FAIL");
      if (restricted) blockers.push("C1_EXECUTION_WINDOW");
      if (mandate.amount > balance) blockers.push("C3_BALANCE_SHORTFALL");

      const cause = blockers[0] ?? null;
      const error_code = cause ? errorCodeFor(cause, mandate, codeRng) : null;

      records.push({
        attempt_id: `att_${String(records.length).padStart(6, "0")}`,
        mandate_id: mandate.mandate_id,
        customer_id: customer.customer_id,
        timestamp: toIso(ts),
        timestamp_ms: ts,
        bank: customer.bank,
        amount: mandate.amount,
        max_amount: mandate.max_amount,
        frequency: "monthly",
        mandate_created_at: toIso(mandate.created_at),
        mandate_age_days: Math.floor((ts - mandate.created_at) / DAY_MS),
        attempt_index: attemptIndex,
        notification_dispatched_at: toIso(dispatchMs),
        notification_hours_before_debit: round(leadHours, 2),
        success: cause === null,
        error_code,
        cause,
        blockers,
        multi_cause: blockers.length > 1,
        world: {
          restricted_window: restricted,
          balance_at_attempt: round(balance, 2),
          salary_day: customer.salary_day,
          days_since_salary: round(days_since_salary, 2),
          notification_delivered_by_bank: delivered,
          bank_outage_active: isBankOutage(customer.bank, dispatchMs),
          churned_at: mandate.churned_at === null ? null : toIso(mandate.churned_at),
          churn_emits_event: mandate.churn_emits_event,
          income: customer.income,
          spend_ratio: customer.spend_ratio,
        },
      });
      attemptIndex++;
    }
  }

  return { records, customers, mandates };
}

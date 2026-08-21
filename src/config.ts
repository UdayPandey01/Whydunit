import { istMs } from "./time.ts";

// ---------- run size ----------
export const SEED = 20260903;
export const OBSERVATION_SEED = SEED + 1; // separate stream: changing the observation
                                          // layer must never move the world
export const N_MANDATES = 2000;
export const HORIZON_DAYS = 90;
export const START_MS = istMs(2026, 0, 1, 0, 0); // 1 Jan 2026 IST -> exactly 90 days to 31 Mar

// ---------- C1: NPCI execution window ----------
export const RESTRICTED_START_HOUR = 10;
export const RESTRICTED_END_HOUR = 13; // [10:00, 13:00) IST

// How often the merchant's scheduler naively lands inside the restricted window.
// C1's raw block rate IS this number, so it is the knob that sets C1's base rate.
export const WINDOW_HIT_RATE = 0.042;
export const RESTRICTED_HOURS = [10, 11, 12];
export const SAFE_HOUR_WEIGHTS: Record<string, number> = {
  "1": 3, "2": 8, "3": 9, "4": 5, "5": 4, "6": 6, "7": 7, "8": 6, "9": 5,
  "13": 4, "14": 5, "15": 5, "16": 4, "17": 4, "18": 5, "19": 5, "20": 4,
  "21": 3, "22": 2, "23": 1, "0": 2,
};

// ---------- banks ----------
export const BANKS: Record<string, { share: number; notify_reliability: number }> = {
  HDFC: { share: 0.28, notify_reliability: 0.995 },
  ICICI: { share: 0.22, notify_reliability: 0.992 },
  SBI: { share: 0.24, notify_reliability: 0.978 },
  AXIS: { share: 0.14, notify_reliability: 0.988 },
  KOTAK: { share: 0.12, notify_reliability: 0.996 },
};

// ---------- C2: pre-debit notification ----------
export const NOTIFY_LEAD_HOURS_MIN = 26;
export const NOTIFY_LEAD_HOURS_MAX = 72;
export const LATE_DISPATCH_RATE = 0.012; // merchant-side C2: dispatched < 24h before debit
export const LATE_LEAD_HOURS_MIN = 2;
export const LATE_LEAD_HOURS_MAX = 23;
export const NOTIFY_MIN_LEAD_HOURS = 24; // NPCI rule the debit is checked against

// Bank notification outages, expressed against the horizon. Because dispatch
// happens 26-72h ahead of the debit, an outage on day D surfaces as failures on
// days D+1..D+3 -- the burst signature C2 is identified by.
export const NOTIFICATION_OUTAGES: {
  bank: string; start_day: number; start_hour: number; end_day: number; end_hour: number;
}[] = [
  { bank: "HDFC", start_day: 12, start_hour: 9, end_day: 12, end_hour: 11 },
  { bank: "SBI", start_day: 33, start_hour: 18, end_day: 34, end_hour: 7 },
  { bank: "ICICI", start_day: 47, start_hour: 2, end_day: 47, end_hour: 20 },
  { bank: "SBI", start_day: 61, start_hour: 0, end_day: 61, end_hour: 14 },
  { bank: "AXIS", start_day: 74, start_hour: 12, end_day: 75, end_hour: 4 },
];
export const OUTAGE_DELIVERY_RATE = 0.04;

// ---------- C3: balance ----------
export const SALARY_DAY_WEIGHTS: Record<string, number> = {
  "1": 40, "2": 8, "3": 5, "5": 8, "7": 18, "10": 10, "15": 7, "25": 4,
};
export const SALARY_DELAY_PROB = 0.14; // salary-day dispersion: credit slips some months
export const SALARY_DELAY_MAX_DAYS = 3;
export const INCOME_MEDIAN = 42000;
export const INCOME_SIGMA = 0.55;
export const SPEND_RATIO_MEAN = 0.925;
export const SPEND_RATIO_SD = 0.22;
export const SPEND_RATIO_MIN = 0.35;
export const SPEND_RATIO_MAX = 1.5;
export const SPEND_TAU_DAYS = 8; // spend decays through the month, front-loaded
export const BUFFER_RATIO_MEDIAN = 0.075;
export const BUFFER_RATIO_SIGMA = 0.95;
export const SHOCK_PROB_PER_MONTH = 0.1;
export const SHOCK_FRACTION_MIN = 0.15;
export const SHOCK_FRACTION_MAX = 0.6;

// ---------- C4: churn ----------
export const CHURN_DAILY_HAZARD = 0.00048;
export const CHURN_HAZARD_SIGMA = 0.7; // per-customer heterogeneity
export const CHURN_EVENT_EMIT_RATE = 0.6; // the silent 40% is the hard case

// ---------- mandates ----------
export const PREEXISTING_RATE = 0.92;
export const PREEXISTING_AGE_DAYS_MAX = 400;
export const AMOUNT_WEIGHTS: Record<string, number> = {
  "149": 14, "199": 16, "249": 9, "299": 14, "399": 10, "499": 12,
  "599": 6, "799": 5, "999": 7, "1499": 3, "2499": 2, "4999": 2,
};
export const MAX_AMOUNT_MULTIPLE = 2;

// ---------- observation layer ----------
export const RECEIPT_VISIBLE_RATE = 0.7; // partial observability of delivery receipts

// ---------- decline codes ----------
// The single place where cause information reaches an observable, so it MUST be
// lossy. Every code appears under several causes and the generic U30/U69 bucket
// spans all of them; if any code were 1:1 with a cause the classifier would be a
// lookup table and the project would be void.
//
// C4 splits: an explicitly revoked mandate declines like a dead mandate, while a
// silently churned customer produces generic or funds-shaped declines -- which is
// precisely why silent C4 can only be separated from C3 by invariance over time.
export const ERROR_CODE_WEIGHTS: Record<string, Record<string, number>> = {
  C1_EXECUTION_WINDOW: { U30: 0.43, U69: 0.33, ZM: 0.16, Z9: 0.06, ZA: 0.02 },
  C2_NOTIFICATION_FAIL: { U30: 0.36, ZM: 0.28, U69: 0.25, Z9: 0.06, ZA: 0.05 },
  C3_BALANCE_SHORTFALL: { Z9: 0.58, U30: 0.24, U69: 0.13, ZM: 0.03, ZA: 0.02 },
  C4_EXPLICIT: { ZA: 0.41, ZM: 0.27, U30: 0.22, U69: 0.1 },
  C4_SILENT: { U30: 0.32, Z9: 0.3, U69: 0.23, ZM: 0.12, ZA: 0.03 },
};

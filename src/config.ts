import { istMs } from "./time.ts";

// ---------- run size ----------
export const SEED = 20260903;
export const OBSERVATION_SEED = SEED + 1; 

export const N_MANDATES = 2000;
// Overridable so the horizon sweep can run without editing this file.
export const HORIZON_DAYS = Number(process.env.WHYDUNIT_HORIZON ?? 270);
export const START_MS = istMs(2026, 0, 1, 0, 0); 

// ---------- cost-sensitive stopping ----------
// Stopping a mandate is not the same kind of mistake as retrying one. A wrongful
// stop abandons a recoverable mandate and forfeits its whole value; a wrongful
// retry burns one retry. Expressing both in the same unit (a mandate value) gives
// a ratio, and the ratio gives the probability threshold above which stopping is
// the cheaper bet: stop iff P(C4) > ratio / (ratio + 1).
export const COST_WRONGFUL_STOP = 1.0; // one full mandate value
export const COST_WRONGFUL_RETRY = 0.05; // one retry, as a fraction of that value
export const DEFAULT_COST_RATIO = COST_WRONGFUL_STOP / COST_WRONGFUL_RETRY;

// The same trade priced in ABSOLUTE rupees rather than as a ratio, which is what
// makes it amount-aware. A wrongful stop forfeits the mandate, so its cost scales
// with the mandate; a retry is one bank API call and one customer-facing debit
// attempt, so its cost does NOT. Expressing both in rupees is the whole fix: a
// flat ratio charges the same threshold to a ₹149 mandate and a ₹4,999 one.
// Default is 0.05 x the mean mandate value in the seeded world, so the flat and
// amount-aware rules agree at an average-sized mandate and diverge either side.
export const COST_RETRY_RUPEES = Number(process.env.WHYDUNIT_RETRY_COST ?? 33);

// Rough marginal probability that any one retry lands, measured from the seeded
// run (recovered interventions / interventions spent). Used only to gate how MANY
// retries a mandate is worth, never to attribute a cause.
export const P_RETRY_SUCCEEDS = 0.33;

// ---------- C1: NPCI execution window ----------
export const RESTRICTED_START_HOUR = 10;
export const RESTRICTED_END_HOUR = 13; 

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
export const LATE_DISPATCH_RATE = 0.012; 
export const LATE_LEAD_HOURS_MIN = 2;
export const LATE_LEAD_HOURS_MAX = 23;
export const NOTIFY_MIN_LEAD_HOURS = 24; 

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
export const SALARY_DELAY_PROB = 0.14; 
export const SALARY_DELAY_MAX_DAYS = 3;
export const INCOME_MEDIAN = 42000;
export const INCOME_SIGMA = 0.55;
export const SPEND_RATIO_MEAN = 0.925;
export const SPEND_RATIO_SD = 0.22;
export const SPEND_RATIO_MIN = 0.35;
export const SPEND_RATIO_MAX = 1.5;
export const SPEND_TAU_DAYS = 8; 
export const BUFFER_RATIO_MEDIAN = 0.075;
export const BUFFER_RATIO_SIGMA = 0.95;
export const SHOCK_PROB_PER_MONTH = 0.1;
export const SHOCK_FRACTION_MIN = 0.15;
export const SHOCK_FRACTION_MAX = 0.6;

// ---------- C4: churn ----------
export const CHURN_DAILY_HAZARD = 0.00048;
export const CHURN_HAZARD_SIGMA = 0.7; 
export const CHURN_EVENT_EMIT_RATE = 0.6; 

// ---------- mandates ----------
export const PREEXISTING_RATE = 0.92;
export const PREEXISTING_AGE_DAYS_MAX = 400;
export const AMOUNT_WEIGHTS: Record<string, number> = {
  "149": 14, "199": 16, "249": 9, "299": 14, "399": 10, "499": 12,
  "599": 6, "799": 5, "999": 7, "1499": 3, "2499": 2, "4999": 2,
};
export const MAX_AMOUNT_MULTIPLE = 2;

// ---------- observation layer ----------
export const RECEIPT_VISIBLE_RATE = 0.7; 

export const ERROR_CODE_WEIGHTS: Record<string, Record<string, number>> = {
  C1_EXECUTION_WINDOW: { U30: 0.43, U69: 0.33, ZM: 0.16, Z9: 0.06, ZA: 0.02 },
  C2_NOTIFICATION_FAIL: { U30: 0.36, ZM: 0.28, U69: 0.25, Z9: 0.06, ZA: 0.05 },
  C3_BALANCE_SHORTFALL: { Z9: 0.58, U30: 0.24, U69: 0.13, ZM: 0.03, ZA: 0.02 },
  C4_EXPLICIT: { ZA: 0.41, ZM: 0.27, U30: 0.22, U69: 0.1 },
  C4_SILENT: { U30: 0.32, Z9: 0.3, U69: 0.23, ZM: 0.12, ZA: 0.03 },
};

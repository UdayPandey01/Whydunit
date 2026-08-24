export type Cause =
  | 'C1_EXECUTION_WINDOW'
  | 'C2_NOTIFICATION_FAIL'
  | 'C3_BALANCE_SHORTFALL'
  | 'C4_CANCELLATION';

export type Shock = { ms: number; amount: number };

export type Customer = {
  customer_id: string;
  bank: string;
  salary_day: number;
  salary_delays: number[];
  income: number;
  spend_ratio: number;
  buffer: number;
  shocks: Shock[];
  churn_hazard_scale: number;
};

export type Mandate = {
  mandate_id: string;
  customer_id: string;
  created_at: number;
  frequency: 'monthly';
  amount: number;
  max_amount: number;
  debit_day_of_month: number;
  churned_at: number | null;
  churn_emits_event: boolean;
};

export type WorldRecord = {
  attempt_id: string;
  mandate_id: string;
  customer_id: string;
  timestamp: string;
  timestamp_ms: number;
  bank: string;
  amount: number;
  max_amount: number;
  frequency: 'monthly';
  mandate_created_at: string;
  mandate_age_days: number;
  attempt_index: number;
  notification_dispatched_at: string;
  notification_hours_before_debit: number;
  success: boolean;
  error_code: string | null;
  cause: Cause | null;
  blockers: Cause[];
  multi_cause: boolean;
  world: {
    restricted_window: boolean;
    balance_at_attempt: number;
    salary_day: number;
    days_since_salary: number;
    notification_delivered_by_bank: boolean;
    bank_outage_active: boolean;
    churned_at: string | null;
    churn_emits_event: boolean;
    income: number;
    spend_ratio: number;
  };
};

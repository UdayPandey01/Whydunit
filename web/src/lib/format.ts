export const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
export const lakh = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(2)}Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)}L` : inr(n);
export const pct = (frac: number, dp = 1) => `${(100 * frac).toFixed(dp)}%`;
export const pp = (frac: number, dp = 1) =>
  `${frac >= 0 ? "+" : ""}${(100 * frac).toFixed(dp)}pp`;

export const CAUSE_NAME: Record<string, string> = {
  C1_EXECUTION_WINDOW: "Execution window",
  C2_NOTIFICATION_FAIL: "Notification failure",
  C3_BALANCE_SHORTFALL: "Balance shortfall",
  C4_CANCELLATION: "Cancellation",
};
export const CAUSE_SHORT: Record<string, string> = {
  C1_EXECUTION_WINDOW: "C1", C2_NOTIFICATION_FAIL: "C2",
  C3_BALANCE_SHORTFALL: "C3", C4_CANCELLATION: "C4",
};
export const POLICY_NAME: Record<string, string> = {
  do_nothing: "Do nothing",
  naive_retry: "Naive retry",
  window_aware_retry: "Window-aware retry",
  rule_policy: "Expert rule",
  model_policy: "WhyDunit",
  oracle_policy: "Oracle ceiling",
  model_ev: "WhyDunit · EV threshold",
  rule_ev: "Expert rule · EV",
  model_ev_budget: "WhyDunit · EV budget",
};

import { clusterBootstrapCI } from "./bootstrap.ts";
import { routeException } from "./exceptions.ts";
import type { ExceptionRecord, ExceptionReason, Support } from "./exceptions.ts";
import type { FeatureRow } from "./features.ts";
import type { Cause } from "./world/types.ts";

export const CAUSES: Cause[] = [
  "C1_EXECUTION_WINDOW",
  "C2_NOTIFICATION_FAIL",
  "C3_BALANCE_SHORTFALL",
  "C4_CANCELLATION",
];

export type Scored = {
  row: FeatureRow;
  label: Cause;
  predicted: Cause;
  proba: Record<Cause, number>;
  amount: number;
};

type Judged = { actual: Cause; predicted: Cause; mandate_id: string };

export function macroF1(rows: Judged[]): number {
  let total = 0;
  for (const c of CAUSES) {
    const tp = rows.filter((r) => r.predicted === c && r.actual === c).length;
    const fp = rows.filter((r) => r.predicted === c && r.actual !== c).length;
    const fn = rows.filter((r) => r.predicted !== c && r.actual === c).length;
    const p = tp + fp === 0 ? 0 : tp / (tp + fp);
    const rc = tp + fn === 0 ? 0 : tp / (tp + fn);
    total += p + rc === 0 ? 0 : (2 * p * rc) / (p + rc);
  }
  return total / CAUSES.length;
}

export type Report = {
  headline: string;
  n_failures: number;
  n_classified: number;
  n_routed: number;
  classified_pct: number;
  routed_pct: number;
  macro_f1_classified: number;
  macro_f1_classified_ci: [number, number];
  macro_f1_all: number;
  amount_at_risk: number;
  amount_classified: number;
  amount_routed: number;
  by_cause: Record<string, { n: number; amount: number; correct: number }>;
  by_reason: Record<string, number>;
  exceptions: ExceptionRecord[];
};

export function buildReport(scored: Scored[], support: Support): Report {
  const exceptions: ExceptionRecord[] = [];
  const classified: Scored[] = [];
  for (const s of scored) {
    const ex = routeException(s.row, s.proba, support, s.amount);
    if (ex === null) classified.push(s);
    else exceptions.push(ex);
  }

  const judged = (rows: Scored[]): Judged[] =>
    rows.map((s) => ({ actual: s.label, predicted: s.predicted, mandate_id: s.row.mandate_id }));

  const f1 = macroF1(judged(classified));
  const ci = clusterBootstrapCI(judged(classified), (j) => j.mandate_id, macroF1);

  const by_cause: Record<string, { n: number; amount: number; correct: number }> = {};
  for (const c of CAUSES) by_cause[c] = { n: 0, amount: 0, correct: 0 };
  for (const s of classified) {
    const b = by_cause[s.predicted]!;
    b.n += 1;
    b.amount += s.amount;
    if (s.predicted === s.label) b.correct += 1;
  }

  const by_reason: Record<string, number> = {};
  for (const e of exceptions) for (const r of e.reasons) by_reason[r] = (by_reason[r] ?? 0) + 1;

  const pct = (n: number) => Math.round((1000 * n) / scored.length) / 10;
  const sum = (rows: { amount: number }[]) => rows.reduce((a, r) => a + r.amount, 0);

  return {

    headline:
      `Classified ${pct(classified.length).toFixed(1)}% at macro-F1 ${f1.toFixed(3)} ` +
      `[${ci[0].toFixed(3)}–${ci[1].toFixed(3)}], ` +
      `routed ${pct(exceptions.length).toFixed(1)}% to review.`,
    n_failures: scored.length,
    n_classified: classified.length,
    n_routed: exceptions.length,
    classified_pct: pct(classified.length),
    routed_pct: pct(exceptions.length),
    macro_f1_classified: f1,
    macro_f1_classified_ci: ci,

    macro_f1_all: macroF1(judged(scored)),
    amount_at_risk: sum(scored),
    amount_classified: sum(classified),
    amount_routed: sum(exceptions),
    by_cause,
    by_reason,
    exceptions,
  };
}

const REASON_TEXT: Record<ExceptionReason, string> = {
  insufficient_history: "too little history to test failure invariance",
  ambiguous_top_two: "top two hypotheses too close to separate",
  multi_cause_conflict: "two or more mechanisms show evidence at once",
  outside_training_support: "bank or operating regime outside training support",
};

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function renderAttribution(r: Report): string[] {
  const lines = [
    "",
    `${r.n_failures} failed debits worth ${inr(r.amount_at_risk)}.`,
    `  auto-attributed ${r.n_classified} (${inr(r.amount_classified)})`,
    `  routed to review ${r.n_routed} (${inr(r.amount_routed)})`,
    "",
    "Attributed causes:",
  ];
  for (const c of CAUSES) {
    const b = r.by_cause[c]!;
    if (b.n === 0) continue;
    lines.push(`  ${c.padEnd(22)} ${String(b.n).padStart(4)}  ${inr(b.amount).padStart(12)}  ${((100 * b.correct) / b.n).toFixed(0)}% correct`);
  }
  lines.push("", "Exception queue by reason (an exception may carry several):");
  for (const [reason, n] of Object.entries(r.by_reason).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(n).padStart(4)}  ${REASON_TEXT[reason as ExceptionReason]}`);
  }
  lines.push("");
  return lines;
}

export function renderDigest(r: Report, agent: Record<string, number>): string[] {
  const lines = [r.headline, ...renderAttribution(r), "Recovery this cycle:"];
  for (const [k, v] of Object.entries(agent).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k.padEnd(22)} ${String(v).padStart(6)}`);
  }
  return lines;
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { indicators } from "./exceptions.ts";
import { runAgent } from "./agent/agent.ts";
import type { WorkItem } from "./agent/agent.ts";
import { COST_WRONGFUL_RETRY, DEFAULT_COST_RATIO, HORIZON_DAYS, SEED } from "./config.ts";
import { stopThreshold } from "./decision.ts";
import { explainAttributions, explainDigest, explainExceptions, claudeExplainer, hasCredentials } from "./explain.ts";
import type { Attribution } from "./explain.ts";
import { buildReport, renderAttribution, renderDigest } from "./report.ts";
import type { Report } from "./report.ts";
import type { Scored } from "./report.ts";
import type { Support } from "./exceptions.ts";
import { computeFeatures } from "./features.ts";
import type { FeatureRow } from "./features.ts";
import { observe } from "./observe.ts";
import type { ObservedAttempt } from "./observe.ts";
import { bootstrapCI, pairedDeltaCI, runPolicy, schedulesFor } from "./policy.ts";
import type { PolicyOutcome } from "./policy.ts";
import { assignSplits } from "./splits.ts";
import { generateWorld, generateWorldFull } from "./world/generate.ts";
import type { Cause, WorldRecord } from "./world/types.ts";
import {
  ACTION_LABEL, CAUSE_ACTION, CAUSE_ACTION_DETAIL, CAUSE_CODE, CAUSE_MEANING,
  CAUSE_NAME, CHECK_LABEL, CYCLE_LABEL, OUTCOME_LABEL, POLICY_LABEL, REASON_LABEL,
} from "./copy.ts";
import * as ui from "./ui.ts";
import { c } from "./ui.ts";

const P = "[generate]";

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function pct(n: number, d: number): string {
  return d === 0 ? "0.0%" : `${((100 * n) / d).toFixed(1)}%`;
}

function summarise(world: WorldRecord[], observations: ReturnType<typeof observe>): void {
  const fails = world.filter((w) => !w.success);
  const mandates = new Set(world.map((w) => w.mandate_id)).size;

  ui.section("SIMULATION · PAYMENT WORLD");
  ui.blank();
  ui.step("ok", `${mandates.toLocaleString("en-IN")} mandates created`);
  ui.step("ok", `${world.length.toLocaleString("en-IN")} payment attempts generated over ${HORIZON_DAYS} days`);
  ui.step("ok", `${fails.length.toLocaleString("en-IN")} failures emerged from the world processes`);

  ui.kvPanel("WORLD SUMMARY", [
    ["Mandates", c.white(mandates.toLocaleString("en-IN"))],
    ["Payment attempts", c.white(world.length.toLocaleString("en-IN"))],
    ["Failed attempts", c.red(fails.length.toLocaleString("en-IN")) + c.gray(`  (${pct(fails.length, world.length)})`)],
    ["Horizon", c.gray(`${HORIZON_DAYS} days`)],
    ["Seed", c.gray(String(SEED)) + c.gray("  (fully reproducible)")],
  ]);

  const byCause = new Map<string, number>();
  for (const f of fails) byCause.set(f.cause!, (byCause.get(f.cause!) ?? 0) + 1);
  ui.table(
    "WHY DID THEY FAIL?  (ground truth, imbalanced by design)",
    ["Cause", "Count", "Share of failures"],
    [...byCause].sort((a, b) => b[1] - a[1]).map(([cause, n]) => [
      c.white(`${CAUSE_CODE[cause as Cause]}  ${CAUSE_NAME[cause as Cause]}`),
      c.white(String(n)),
      pct(n, fails.length).padStart(6) + " " + ui.bar(n / fails.length, 12),
    ]),
    [26, 5, 25], ["l", "r", "l"],
  );

  const multi = fails.filter((f) => f.multi_cause);

  // Sanity check on the one place cause information reaches an observable: if any
  // decline code were ~100% pure the classifier would be a lookup table.
  const byCode = new Map<string, Map<string, number>>();
  for (const f of fails) {
    const m = byCode.get(f.error_code!) ?? new Map<string, number>();
    m.set(f.cause!, (m.get(f.cause!) ?? 0) + 1);
    byCode.set(f.error_code!, m);
  }
  ui.table(
    "DECLINE-CODE AMBIGUITY  (why bank codes alone are not enough)",
    ["Code", "Count", "Most likely cause", "Purity"],
    [...byCode].sort((a, b) => a[0].localeCompare(b[0])).map(([code, m]) => {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const [topCause, topN] = [...m].sort((a, b) => b[1] - a[1])[0]!;
      return [
        c.white(code), String(total),
        c.gray(CAUSE_NAME[topCause as Cause]),
        (topN / total > 0.9 ? c.yellow : c.green)(pct(topN, total)),
      ];
    }),
    [5, 5, 23, 21], ["l", "r", "l", "r"],
  );

  const withReceipt = observations.filter((o) => o.notification.receipt !== null).length;
  const withRevoke = observations.filter((o) => o.lifecycle_events.length > 0).length;
  const silentChurn = world.filter((w) => w.world.churned_at !== null && !w.world.churn_emits_event).length;
  ui.panel("WHAT THE MERCHANT CAN ACTUALLY SEE", [
    `${ui.ICON.ok} Delivery receipt available on ${c.white(pct(withReceipt, observations.length))} of attempts`,
    `${ui.ICON.ok} Cancellation webhook visible on ${c.white(String(withRevoke))} attempts`,
    `${ui.ICON.warn} ${c.yellow(String(silentChurn))} attempts sit under ${c.yellow("silent churn")} — no webhook at all`,
    `${ui.ICON.warn} ${c.yellow(String(multi.length))} failures had ${c.yellow("more than one cause")} (${pct(multi.length, fails.length)})`,
  ]);
  ui.note("Ground truth above is hidden from every downstream stage.");
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as T);
}

function buildFeatures(): void {
  const FP = "[features]";
  const observations = readJsonl<ObservedAttempt>("data/observations.jsonl");
  const world = readJsonl<WorldRecord>("data/world.jsonl");

  // computeFeatures never sees the world. The label is joined on afterwards, here,
  // so there is exactly one line in the codebase where truth meets the feature row.
  const labels = new Map(world.map((w) => [w.attempt_id, w.cause]));
  const explicitChurn = new Map(world.map((w) => [w.attempt_id, w.world.churn_emits_event]));
  const multi = new Map(world.map((w) => [w.attempt_id, w.multi_cause]));

  const rows = computeFeatures(observations).map((r) => {
    const label = labels.get(r.attempt_id);
    if (!label) throw new Error(`no ground-truth cause for ${r.attempt_id}`);
    return {
      attempt_id: r.attempt_id,
      mandate_id: r.mandate_id,
      bank: r.bank,
      day_index: r.day_index,
      timestamp: r.timestamp,
      label,
      // Carried for diagnostics only; eval must never train on these.
      diag_explicit_churn: explicitChurn.get(r.attempt_id) === true,
      diag_multi_cause: multi.get(r.attempt_id) === true,
      split: assignSplits(r),
      features: r.features,
    };
  });

  mkdirSync("data", { recursive: true });
  writeJsonl("data/features.jsonl", rows);
  const nFeatures = Object.keys(rows[0]?.features ?? {}).length;
  ui.section("FEATURE EXTRACTION");
  ui.blank();
  ui.step("ok", `${rows.length.toLocaleString("en-IN")} failed payments prepared`);
  ui.step("ok", `${nFeatures} signals extracted per payment, none of them look-ahead`);

  const rowsFor = [];
  for (const scheme of ["mandate", "bank", "time"] as const) {
    const counts = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const side = r.split[scheme];
      const m = counts.get(side) ?? new Map<string, number>();
      m.set(r.label, (m.get(r.label) ?? 0) + 1);
      counts.set(side, m);
    }
    const totalOf = (side: string) =>
      [...(counts.get(side) ?? new Map<string, number>()).values()].reduce((a, b) => a + b, 0);
    const DESC: Record<string, string> = {
      mandate: "unseen customers",
      bank: "unseen banks",
      time: "unseen time period",
    };
    rowsFor.push([
      c.white(scheme), c.gray(DESC[scheme]!),
      String(totalOf("train")), String(totalOf("test")),
    ]);
  }
  ui.table("VALIDATION SPLITS", ["Split", "Tests generalisation to", "Train", "Test"],
    rowsFor, [9, 26, 8, 7], ["l", "l", "r", "r"]);
  ui.note("wrote data/features.jsonl");
  void FP;
}

type Prediction = {
  attempt_id: string;
  predicted: Cause;
  rule_predicted: Cause;
  proba: Record<string, number>;
};

function runPolicies(): void {
  const PP = "[policy]";
  const { records, customers, mandates } = generateWorldFull();
  const failures = records.filter((r) => !r.success);
  const preds = readJsonl<Prediction>("data/predictions.jsonl");
  const probabilities = new Map(preds.map((p) => [p.attempt_id, p.proba as Record<Cause, number>]));
  const rulePredictions = new Map(preds.map((p) => [p.attempt_id, p.rule_predicted]));
  const ratio = Number(argValue("--cost-ratio") ?? DEFAULT_COST_RATIO);
  const threshold = stopThreshold(ratio);
  if (probabilities.size === 0) throw new Error("no predictions -- run eval/evaluate.py first");

  const totalAmount = failures.reduce((a, r) => a + r.amount, 0);
  const rupeeRate = (rows: PolicyOutcome[]) => {
    const denom = rows.reduce((a, r) => a + r.amount, 0);
    return denom === 0 ? 0 : rows.filter((r) => r.recovered).reduce((a, r) => a + r.amount, 0) / denom;
  };
  const retriesPer = (rows: PolicyOutcome[]) =>
    rows.length === 0 ? 0 : rows.reduce((a, r) => a + r.retries_spent, 0) / rows.length;

  ui.section("RECOVERY POLICY COMPARISON");
  ui.note(`${failures.length.toLocaleString("en-IN")} failed payments · ${ui.inr(totalAmount)} at risk · retry budget 3 per failure`);
  ui.note(`stop rule: P(C4) ≥ ${threshold.toFixed(3)} (cost ratio ${ratio}:1 — a wrongful stop costs a whole mandate, a wrongful retry costs one retry)`);

  // Show the curve, not just the chosen point: the sweep is the evidence that the
  // operating point was picked rather than tuned until it looked good.
  const sweep: { threshold: number; rate: number; amount: number; retries: number; stopped: number; net?: number }[] = [];
  for (let t = 0.5; t <= 0.9501; t += 0.05) {
    const th = Math.round(t * 100) / 100;
    const sched = schedulesFor(probabilities, rulePredictions, th).model_policy!;
    const out = runPolicy(failures, customers, mandates, sched);
    sweep.push({
      threshold: th,
      rate: rupeeRate(out),
      amount: out.filter((r) => r.recovered).reduce((a, r) => a + r.amount, 0),
      retries: out.reduce((a, r) => a + r.retries_spent, 0),
      stopped: out.filter((r) => r.retries_spent === 0).length,
    });
  }
  // Recovery alone rises monotonically with the threshold, so "pick the maximum"
  // is a corner, not a choice. Net value prices the retries it costs, using the
  // same cost matrix that produced the threshold: one retry is COST_WRONGFUL_RETRY
  // of a mandate.
  const retryCost = COST_WRONGFUL_RETRY * (totalAmount / failures.length);
  for (const r of sweep) r.net = r.amount - r.retries * retryCost;
  const best = [...sweep].sort((a, b) => (b.net ?? 0) - (a.net ?? 0))[0]!;
  ui.table("STOP-THRESHOLD SWEEP", ["P(C4) ≥", "₹ recovered", "Retries", "Net of retry cost", ""],
    sweep.map((r) => {
      const chosen = Math.abs(r.threshold - threshold) < 0.025;
      const tone = chosen ? c.cyanBold : r.threshold === best.threshold ? c.green : c.gray;
      return [
        tone(r.threshold.toFixed(2)),
        tone(ui.inrShort(r.amount)),
        tone(r.retries.toLocaleString("en-IN")),
        tone(ui.inrShort(r.net!)),
        chosen ? c.cyan("← in use") : r.threshold === best.threshold ? c.green("← best net") : "",
      ];
    }), [8, 12, 8, 18, 11], ["r", "r", "r", "r", "l"]);
  ui.note(`net = ₹ recovered − retries × ${ui.inr(retryCost)} (one retry at ${COST_WRONGFUL_RETRY} of a mandate)`);
  ui.note(`sweep maximises net at P(C4) ≥ ${best.threshold.toFixed(2)}; cost model selects ${threshold.toFixed(3)}`);

  const results: Record<string, { rate: number; ci: [number, number]; retries: number; retries_ci: [number, number]; recovered: number; spent: number }> = {};
  const outcomes: Record<string, PolicyOutcome[]> = {};
  const tableRows: string[][] = [];
  for (const [name, schedule] of Object.entries(schedulesFor(probabilities, rulePredictions, threshold))) {
    const out = runPolicy(failures, customers, mandates, schedule);
    outcomes[name] = out;
    const rate = rupeeRate(out);
    const ci = bootstrapCI(out, rupeeRate);
    const retries = retriesPer(out);
    const retriesCi = bootstrapCI(out, retriesPer);
    const spent = out.reduce((a, r) => a + r.retries_spent, 0);
    const recovered = out.filter((r) => r.recovered).length;
    results[name] = { rate, ci, retries, retries_ci: retriesCi, recovered, spent };
    const isUs = name === "model_policy";
    tableRows.push([
      (isUs ? c.cyanBold : c.white)(POLICY_LABEL[name] ?? name),
      (isUs ? c.greenBold : c.white)(`${(100 * rate).toFixed(1)}%`),
      ui.bar(rate, 10, isUs ? c.green : c.gray),
      c.gray(retries.toFixed(2)),
    ]);
  }
  ui.table("RECOVERY BY POLICY", ["Policy", "Recovered", "", "Retries"],
    tableRows, [27, 9, 10, 7], ["l", "r", "l", "r"]);
  ui.note("recovered = share of at-risk rupees; retries = per failed payment");

  // The whole point of asking for CIs: say plainly whether the model is
  // distinguishable from the thing it is supposed to beat.
  const deltas: Record<string, { delta: number; ci: [number, number] }> = {};
  const retryDeltas: Record<string, { delta: number; ci: [number, number] }> = {};
  const deltaRows: string[][] = [];
  for (const rival of ["naive_retry", "window_aware_retry", "rule_policy", "oracle_policy"]) {
    const d = pairedDeltaCI(outcomes.model_policy!, outcomes[rival]!, rupeeRate);
    // Retries are the other half of the question: matching on money while
    // spending less is a real win, and it needs an interval like anything else.
    const rd = pairedDeltaCI(outcomes.model_policy!, outcomes[rival]!, retriesPer);
    deltas[rival] = d;
    retryDeltas[rival] = rd;
    const straddles = d.ci[0] <= 0 && d.ci[1] >= 0;
    deltaRows.push([
      c.gray(POLICY_LABEL[rival] ?? rival),
      (d.delta >= 0 ? c.green : c.red)(`${d.delta >= 0 ? "+" : ""}${(100 * d.delta).toFixed(1)}pp`),
      c.gray(`[${(100 * d.ci[0]).toFixed(1)}, ${(100 * d.ci[1]).toFixed(1)}]`),
      straddles ? c.yellow("ties") : c.green("wins"),
    ]);
  }
  ui.table("WHYDUNIT vs EACH BASELINE  (₹ recovered, paired, 95% CI)",
    ["Compared with", "Delta", "95% CI", "Verdict"],
    deltaRows, [23, 8, 16, 15], ["l", "r", "l", "l"]);

  ui.table("WHYDUNIT vs EACH BASELINE  (retries per failure, lower is better)",
    ["Compared with", "Delta", "95% CI", "Verdict"],
    ["naive_retry", "window_aware_retry", "rule_policy", "oracle_policy"].map((rival) => {
      const rd = retryDeltas[rival]!;
      const straddles = rd.ci[0] <= 0 && rd.ci[1] >= 0;
      return [
        c.gray(POLICY_LABEL[rival] ?? rival),
        (rd.delta <= 0 ? c.green : c.red)(`${rd.delta >= 0 ? "+" : ""}${rd.delta.toFixed(2)}`),
        c.gray(`[${rd.ci[0].toFixed(2)}, ${rd.ci[1].toFixed(2)}]`),
        straddles ? c.yellow("ties") : rd.delta < 0 ? c.green("cheaper") : c.red("costlier"),
      ];
    }), [23, 8, 16, 15], ["l", "r", "l", "l"]);

  // Where does the recovery actually come from? Split by TRUE cause.
  const causeOf = new Map(failures.map((f) => [f.attempt_id, f.cause!]));
  // churned_at is a MANDATE property, so it is also set on attempts that failed
  // for another reason before the cancellation. Scope by the attempt's own cause.
  const silent = new Set(
    failures
      .filter((f) => f.cause === "C4_CANCELLATION" && !f.world.churn_emits_event)
      .map((f) => f.attempt_id),
  );
  const causeRows: string[][] = [];
  for (const cause of ["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL", "C4_CANCELLATION"]) {
    const pick = (rows: PolicyOutcome[]) => rows.filter((r) => causeOf.get(r.attempt_id) === cause);
    const m = pick(outcomes.model_policy!);
    const n = pick(outcomes.naive_retry!);
    causeRows.push([
      c.white(`${CAUSE_CODE[cause as Cause]}  ${CAUSE_NAME[cause as Cause]}`),
      c.gray(`${(100 * rupeeRate(n)).toFixed(1)}%`),
      c.green(`${(100 * rupeeRate(m)).toFixed(1)}%`),
      c.gray(String(m.reduce((a, r) => a + r.retries_spent, 0))),
    ]);
  }
  ui.table("RECOVERY BY TRUE CAUSE", ["Cause", "Naive", "WhyDunit", "Retries"],
    causeRows, [26, 8, 10, 9], ["l", "r", "r", "r"]);
  const wasted = outcomes.model_policy!.filter((r) => silent.has(r.attempt_id)).reduce((a, r) => a + r.retries_spent, 0);
  ui.note(`Naive retry recovers 0% of execution-window failures: T+24/72/168h all keep the same hour.`);
  ui.note(`${wasted} retries still burned on silent churn — unrecoverable and undetected.`);

  writeFileSync("data/policy.json", JSON.stringify({ n_failures: failures.length, total_amount: totalAmount, cost_ratio: ratio, stop_threshold: threshold, sweep, results, paired_deltas: deltas, paired_retry_deltas: retryDeltas }, null, 2) + "\n");
  console.log(`${PP} wrote data/policy.json`);
}

function runAgentCommand(): void {
  const AP = "[agent]";
  const dbPath = "data/agent.db";
  if (process.argv.includes("--fresh")) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  }

  const { records, customers, mandates } = generateWorldFull();
  const observations = new Map(
    readJsonl<ObservedAttempt>("data/observations.jsonl").map((o) => [o.attempt_id, o]),
  );
  const preds = new Map(
    readJsonl<Prediction>("data/predictions.jsonl").map((p) => [p.attempt_id, p]),
  );
  if (!existsSync("data/exceptions.jsonl")) {
    throw new Error("data/exceptions.jsonl missing -- run `npm run report` before the agent");
  }
  const routed = new Set(
    readJsonl<{ attempt_id: string }>("data/exceptions.jsonl").map((e) => e.attempt_id),
  );

  const byId = new Map(records.map((r) => [r.attempt_id, r]));
  const work: WorkItem[] = records
    .filter((r) => !r.success)
    .map((r) => {
      const o = observations.get(r.attempt_id)!;
      const p = preds.get(r.attempt_id);
      const revoke = o.lifecycle_events[0];
      return {
        source_attempt: r.attempt_id,
        mandate_id: r.mandate_id,
        bank: r.bank,
        failed_at: r.timestamp_ms,
        notification_dispatch_at: Date.parse(o.notification.dispatched_at),
        revoked_at: revoke === undefined ? null : Date.parse(revoke.timestamp),
        cause: p === undefined ? null : p.predicted,
        // Confidence is the model's own probability for the class it chose.
        confidence: p === undefined ? 0 : Math.max(...Object.values(p.proba)),
        proba: p === undefined ? null : (p.proba as Record<Cause, number>),
        routed_to_exception_queue: routed.has(r.attempt_id),
      };
    });

  mkdirSync("data", { recursive: true });
  const resuming = existsSync(dbPath);
  ui.section("AUTONOMOUS RECOVERY AGENT");
  ui.note(`${work.length.toLocaleString("en-IN")} failed payments · ${resuming ? "resuming existing run" : "fresh run"} · ${dbPath}`);
  const s = runAgent({ dbPath, work, customers, mandates, records: byId });

  ui.blank();
  if (s.resumed > 0) ui.step("warn", `resumed ${s.resumed} in-flight intervention(s) from a previous run`);
  ui.step("ok", "cause-matched action chosen for every payment");
  ui.step("ok", "four safety rules enforced before any action");
  ui.step("ok", `${s.audit_rows.toLocaleString("en-IN")} audit records written`);
  ui.step("ok", `${s.psp_effects.toLocaleString("en-IN")} interventions sent, each exactly once`);

  ui.table("ACTIONS TAKEN", ["Action", "Payments", "Share"],
    Object.entries(s.by_action).sort((a, b) => b[1] - a[1]).map(([k, v]) => [
      c.white(ACTION_LABEL[k] ?? k),
      c.white(v.toLocaleString("en-IN")),
      ui.bar(v / s.audit_rows, 12) + c.gray(` ${((100 * v) / s.audit_rows).toFixed(1)}%`),
    ]), [22, 9, 22], ["l", "r", "l"]);

  ui.table("WHERE EACH MANDATE ENDED UP", ["Outcome", "Mandates", ""],
    Object.entries(s.by_cycle_status).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const tone = k === "recovered" ? c.green : k === "escalated" ? c.yellow : c.gray;
      return [tone(CYCLE_LABEL[k] ?? k), tone(v.toLocaleString("en-IN")), ui.bar(v / s.audit_rows, 12, tone)];
    }), [24, 9, 20], ["l", "r", "l"]);

  ui.panel("REVENUE RECOVERED", [
    "",
    ui.centred(c.greenBold(ui.inrShort(s.recovered_amount))),
    ui.centred(c.gray(ui.inr(s.recovered_amount))),
    "",
  ]);
  void AP;
}

type FeatureFile = FeatureRow & { label: Cause };

async function runReport(): Promise<void> {
  const RP = "[report]";
  const rows = readJsonl<FeatureFile>("data/features.jsonl");
  const preds = new Map(readJsonl<Prediction>("data/predictions.jsonl").map((p) => [p.attempt_id, p]));
  const support = JSON.parse(readFileSync("data/support.json", "utf8")) as Support;
  const world = new Map(readJsonl<WorldRecord>("data/world.jsonl").map((w) => [w.attempt_id, w]));

  const scored: Scored[] = rows.map((r) => {
    const p = preds.get(r.attempt_id);
    if (p === undefined) throw new Error(`no prediction for ${r.attempt_id}`);
    return {
      row: r,
      label: r.label,
      predicted: p.predicted,
      proba: p.proba as Record<Cause, number>,
      amount: world.get(r.attempt_id)!.amount,
    };
  });

  const report = buildReport(scored, support);
  writeJsonl("data/exceptions.jsonl", report.exceptions);
  writeFileSync("data/report.json", JSON.stringify(report, null, 2) + "\n");

  ui.section("AI ATTRIBUTION");
  ui.blank();
  ui.line("  " + c.white(`${report.n_failures.toLocaleString("en-IN")} failed payments analyzed`));
  ui.blank();
  ui.line(`  ${ui.ICON.ok} ${c.greenBold(ui.pct1(report.n_classified / report.n_failures))} ${c.white("Automatically Classified")}`);
  ui.line(`  ${ui.ICON.warn} ${c.yellowBold(ui.pct1(report.n_routed / report.n_failures))} ${c.white("Sent to Human Review")}`);
  ui.blank();
  ui.note("Human review = low confidence, conflicting evidence, or too little history");

  renderCauseTable(report);
  renderQueueTable(report);

  ui.panel("ACCURACY ON WHAT WAS AUTO-CLASSIFIED", [
    `  macro-F1 ${c.greenBold(report.macro_f1_classified.toFixed(3))}  ` +
      c.gray(`95% CI ${report.macro_f1_classified_ci[0].toFixed(3)}-${report.macro_f1_classified_ci[1].toFixed(3)}`),
    c.gray(`  macro-F1 over ALL failures, routed or not: ${report.macro_f1_all.toFixed(3)}`),
  ]);
  ui.note("wrote data/report.json and data/exceptions.jsonl");
  ui.note("next: run the agent, then `npm run digest`");
  void RP;
  void renderAttribution;
}

/** Shared by report, digest and demo so one table style is used everywhere. */
function renderCauseTable(report: Report): void {
  const rows: string[][] = [];
  for (const cause of ["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL", "C4_CANCELLATION"] as Cause[]) {
    const b = report.by_cause[cause]!;
    if (b.n === 0) continue;
    rows.push([
      c.white(`${CAUSE_CODE[cause]}  ${CAUSE_NAME[cause]}`),
      c.white(b.n.toLocaleString("en-IN")),
      ui.pct1(b.n / report.n_failures).padStart(5) + " " + ui.bar(b.n / report.n_failures, 12),
    ]);
  }
  rows.push([
    c.yellow("?   Human Review"),
    c.yellow(report.n_routed.toLocaleString("en-IN")),
    ui.pct1(report.n_routed / report.n_failures).padStart(5) + " " + ui.bar(report.n_routed / report.n_failures, 12, c.yellow),
  ]);
  ui.table("WHY ARE PAYMENTS FAILING?", ["Cause", "Payments", "Share"], rows, [26, 9, 19], ["l", "r", "l"]);
  for (const cause of ["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL", "C4_CANCELLATION"] as Cause[]) {
    ui.note(`${CAUSE_CODE[cause]} — ${CAUSE_MEANING[cause]}`);
  }
}

function renderQueueTable(report: Report): void {
  const rows = Object.entries(report.by_reason).sort((a, b) => b[1] - a[1]).map(([k, v]) => [
    c.white(REASON_LABEL[k] ?? k), c.yellow(v.toLocaleString("en-IN")),
  ]);
  if (rows.length === 0) return;
  ui.table("WHAT NEEDED A HUMAN", ["Reason", "Payments"], rows, [40, 14], ["l", "r"]);
  ui.note("a payment can be flagged for more than one reason");
}

/**
 * The merchant-facing summary of a FINISHED cycle. Split out from `report`
 * because the digest reports the agent's outcomes and the agent cannot run until
 * `report` has produced the exception queue -- so one command could not honestly
 * do both. It refuses to run rather than quietly omitting recovery, which is how
 * the earlier version came to print a previous cycle's figures. See INCIDENTS #6.
 */
async function runDigest(): Promise<void> {
  const DP = "[digest]";
  if (!existsSync("data/report.json")) throw new Error("data/report.json missing -- run `npm run report` first");
  if (!existsSync("data/agent.db")) throw new Error("data/agent.db missing -- run `npm run agent` before the digest");

  const report = JSON.parse(readFileSync("data/report.json", "utf8")) as Report;
  const outcomes = readAgentOutcomes();
  const digest = renderDigest(report, outcomes.tally);
  writeFileSync("data/digest.txt", digest.join("\n") + "\n");

  ui.section("MERCHANT DIGEST");
  ui.blank();
  ui.line("  " + c.whiteBold(report.headline));
  renderHealthPanel(report);
  renderCauseTable(report);
  renderQueueTable(report);
  renderOutcomeTable(outcomes.tally);
  ui.note("wrote data/digest.txt");
  void DP;

  if (!process.argv.includes("--explain")) {
    console.log(`${DP} natural-language layer skipped (pass --explain to enable)`);
    return;
  }
  if (!hasCredentials()) {
    console.log(`${DP} --explain requested but no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN found; skipping`);
    return;
  }

  // Everything above is already final. Nothing below changes a number, and its
  // output goes to its own files that no other module reads.
  const world = new Map(readJsonl<WorldRecord>("data/world.jsonl").map((w) => [w.attempt_id, w]));
  const rows = new Map(readJsonl<FeatureFile>("data/features.jsonl").map((r) => [r.attempt_id, r]));
  const routed = new Set(report.exceptions.map((e) => e.attempt_id));
  const explain = claudeExplainer();

  const attributions: Attribution[] = [...rows.values()]
    .filter((r) => !routed.has(r.attempt_id))
    .slice(0, Number(process.env.EXPLAIN_LIMIT ?? 20))
    .map((r) => {
      const w = world.get(r.attempt_id)!;
      const predicted = outcomes.cause.get(r.attempt_id) ?? r.label;
      const ev = indicators(r.features)[predicted];
      return {
        attempt_id: r.attempt_id,
        mandate_id: r.mandate_id,
        bank: r.bank,
        timestamp: r.timestamp,
        amount: w.amount,
        cause: predicted,
        confidence: 0,
        evidence: ev.length > 0 ? ev : [`decline code ${w.error_code ?? "none"}; no single observable is decisive`],
        action_taken: outcomes.action.get(r.mandate_id) ?? "no intervention recorded",
        outcome: outcomes.result.get(r.mandate_id) ?? "no outcome recorded",
      };
    });

  const attrText = await explainAttributions(attributions, explain);
  const excText = await explainExceptions(report.exceptions.slice(0, 20), explain);
  writeJsonl("data/explanations.jsonl", [...attrText, ...excText]);
  writeFileSync("data/digest.md", (await explainDigest(report, digest, explain)) + "\n");
  console.log(`${DP} wrote data/explanations.jsonl (${attrText.length + excText.length}) and data/digest.md`);
}

function readAgentOutcomes() {
  const db = new Database("data/agent.db", { readonly: true });
  const tally: Record<string, number> = {};
  for (const r of db.prepare("SELECT outcome k, COUNT(*) n FROM audit_log GROUP BY outcome").all() as { k: string; n: number }[]) {
    tally[r.k] = r.n;
  }
  const action = new Map<string, string>();
  const result = new Map<string, string>();
  const cause = new Map<string, Cause>();
  for (const r of db.prepare("SELECT mandate_id, source_attempt, cause, action, outcome FROM audit_log ORDER BY attempt_no").all() as
    { mandate_id: string; source_attempt: string; cause: Cause | null; action: string; outcome: string }[]) {
    action.set(r.mandate_id, r.action);
    result.set(r.mandate_id, r.outcome);
    if (r.cause !== null) cause.set(r.source_attempt, r.cause);
  }
  db.close();
  return { tally, action, result, cause };
}


/** Reads finished artifacts and renders them. Computes no result of its own. */
function renderHealthPanel(report: Report): void {
  ui.kvPanel("PAYMENT HEALTH", [
    ["Failed payments", c.white(report.n_failures.toLocaleString("en-IN"))],
    ["Money at risk", c.redBold(ui.inrShort(report.amount_at_risk)) + c.gray(`  ${ui.inr(report.amount_at_risk)}`)],
    ["Auto classified", c.green(ui.pct1(report.n_classified / report.n_failures)) + c.gray(`  ${report.n_classified.toLocaleString("en-IN")}`)],
    ["Human review", c.yellow(ui.pct1(report.n_routed / report.n_failures)) + c.gray(`  ${report.n_routed.toLocaleString("en-IN")}`)],
  ]);
}

function renderDecisionTable(): void {
  const rows = (["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL", "C4_CANCELLATION"] as Cause[])
    .map((cause) => [
      c.white(CAUSE_NAME[cause]),
      (cause === "C4_CANCELLATION" ? c.red : c.green)(CAUSE_ACTION[cause]),
      c.gray(CAUSE_ACTION_DETAIL[cause]),
    ]);
  rows.push([c.yellow("Uncertain"), c.yellow("HUMAN REVIEW"), c.gray("queued with evidence")]);
  ui.table(null, ["Failure cause", "Action", "What WhyDunit does"], rows, [20, 15, 21], ["l", "l", "l"]);
  ui.note("WhyDunit does not blindly retry every failed payment.");
}

function renderOutcomeTable(tally: Record<string, number>): void {
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  if (total === 0) return;
  ui.table("WHAT HAPPENED NEXT", ["Outcome", "Interventions", ""],
    Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const tone = k === "recovered" ? c.green : k === "failed" ? c.red : c.gray;
      return [tone(OUTCOME_LABEL[k] ?? k), tone(v.toLocaleString("en-IN")), ui.bar(v / total, 12, tone)];
    }), [24, 13, 16], ["l", "r", "l"]);
}

type PolicyFile = {
  results: Record<string, { rate: number; retries: number }>;
  paired_deltas: Record<string, { delta: number; ci: [number, number] }>;
};

function renderRevenueHero(report: Report, policy: PolicyFile, recoveredAmount: number): void {
  const naive = policy.results.naive_retry!;
  const model = policy.results.model_policy!;
  const delta = policy.paired_deltas.naive_retry!;
  ui.blank();
  ui.line(c.cyan("╭" + "─".repeat(ui.W) + "╮"));
  const row = (s: string) => ui.line(c.cyan("│") + s + c.cyan("│"));
  row(ui.centred(c.whiteBold("REVENUE RECOVERY")));
  ui.line(c.cyan("├" + "─".repeat(ui.W) + "┤"));
  row(" ".repeat(ui.W));
  row(ui.centred(c.gray("MONEY AT RISK")));
  row(ui.centred(c.redBold(ui.inrShort(report.amount_at_risk))));
  row(" ".repeat(ui.W));
  row(ui.centred(c.gray("MONEY RECOVERED")));
  row(ui.centred(c.greenBold(ui.inrShort(recoveredAmount))));
  row(" ".repeat(ui.W));
  ui.line(c.cyan("├" + "─".repeat(ui.W) + "┤"));
  row(" ".repeat(ui.W));
  row("   " + ui.pad2(c.gray("NAIVE RETRY"), 30) + ui.pad2(c.cyan("WHYDUNIT"), 31));
  row("   " + ui.pad2(c.white(`${(100 * naive.rate).toFixed(1)}% recovered`), 30) +
      ui.pad2(c.greenBold(`${(100 * model.rate).toFixed(1)}% recovered`), 31));
  row(" ".repeat(ui.W));
  row(ui.centred(c.greenBold(`+${(100 * delta.delta).toFixed(1)}pp`)));
  row(ui.centred(c.gray("recovery improvement")));
  row(ui.centred(c.gray(`95% CI ${(100 * delta.ci[0]).toFixed(1)} to ${(100 * delta.ci[1]).toFixed(1)}pp`)));
  row(" ".repeat(ui.W));
  ui.line(c.cyan("├" + "─".repeat(ui.W) + "┤"));
  row(" ".repeat(ui.W));
  row("   " + ui.pad2(c.gray("Retries per failure"), 30) +
      ui.pad2(c.white(`${naive.retries.toFixed(2)}`) + c.gray("  →  ") + c.greenBold(`${model.retries.toFixed(2)}`), 31));
  row(" ".repeat(ui.W));
  ui.line(c.cyan("╰" + "─".repeat(ui.W) + "╯"));
}

function recoveredAmountFrom(db: Database.Database): number {
  // Same join the agent already prints: audit rows marked recovered, priced at the
  // mandate's amount. Re-read here for display; nothing new is computed.
  const amounts = new Map<string, number>();
  for (const w of readJsonl<WorldRecord>("data/world.jsonl")) amounts.set(w.mandate_id, w.amount);
  const rows = db.prepare("SELECT mandate_id FROM audit_log WHERE outcome='recovered'").all() as { mandate_id: string }[];
  return rows.reduce((a, r) => a + (amounts.get(r.mandate_id) ?? 0), 0);
}

function runDemo(): void {
  for (const f of ["data/report.json", "data/policy.json", "data/agent.db"]) {
    if (!existsSync(f)) throw new Error(`${f} missing -- run \`npm run all\` first`);
  }
  const report = JSON.parse(readFileSync("data/report.json", "utf8")) as Report;
  const policy = JSON.parse(readFileSync("data/policy.json", "utf8")) as PolicyFile;
  const db = new Database("data/agent.db", { readonly: true });
  const tally: Record<string, number> = {};
  for (const r of db.prepare("SELECT outcome k, COUNT(*) n FROM audit_log GROUP BY outcome").all() as { k: string; n: number }[]) {
    tally[r.k] = r.n;
  }
  const recovered = recoveredAmountFrom(db);
  db.close();

  ui.hero("WHYDUNIT", "RAZORPAY LAB", "AI Payment Recovery Intelligence",
    "Diagnose failed payments → Recover more revenue");

  renderHealthPanel(report);
  renderCauseTable(report);

  ui.section("AI ATTRIBUTION");
  ui.blank();
  ui.line("  " + c.white(`${report.n_failures.toLocaleString("en-IN")} failed payments analyzed`));
  ui.blank();
  ui.line(`  ${ui.ICON.ok} ${c.greenBold(ui.pct1(report.n_classified / report.n_failures))} ${c.white("Automatically Classified")}`);
  ui.line(`  ${ui.ICON.warn} ${c.yellowBold(ui.pct1(report.n_routed / report.n_failures))} ${c.white("Sent to Human Review")}`);
  ui.blank();
  ui.note("Human review = low confidence or conflicting evidence");
  renderQueueTable(report);

  ui.section("RECOVERY DECISION");
  renderDecisionTable();

  renderRevenueHero(report, policy, recovered);
  renderOutcomeTable(tally);

  ui.section("DEMO COMPLETE");
  ui.kvPanel("BUSINESS RESULT", [
    ["Failed payments", c.white(report.n_failures.toLocaleString("en-IN"))],
    ["Automatically classified", c.green(ui.pct1(report.n_classified / report.n_failures))],
    ["Human review", c.yellow(ui.pct1(report.n_routed / report.n_failures))],
    ["Money at risk", c.white(ui.inrShort(report.amount_at_risk))],
    ["Money recovered", c.greenBold(ui.inrShort(recovered))],
    ["Naive retry recovery", c.gray(`${(100 * policy.results.naive_retry!.rate).toFixed(1)}%`)],
    ["WhyDunit recovery", c.greenBold(`${(100 * policy.results.model_policy!.rate).toFixed(1)}%`)],
    ["Retries / failure", c.white(`${policy.results.naive_retry!.retries.toFixed(2)}`) + c.gray("  →  ") + c.greenBold(`${policy.results.model_policy!.retries.toFixed(2)}`)],
  ], 26);
  ui.blank();
  ui.step("ok", "Diagnosis complete");
  ui.step("ok", "Recovery decision complete");
  ui.step("ok", "Safety checks enforced");
  ui.step("ok", "Audit trail generated");
  ui.blank();
}

function runInspect(): void {
  const id = process.argv[3];
  if (id === undefined) throw new Error("usage: node src/cli.ts inspect <attempt_id>");
  for (const f of ["data/observations.jsonl", "data/predictions.jsonl", "data/features.jsonl"]) {
    if (!existsSync(f)) throw new Error(`${f} missing -- run \`npm run all\` first`);
  }

  const obs = readJsonl<ObservedAttempt>("data/observations.jsonl").find((o) => o.attempt_id === id);
  if (obs === undefined) throw new Error(`no payment ${id} in data/observations.jsonl`);
  const pred = readJsonl<Prediction>("data/predictions.jsonl").find((p) => p.attempt_id === id);
  const feat = readJsonl<FeatureRow>("data/features.jsonl").find((f) => f.attempt_id === id);
  const exc = existsSync("data/exceptions.jsonl")
    ? readJsonl<{ attempt_id: string; reasons: string[]; hypotheses: { cause: Cause; probability: number; evidence: string[] }[]; resolving_evidence: string[] }>("data/exceptions.jsonl")
        .find((e) => e.attempt_id === id)
    : undefined;

  ui.section("PAYMENT INVESTIGATION");
  ui.kvPanel("PAYMENT", [
    ["Payment", c.white(obs.attempt_id)],
    ["Mandate", c.gray(obs.mandate_id)],
    ["Amount", c.white(ui.inr(obs.amount))],
    ["Bank", c.white(obs.bank)],
    ["Attempted", c.gray(obs.timestamp)],
    ["Status", obs.success ? c.green("SUCCEEDED") : c.redBold("FAILED") + c.gray(`  code ${obs.error_code ?? "none"}`)],
  ]);

  if (obs.success) {
    ui.note("This payment succeeded; there is nothing to attribute.");
    return;
  }

  ui.section("WHY DID IT FAIL?");
  if (exc !== undefined) {
    ui.blank();
    ui.line("  " + c.yellowBold("SENT TO HUMAN REVIEW"));
    ui.blank();
    for (const r of exc.reasons) ui.line(`  ${ui.ICON.warn} ${c.yellow(REASON_LABEL[r] ?? r)}`);
    ui.blank();
    ui.line("  " + c.white("Competing hypotheses"));
    for (const h of exc.hypotheses) {
      ui.line(`    ${c.white(CAUSE_CODE[h.cause] + " " + CAUSE_NAME[h.cause])} ${c.gray(`p=${h.probability.toFixed(2)}`)}`);
      for (const e of h.evidence) ui.line(`      ${c.gray("·")} ${c.gray(e)}`);
    }
    ui.blank();
    ui.line("  " + c.white("What would resolve it"));
    for (const r of exc.resolving_evidence) ui.line(`    ${ui.ICON.arrow} ${c.gray(r)}`);
  } else if (pred !== undefined && feat !== undefined) {
    const conf = Math.max(...Object.values(pred.proba));
    ui.blank();
    ui.line("  " + c.cyanBold(`${CAUSE_CODE[pred.predicted]} — ${CAUSE_NAME[pred.predicted].toUpperCase()}`));
    ui.line("  " + c.gray(CAUSE_MEANING[pred.predicted]));
    ui.blank();
    ui.line(`  Confidence  ${c.greenBold(`${(100 * conf).toFixed(0)}%`)}  ${ui.bar(conf, 20, c.green)}`);
    ui.blank();
    ui.line("  " + c.white("Evidence"));
    const ev = indicators(feat.features)[pred.predicted];
    if (ev.length > 0) for (const e of ev) ui.line(`    ${ui.ICON.ok} ${c.gray(e)}`);
    else ui.line(`    ${ui.ICON.ok} ${c.gray(`decline code ${obs.error_code ?? "none"}; no single observable is decisive`)}`);
    ui.blank();
    ui.line("  " + c.white("RECOMMENDED ACTION"));
    ui.line(`    ${ui.ICON.arrow} ${c.greenBold(CAUSE_ACTION[pred.predicted])}  ${c.gray(CAUSE_ACTION_DETAIL[pred.predicted])}`);
  }

  if (!existsSync("data/agent.db")) {
    ui.blank();
    ui.note("no agent run found; run `npm run agent` to see safety checks and outcome");
    return;
  }
  const db = new Database("data/agent.db", { readonly: true });
  const audit = db.prepare("SELECT * FROM audit_log WHERE source_attempt = ? ORDER BY attempt_no").all(id) as
    { attempt_no: number; action: string; scheduled_at: string | null; checks_passed: string; checks_failed: string; checks_skipped: string; outcome: string }[];
  db.close();

  if (audit.length === 0) {
    ui.blank();
    ui.note("no intervention recorded for this payment");
    return;
  }

  ui.section("SAFETY CHECKS");
  ui.blank();
  const last = audit[audit.length - 1]!;
  for (const chk of JSON.parse(last.checks_passed) as string[]) ui.line(`  ${ui.ICON.ok} ${c.gray(CHECK_LABEL[chk] ?? chk)}`);
  for (const chk of JSON.parse(last.checks_failed) as string[]) ui.line(`  ${ui.ICON.err} ${c.red(CHECK_LABEL[chk] ?? chk)}`);
  for (const chk of JSON.parse(last.checks_skipped) as string[]) ui.line(`  ${c.gray("–")} ${c.gray((CHECK_LABEL[chk] ?? chk) + "  (not applicable)")}`);

  ui.section("DECISION");
  ui.blank();
  const failed = (JSON.parse(last.checks_failed) as string[]).length > 0;
  ui.line(failed
    ? `  ${ui.ICON.err} ${c.redBold("BLOCKED BY SAFETY RULE")}`
    : `  ${ui.ICON.ok} ${c.greenBold("SAFE TO EXECUTE")}`);
  ui.blank();
  ui.table(null, ["#", "Action", "Scheduled", "Outcome"],
    audit.map((a) => [
      c.gray(String(a.attempt_no)),
      c.white(ACTION_LABEL[a.action] ?? a.action),
      c.gray(a.scheduled_at === null ? "—" : a.scheduled_at.slice(0, 16).replace("T", " ")),
      (a.outcome === "recovered" ? c.green : a.outcome === "failed" ? c.red : c.gray)(OUTCOME_LABEL[a.outcome] ?? a.outcome),
    ]), [2, 15, 17, 17], ["r", "l", "l", "l"]);
  ui.blank();
}

function main(): void {
  const command = process.argv[2];
  if (command === "report") {
    void runReport();
    return;
  }
  if (command === "digest") {
    void runDigest();
    return;
  }
  if (command === "demo") return runDemo();
  if (command === "inspect") return runInspect();
  if (command === "features") return buildFeatures();
  if (command === "agent") return runAgentCommand();
  if (command === "policy") return runPolicies();
  if (command !== "generate") {
    console.error("usage: node src/cli.ts <demo|inspect <id>|generate|features|report|policy|agent|digest>");
    process.exit(1);
  }

  const world = generateWorld();
  if (world.length === 0) throw new Error("generator produced no attempts");
  const observations = observe(world);

  mkdirSync("data", { recursive: true });
  writeJsonl("data/world.jsonl", world);
  writeJsonl("data/observations.jsonl", observations);

  ui.note(`wrote data/world.jsonl (${world.length} records, ground truth included)`);
  ui.note(`wrote data/observations.jsonl (${observations.length} records, merchant-visible only)`);
  summarise(world, observations);
}

main();

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import * as ui from "./render.ts";
import { bad, dim, good, key, warn, white } from "./render.ts";

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

  ui.rule("SIMULATION · PAYMENT WORLD");
  ui.blank();
  ui.step("ok", `${mandates.toLocaleString("en-IN")} mandates created`);
  ui.step("ok", `${world.length.toLocaleString("en-IN")} payment attempts generated over ${HORIZON_DAYS} days`);
  ui.step("ok", `${fails.length.toLocaleString("en-IN")} failures emerged from the world processes`);

  ui.rule("WORLD SUMMARY");
  ui.kv([
    ["Mandates", white(mandates.toLocaleString("en-IN"))],
    ["Payment attempts", white(world.length.toLocaleString("en-IN"))],
    ["Failed attempts", bad(fails.length.toLocaleString("en-IN")) + dim(`  (${pct(fails.length, world.length)})`)],
    ["Horizon", dim(`${HORIZON_DAYS} days`)],
    ["Seed", dim(String(SEED)) + dim("  (fully reproducible)")],
  ]);

  const byCause = new Map<string, number>();
  for (const f of fails) byCause.set(f.cause!, (byCause.get(f.cause!) ?? 0) + 1);
  ui.rule("WHY DID THEY FAIL?  (ground truth, imbalanced by design)");
  ui.table(["Cause", "Count", "Share of failures"],
    [...byCause].sort((a, b) => b[1] - a[1]).map(([cause, n]) => [
      white(`${CAUSE_CODE[cause as Cause]}  ${CAUSE_NAME[cause as Cause]}`),
      white(String(n)),
      pct(n, fails.length).padStart(6) + " " + ui.bar(n / fails.length, 12),
    ]),
    ["l", "r", "l"],
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
  ui.rule("DECLINE-CODE AMBIGUITY  (why bank codes alone are not enough)");
  ui.table(["Code", "Count", "Most likely cause", "Purity"],
    [...byCode].sort((a, b) => a[0].localeCompare(b[0])).map(([code, m]) => {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const [topCause, topN] = [...m].sort((a, b) => b[1] - a[1])[0]!;
      return [
        white(code), String(total),
        dim(CAUSE_NAME[topCause as Cause]),
        (topN / total > 0.9 ? warn : good)(pct(topN, total)),
      ];
    }),
    ["l", "r", "l", "r"],
  );

  const withReceipt = observations.filter((o) => o.notification.receipt !== null).length;
  const withRevoke = observations.filter((o) => o.lifecycle_events.length > 0).length;
  const silentChurn = world.filter((w) => w.world.churned_at !== null && !w.world.churn_emits_event).length;
  ui.rule("WHAT THE MERCHANT CAN ACTUALLY SEE");
  for (const b of [
    `${ui.OK} Delivery receipt available on ${white(pct(withReceipt, observations.length))} of attempts`,
    `${ui.OK} Cancellation webhook visible on ${white(String(withRevoke))} attempts`,
    `${ui.WARN} ${warn(String(silentChurn))} attempts sit under ${warn("silent churn")} — no webhook at all`,
    `${ui.WARN} ${warn(String(multi.length))} failures had ${warn("more than one cause")} (${pct(multi.length, fails.length)})`,
  ]) ui.line("  " + b);
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
  ui.rule("FEATURE EXTRACTION");
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
      white(scheme), dim(DESC[scheme]!),
      String(totalOf("train")), String(totalOf("test")),
    ]);
  }
  ui.rule("VALIDATION SPLITS");
  ui.table(["Split", "Tests generalisation to", "Train", "Test"],
    rowsFor, ["l", "l", "r", "r"]);
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

  ui.rule("RECOVERY POLICY COMPARISON");
  ui.note(`${failures.length.toLocaleString("en-IN")} failed payments · ${ui.money(totalAmount)} at risk · retry budget 3 per failure`);
  ui.note(`stop rule: P(C4) ≥ ${threshold.toFixed(3)}  ·  cost ratio ${ratio}:1`);
  ui.note(dim("a wrongful stop forfeits a mandate; a wrongful retry costs one retry"));

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
  ui.rule("STOP-THRESHOLD SWEEP");
  ui.table(["P(C4) ≥", "₹ recovered", "Retries", "Net of retry cost", ""],
    sweep.map((r) => {
      const chosen = Math.abs(r.threshold - threshold) < 0.025;
      const tone = chosen ? key : r.threshold === best.threshold ? good : dim;
      return [
        tone(r.threshold.toFixed(2)),
        tone(ui.moneyShort(r.amount)),
        tone(r.retries.toLocaleString("en-IN")),
        tone(ui.moneyShort(r.net!)),
        chosen ? key("← in use") : r.threshold === best.threshold ? good("← best net") : "",
      ];
    }), ["r", "r", "r", "r", "l"]);
  ui.note(`net = ₹ recovered − retries × ${ui.money(retryCost)} per retry`);
  ui.note(`sweep peaks at ${best.threshold.toFixed(2)}; cost model selects ${threshold.toFixed(3)}`);

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
      (isUs ? key : white)(POLICY_LABEL[name] ?? name),
      (isUs ? good : white)(`${(100 * rate).toFixed(1)}%`),
      ui.bar(rate, 10, isUs ? good : dim),
      dim(retries.toFixed(2)),
    ]);
  }
  ui.rule("RECOVERY BY POLICY");
  ui.table(["Policy", "Recovered", "Share of at-risk ₹", "Retries"],
    tableRows, ["l", "r", "l", "r"]);
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
    const v = ui.verdict(d.delta, d.ci[0], d.ci[1]);
    deltaRows.push([
      dim(POLICY_LABEL[rival] ?? rival),
      v.tone(`${d.delta >= 0 ? "+" : ""}${(100 * d.delta).toFixed(1)}pp`),
      dim(`[${(100 * d.ci[0]).toFixed(1)}, ${(100 * d.ci[1]).toFixed(1)}]`),
      v.tone(v.label),
    ]);
  }
  ui.rule("WHYDUNIT vs EACH BASELINE  (₹ recovered, paired, 95% CI)");
  ui.table(["Compared with", "Delta", "95% CI", "Verdict"],
    deltaRows, ["l", "r", "l", "l"]);

  ui.rule("WHYDUNIT vs EACH BASELINE  (retries per failure, lower is better)");
  ui.table(["Compared with", "Delta", "95% CI", "Verdict"],
    ["naive_retry", "window_aware_retry", "rule_policy", "oracle_policy"].map((rival) => {
      const rd = retryDeltas[rival]!;
      const v = ui.verdict(rd.delta, rd.ci[0], rd.ci[1], true);
      return [
        dim(POLICY_LABEL[rival] ?? rival),
        v.tone(`${rd.delta >= 0 ? "+" : ""}${rd.delta.toFixed(2)}`),
        dim(`[${rd.ci[0].toFixed(2)}, ${rd.ci[1].toFixed(2)}]`),
        v.tone(v.label === "wins" ? "cheaper" : v.label === "loses" ? "costlier" : "ties"),
      ];
    }), ["l", "r", "l", "l"]);

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
      white(`${CAUSE_CODE[cause as Cause]}  ${CAUSE_NAME[cause as Cause]}`),
      dim(`${(100 * rupeeRate(n)).toFixed(1)}%`),
      good(`${(100 * rupeeRate(m)).toFixed(1)}%`),
      dim(String(m.reduce((a, r) => a + r.retries_spent, 0))),
    ]);
  }
  ui.rule("RECOVERY BY TRUE CAUSE");
  ui.table(["Cause", "Naive", "WhyDunit", "Retries"],
    causeRows, ["l", "r", "r", "r"]);
  const wasted = outcomes.model_policy!.filter((r) => silent.has(r.attempt_id)).reduce((a, r) => a + r.retries_spent, 0);
  ui.note("naive retry recovers 0% of C1: T+24/72/168h all keep the same hour");
  ui.note(`${wasted} retries burned on silent churn — unrecoverable, undetected`);

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
  ui.rule("AUTONOMOUS RECOVERY AGENT");
  ui.note(`${work.length.toLocaleString("en-IN")} failed payments · ${resuming ? "resuming" : "fresh"} · ${dbPath}`);
  const s = runAgent({ dbPath, work, customers, mandates, records: byId });

  ui.blank();
  if (s.resumed > 0) ui.step("warn", `resumed ${s.resumed} in-flight intervention(s) from a previous run`);
  ui.step("ok", "cause-matched action chosen for every payment");
  ui.step("ok", "four safety rules enforced before any action");
  ui.step("ok", `${s.audit_rows.toLocaleString("en-IN")} audit records written`);
  ui.step("ok", `${s.psp_effects.toLocaleString("en-IN")} interventions sent, each exactly once`);

  ui.rule("ACTIONS TAKEN");
  ui.table(["Action", "Payments", "Share"],
    Object.entries(s.by_action).sort((a, b) => b[1] - a[1]).map(([k, v]) => [
      white(ACTION_LABEL[k] ?? k),
      white(v.toLocaleString("en-IN")),
      ui.bar(v / s.audit_rows, 12) + dim(` ${((100 * v) / s.audit_rows).toFixed(1)}%`),
    ]), ["l", "r", "l"]);

  ui.rule("WHERE EACH MANDATE ENDED UP");
  ui.table(["Outcome", "Mandates", ""],
    Object.entries(s.by_cycle_status).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const tone = k === "recovered" ? good : k === "escalated" ? warn : dim;
      return [tone(CYCLE_LABEL[k] ?? k), tone(v.toLocaleString("en-IN")), ui.bar(v / s.audit_rows, 12, tone)];
    }), ["l", "r", "l"]);

  ui.rule("REVENUE RECOVERED");
  ui.kv([["Recovered this run", good(ui.moneyShort(s.recovered_amount)) + dim("  " + ui.money(s.recovered_amount))]]);
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

  ui.rule("AI ATTRIBUTION");
  ui.blank();
  ui.line("  " + white(`${report.n_failures.toLocaleString("en-IN")} failed payments analyzed`));
  ui.blank();
  ui.line(`  ${ui.OK} ${good(ui.pct(report.n_classified / report.n_failures))} ${white("Automatically Classified")}`);
  ui.line(`  ${ui.WARN} ${warn(ui.pct(report.n_routed / report.n_failures))} ${white("Sent to Human Review")}`);
  ui.blank();
  ui.note("human review = low confidence, conflicting evidence, or thin history");

  renderCauseTable(report);
  renderQueueTable(report);

  ui.rule("ACCURACY ON WHAT WAS AUTO-CLASSIFIED");
  ui.kv([
    ["macro-F1 on auto-classified", ui.withCI(good(report.macro_f1_classified.toFixed(3)), report.macro_f1_classified_ci[0], report.macro_f1_classified_ci[1])],
    ["macro-F1 over ALL failures", dim(report.macro_f1_all.toFixed(3))],
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
      white(`${CAUSE_CODE[cause]}  ${CAUSE_NAME[cause]}`),
      white(b.n.toLocaleString("en-IN")),
      ui.pct(b.n / report.n_failures).padStart(5) + " " + ui.bar(b.n / report.n_failures, 12),
    ]);
  }
  rows.push([
    warn("?   Human Review"),
    warn(report.n_routed.toLocaleString("en-IN")),
    ui.pct(report.n_routed / report.n_failures).padStart(5) + " " + ui.bar(report.n_routed / report.n_failures, 12, warn),
  ]);
  ui.rule("WHY ARE PAYMENTS FAILING?");
  ui.table(["Cause", "Payments", "Share"], rows, ["l", "r", "l"]);
  for (const cause of ["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL", "C4_CANCELLATION"] as Cause[]) {
    ui.note(`${CAUSE_CODE[cause]} — ${CAUSE_MEANING[cause]}`);
  }
}

function renderQueueTable(report: Report): void {
  const rows = Object.entries(report.by_reason).sort((a, b) => b[1] - a[1]).map(([k, v]) => [
    white(REASON_LABEL[k] ?? k), warn(v.toLocaleString("en-IN")),
  ]);
  if (rows.length === 0) return;
  ui.rule("WHAT NEEDED A HUMAN");
  ui.table(["Reason", "Payments"], rows, ["l", "r"]);
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

  ui.rule("MERCHANT DIGEST");
  ui.blank();
  ui.line("  " + ui.head(report.headline));
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
  ui.rule("PAYMENT HEALTH");
  ui.kv([
    ["Failed payments", white(report.n_failures.toLocaleString("en-IN"))],
    ["Money at risk", bad(ui.moneyShort(report.amount_at_risk)) + dim(`  ${ui.money(report.amount_at_risk)}`)],
    ["Auto classified", good(ui.pct(report.n_classified / report.n_failures)) + dim(`  ${report.n_classified.toLocaleString("en-IN")}`)],
    ["Human review", warn(ui.pct(report.n_routed / report.n_failures)) + dim(`  ${report.n_routed.toLocaleString("en-IN")}`)],
  ]);
}

function renderDecisionTable(): void {
  const rows = (["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL", "C4_CANCELLATION"] as Cause[])
    .map((cause) => [
      white(CAUSE_NAME[cause]),
      (cause === "C4_CANCELLATION" ? bad : good)(CAUSE_ACTION[cause]),
      dim(CAUSE_ACTION_DETAIL[cause]),
    ]);
  rows.push([warn("Uncertain"), warn("HUMAN REVIEW"), dim("queued with evidence")]);
  ui.table(["Failure cause", "Action", "What WhyDunit does"], rows, ["l", "l", "l"]);
  ui.note("WhyDunit does not blindly retry every failed payment.");
}

function renderOutcomeTable(tally: Record<string, number>): void {
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  if (total === 0) return;
  ui.rule("WHAT HAPPENED NEXT");
  ui.table(["Outcome", "Interventions", ""],
    Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const tone = k === "recovered" ? good : k === "failed" ? bad : dim;
      return [tone(OUTCOME_LABEL[k] ?? k), tone(v.toLocaleString("en-IN")), ui.bar(v / total, 12, tone)];
    }), ["l", "r", "l"]);
}

type PolicyFile = {
  results: Record<string, { rate: number; retries: number }>;
  paired_deltas: Record<string, { delta: number; ci: [number, number] }>;
};

function renderRevenueHero(report: Report, policy: PolicyFile, recoveredAmount: number): void {
  const naive = policy.results.naive_retry!;
  const model = policy.results.model_policy!;
  const delta = policy.paired_deltas.naive_retry!;
  const v = ui.verdict(delta.delta, delta.ci[0], delta.ci[1]);
  ui.rule("REVENUE RECOVERY");
  ui.kv([
    ["Money at risk", bad(ui.moneyShort(report.amount_at_risk)) + dim("  " + ui.money(report.amount_at_risk))],
    ["Money recovered", good(ui.moneyShort(recoveredAmount)) + dim("  " + ui.money(recoveredAmount))],
  ]);
  ui.table(
    ["Policy", "Recovered", "Retries / failure"],
    [
      [dim("Naive retry"), dim(ui.pct(naive.rate)), dim(naive.retries.toFixed(2))],
      [key("WhyDunit"), good(ui.pct(model.rate)), good(model.retries.toFixed(2))],
    ],
    ["l", "r", "r"],
  );
  ui.blank();
  ui.line(
    "  " + v.tone(`${delta.delta >= 0 ? "+" : ""}${(100 * delta.delta).toFixed(1)}pp`) +
    " recovery vs naive retry " +
    dim(`[${(100 * delta.ci[0]).toFixed(1)}, ${(100 * delta.ci[1]).toFixed(1)}]`) + "  " + v.tone(v.label),
  );
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

  ui.blank();
  const left = "  " + ui.head("WHYDUNIT") + dim("  ·  AI Payment Recovery Intelligence");
  ui.line(left + " ".repeat(Math.max(1, ui.W - ui.vlen(left) - 12)) + dim("RAZORPAY LAB"));
  ui.line("  " + dim("Diagnose failed payments → recover more revenue"));
  ui.line(dim("─".repeat(ui.W)));

  renderHealthPanel(report);
  renderCauseTable(report);

  ui.rule("AI ATTRIBUTION");
  ui.blank();
  ui.line("  " + white(`${report.n_failures.toLocaleString("en-IN")} failed payments analyzed`));
  ui.blank();
  ui.line(`  ${ui.OK} ${good(ui.pct(report.n_classified / report.n_failures))} ${white("Automatically Classified")}`);
  ui.line(`  ${ui.WARN} ${warn(ui.pct(report.n_routed / report.n_failures))} ${white("Sent to Human Review")}`);
  ui.blank();
  ui.note("Human review = low confidence or conflicting evidence");
  renderQueueTable(report);

  ui.rule("RECOVERY DECISION");
  renderDecisionTable();

  renderRevenueHero(report, policy, recovered);
  renderOutcomeTable(tally);

  ui.rule("DEMO COMPLETE");
  ui.rule("BUSINESS RESULT");
  ui.kv([
    ["Failed payments", white(report.n_failures.toLocaleString("en-IN"))],
    ["Automatically classified", good(ui.pct(report.n_classified / report.n_failures))],
    ["Human review", warn(ui.pct(report.n_routed / report.n_failures))],
    ["Money at risk", white(ui.moneyShort(report.amount_at_risk))],
    ["Money recovered", good(ui.moneyShort(recovered))],
    ["Naive retry recovery", dim(`${(100 * policy.results.naive_retry!.rate).toFixed(1)}%`)],
    ["WhyDunit recovery", good(`${(100 * policy.results.model_policy!.rate).toFixed(1)}%`)],
    ["Retries / failure", white(`${policy.results.naive_retry!.retries.toFixed(2)}`) + dim("  →  ") + good(`${policy.results.model_policy!.retries.toFixed(2)}`)],
  ]);
  ui.blank();
  ui.step("ok", "Diagnosis complete");
  ui.step("ok", "Recovery decision complete");
  ui.step("ok", "Safety checks enforced");
  ui.step("ok", "Audit trail generated");
  ui.blank();
}

type ExceptionFile = {
  attempt_id: string; reasons: string[];
  hypotheses: { cause: Cause; probability: number; evidence: string[] }[];
  resolving_evidence: string[];
};

/**
 * The single-case drill-down: one mandate, end to end, in the order a human
 * actually reasons about it. Ground truth is read last and labelled, so the
 * screen shows what the system knew before it shows whether it was right.
 */
function runExplainCase(): void {
  const id = process.argv[3];
  if (id === undefined) throw new Error("usage: node src/cli.ts explain <mandate_id>");
  for (const f of ["data/observations.jsonl", "data/predictions.jsonl", "data/features.jsonl"]) {
    if (!existsSync(f)) throw new Error(`${f} missing -- run \`npm run all\` first`);
  }

  const attempts = readJsonl<ObservedAttempt>("data/observations.jsonl")
    .filter((o) => o.mandate_id === id)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (attempts.length === 0) throw new Error(`no mandate ${id} in data/observations.jsonl`);

  const feats = new Map(readJsonl<FeatureRow>("data/features.jsonl").map((f) => [f.attempt_id, f]));
  const preds = new Map(readJsonl<Prediction>("data/predictions.jsonl").map((p) => [p.attempt_id, p]));
  const excs = existsSync("data/exceptions.jsonl")
    ? new Map(readJsonl<ExceptionFile>("data/exceptions.jsonl").map((e) => [e.attempt_id, e]))
    : new Map<string, ExceptionFile>();

  // The subject: the last failed attempt, which is the one with the most history
  // behind it and therefore the most to say.
  const failures = attempts.filter((a) => !a.success);
  if (failures.length === 0) throw new Error(`mandate ${id} never failed; nothing to attribute`);
  const subject = failures[failures.length - 1]!;
  const feat = feats.get(subject.attempt_id);
  const pred = preds.get(subject.attempt_id);
  const exc = excs.get(subject.attempt_id);

  ui.blank();
  ui.line("  " + ui.head(`MANDATE ${id}`) + dim(`  ·  ${subject.bank}  ·  ${ui.money(subject.amount)} monthly`));
  ui.line(dim("─".repeat(ui.W)));

  // ---- 1. what was observable ----
  ui.rule("1 · WHAT THE MERCHANT COULD SEE");
  const outcomes = attempts.map((a) => (a.success ? good("●") : bad("×"))).join(" ");
  ui.kv([
    ["Attempts", `${attempts.length}  ${outcomes}`],
    ["Failed", bad(String(failures.length)) + dim(` of ${attempts.length}`)],
    ["This failure", `${subject.timestamp.slice(0, 16).replace("T", " ")}  ${dim("code " + (subject.error_code ?? "none"))}`],
    ["Notice dispatched", `${subject.notification.hours_before_debit.toFixed(1)}h before debit`],
    ["Delivery receipt", subject.notification.receipt === null
      ? warn("none came back")
      : subject.notification.receipt === "delivered" ? good("delivered") : bad("FAILED")],
    ["Revoke webhook", subject.lifecycle_events.length === 0 ? dim("none") : warn(subject.lifecycle_events[0]!.timestamp.slice(0, 10))],
  ]);
  ui.blank();
  ui.line("  " + dim("NOT observable, by construction:"));
  for (const h of [
    "the customer's account balance at any point",
    "whether the bank actually delivered the pre-debit notice",
    "the customer's intent to cancel, unless a webhook fired",
    "the true cause, and whether more than one cause applied",
  ]) ui.line("  " + bad("×") + " " + dim(h));

  // ---- 2. the invariance test ----
  ui.rule("2 · INVARIANCE TEST — what does the failure move with?");
  const f = feat?.features ?? {};
  const failHours = failures.map((a) => Number(a.timestamp.slice(11, 13)));
  const failDays = failures.map((a) => Number(a.timestamp.slice(8, 10)));
  const distinctHours = new Set(failHours).size;
  const distinctDays = new Set(failDays).size;
  const bankExcess = Number(f.bank_fail_excess_7d ?? 0);
  const varies = (yes: boolean) => (yes ? warn("varies") : dim("invariant"));
  ui.table(
    ["Dimension", "This mandate", "", "Reads as"],
    [
      // C1 is a property of THIS attempt's clock position, not of the spread
      // across the mandate's history. Test the subject first, then the spread.
      ["Hour of day", `${String(Number(subject.timestamp.slice(11, 13))).padStart(2, "0")} ${dim("· all: " + failHours.map((h) => String(h).padStart(2, "0")).join(" "))}`,
        f.in_restricted_window === 1 ? warn("in window") : varies(distinctHours > 1),
        f.in_restricted_window === 1 ? key("C1 — inside 10:00-13:00")
          : distinctHours > 1 ? dim("not C1 — many hours") : dim("not C1 — outside window")],
      ["Bank vs fleet", `${subject.bank} ${bankExcess >= 0 ? "+" : ""}${(100 * bankExcess).toFixed(1)}pp`,
        varies(Math.abs(bankExcess) > 0.05),
        Math.abs(bankExcess) > 0.05 ? key("C2 — bank is an outlier") : dim("not C2 — bank normal")],
      ["Day of month", failDays.map((d) => String(d)).join(" "),
        varies(distinctDays > 1),
        Number(f.day_of_month ?? 0) >= 20 ? key("C3 — late in cycle")
          : dim("early cycle — funds likely")],
      // C4's signature is the CONSECUTIVE run since the customer stopped, not the
      // lifetime success rate: a mandate that worked for months and then never
      // again is exactly what silent churn looks like.
      ["Recent run", `${f.consecutive_prior_failures ?? 0} in a row / ${f.prior_distinct_fail_hours ?? 0} hours`,
        varies(Number(f.consecutive_prior_failures ?? 0) < 2),
        Number(f.consecutive_prior_failures ?? 0) >= 2 && Number(f.prior_distinct_fail_hours ?? 0) > 1
          ? key("C4 — nothing else explains it")
          : dim("no invariant run")],
    ],
    ["l", "l", "l", "l"],
  );
  const lifetime = attempts.filter((a) => a.success).length;
  ui.note(`outcome over time  ${attempts.map((a) => (a.success ? "▁" : "█")).join("")}   ${dim(`█ = failed · ${lifetime}/${attempts.length} ever succeeded`)}`);

  // ---- 3 & 4. hypotheses and attribution ----
  ui.rule("3 · COMPETING HYPOTHESES");
  if (pred !== undefined) {
    const ranked = (Object.entries(pred.proba) as [Cause, number][]).sort((a, b) => b[1] - a[1]);
    ui.table(["Cause", "P", "", "Evidence"],
      ranked.map(([cause, prob]) => {
        const ev = feat ? indicators(feat.features)[cause] : [];
        return [
          white(`${CAUSE_CODE[cause]} ${CAUSE_NAME[cause]}`),
          prob.toFixed(3),
          ui.bar(prob, 10),
          dim(ev[0] ?? "no direct observable"),
        ];
      }), ["l", "r", "l", "l"]);
  }

  ui.rule("4 · ATTRIBUTION");
  if (exc !== undefined) {
    ui.blank();
    ui.line("  " + warn("ROUTED TO HUMAN REVIEW"));
    for (const rn of exc.reasons) ui.line(`  ${ui.WARN} ${warn(REASON_LABEL[rn] ?? rn)}`);
    ui.blank();
    ui.line("  " + dim("what would resolve it:"));
    for (const rr of exc.resolving_evidence.slice(0, 3)) ui.line(`    ${ui.ARROW} ${dim(rr)}`);
  } else if (pred !== undefined) {
    const conf = Math.max(...Object.values(pred.proba));
    ui.kv([
      ["Cause", key(`${CAUSE_CODE[pred.predicted]} — ${CAUSE_NAME[pred.predicted]}`)],
      ["Meaning", dim(CAUSE_MEANING[pred.predicted])],
      ["Confidence", `${good(ui.pct(conf, 0))}  ${ui.bar(conf, 16, good)}`],
    ]);
  }

  // ---- 5 & 6. action, constraints, outcome ----
  if (existsSync("data/agent.db")) {
    const db = new Database("data/agent.db", { readonly: true });
    const audit = db.prepare("SELECT * FROM audit_log WHERE mandate_id = ? ORDER BY cycle, attempt_no").all(id) as {
      attempt_no: number; cycle: string; action: string; scheduled_at: string | null;
      checks_passed: string; checks_failed: string; checks_skipped: string; outcome: string;
    }[];
    db.close();
    ui.rule("5 · ACTION AND SAFETY CHECKS");
    if (audit.length === 0) {
      ui.note("no intervention recorded for this mandate");
    } else {
      const last = audit[audit.length - 1]!;
      ui.kv([["Action", key(ACTION_LABEL[last.action] ?? last.action)]]);
      ui.blank();
      for (const chk of JSON.parse(last.checks_passed) as string[]) ui.line(`  ${ui.OK} ${dim(CHECK_LABEL[chk] ?? chk)}`);
      for (const chk of JSON.parse(last.checks_failed) as string[]) ui.line(`  ${ui.FAIL} ${bad(CHECK_LABEL[chk] ?? chk)}`);
      for (const chk of JSON.parse(last.checks_skipped) as string[]) ui.line(`  ${dim("–")} ${dim((CHECK_LABEL[chk] ?? chk) + " (n/a)")}`);

      ui.rule("6 · OUTCOME");
      ui.table(["Cycle", "#", "Action", "Scheduled", "Result"],
        audit.map((a) => [
          dim(a.cycle), dim(String(a.attempt_no)),
          white(ACTION_LABEL[a.action] ?? a.action),
          dim(a.scheduled_at === null ? "—" : a.scheduled_at.slice(0, 16).replace("T", " ")),
          (a.outcome === "recovered" ? good : a.outcome === "failed" ? bad : dim)(OUTCOME_LABEL[a.outcome] ?? a.outcome),
        ]), ["l", "r", "l", "l", "l"]);
    }
  }

  // ---- 7. ground truth, last and labelled ----
  ui.rule("7 · GROUND TRUTH — evaluation only, never visible to the system");
  const truth = readJsonl<WorldRecord>("data/world.jsonl").find((w) => w.attempt_id === subject.attempt_id);
  if (truth === undefined) {
    ui.note("no world record found");
    return;
  }
  const correct = pred !== undefined && pred.predicted === truth.cause;
  ui.kv([
    ["True cause", white(`${CAUSE_CODE[truth.cause!]} — ${CAUSE_NAME[truth.cause!]}`)],
    ["Attributed", exc !== undefined ? warn("routed to human")
      : pred === undefined ? dim("n/a")
      : (correct ? good : bad)(`${CAUSE_CODE[pred.predicted]} — ${correct ? "correct" : "WRONG"}`)],
    ["Also blocked by", truth.blockers.length > 1
      ? warn(truth.blockers.slice(1).map((b) => CAUSE_CODE[b]).join(", ")) : dim("nothing else")],
    ["Balance at attempt", dim(ui.money(truth.world.balance_at_attempt))],
    ["Cancelled at", truth.world.churned_at === null ? dim("never")
      : warn(truth.world.churned_at.slice(0, 10) + (truth.world.churn_emits_event ? " (webhook sent)" : " (SILENT)"))],
  ]);
  ui.blank();
}

const VERIFIED: string[] = [
  "data/world.jsonl", "data/observations.jsonl", "data/features.jsonl",
  "data/predictions.jsonl", "data/exceptions.jsonl",
  "data/report.json", "data/policy.json", "data/evaluation.json",
  "data/metrics.json", "data/support.json",
];

type Manifest = {
  config: Record<string, number>;
  artifacts: Record<string, string>;
  headline: Record<string, number>;
};

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Scalars a human can read when a hash moves, so a failure says WHAT changed. */
function headlineOf(): Record<string, number> {
  const report = JSON.parse(readFileSync("data/report.json", "utf8")) as Report;
  const policy = JSON.parse(readFileSync("data/policy.json", "utf8")) as {
    n_failures: number; stop_threshold: number;
    results: Record<string, { rate: number; retries: number }>;
  };
  const evaluation = JSON.parse(readFileSync("data/evaluation.json", "utf8")) as {
    schemes: Record<string, { macro_f1: number; ece: number }>;
    out_of_fold: { macro_f1: number };
  };
  return {
    failures: report.n_failures,
    classified: report.n_classified,
    routed: report.n_routed,
    macro_f1_classified: +report.macro_f1_classified.toFixed(6),
    macro_f1_mandate: +evaluation.schemes.mandate!.macro_f1.toFixed(6),
    ece_mandate: +evaluation.schemes.mandate!.ece.toFixed(6),
    macro_f1_out_of_fold: +evaluation.out_of_fold.macro_f1.toFixed(6),
    stop_threshold: +policy.stop_threshold.toFixed(6),
    model_rate: +policy.results.model_policy!.rate.toFixed(6),
    rule_rate: +policy.results.rule_policy!.rate.toFixed(6),
    model_retries: +policy.results.model_policy!.retries.toFixed(6),
  };
}

function buildManifest(): Manifest {
  const artifacts: Record<string, string> = {};
  for (const f of VERIFIED) {
    if (!existsSync(f)) throw new Error(`${f} missing -- run \`npm run all\` first`);
    artifacts[f] = sha(f);
  }
  return {
    config: { seed: SEED, horizon_days: HORIZON_DAYS, cost_ratio: DEFAULT_COST_RATIO },
    artifacts,
    headline: headlineOf(),
  };
}

/**
 * Reproducibility proof. Regenerates the seeded world in-process, then compares
 * every committed artifact hash and every headline scalar against the manifest.
 * Exits non-zero on any mismatch so CI can gate on it.
 */
function runVerify(): void {
  const MANIFEST = "reference/manifest.json";
  if (process.argv.includes("--update")) {
    mkdirSync("reference", { recursive: true });
    writeFileSync(MANIFEST, JSON.stringify(buildManifest(), null, 2) + "\n");
    ui.rule("VERIFY · MANIFEST UPDATED");
    ui.note(`wrote ${MANIFEST} for horizon ${HORIZON_DAYS}d, seed ${SEED}`);
    return;
  }
  if (!existsSync(MANIFEST)) throw new Error(`${MANIFEST} missing -- run \`npm run verify -- --update\` first`);
  // Without --full this checks that the committed artifacts are self-consistent
  // and that the seeded world still reproduces. --full re-runs every stage first,
  // which is the only way to catch a change in the Python side of the pipeline.
  if (process.argv.includes("--full")) {
    const done = ui.progress("re-running the full pipeline");
    execSync("npm run all", { stdio: "ignore" });
    done("pipeline re-run from scratch");
  }
  const want = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;

  ui.rule("VERIFY · REPRODUCIBILITY");
  ui.kv([
    ["Reference", dim(`seed ${want.config.seed} · horizon ${want.config.horizon_days}d · cost ratio ${want.config.cost_ratio}`)],
    ["This run", dim(`seed ${SEED} · horizon ${HORIZON_DAYS}d · cost ratio ${DEFAULT_COST_RATIO}`)],
  ]);
  let failed = 0;

  for (const [k, v] of Object.entries(want.config)) {
    const now = k === "seed" ? SEED : k === "horizon_days" ? HORIZON_DAYS : DEFAULT_COST_RATIO;
    if (now !== v) {
      failed++;
      ui.blank();
      ui.line(`  ${ui.FAIL} ${bad(`config ${k} is ${now}, manifest expects ${v}`)}`);
      ui.note("regenerate with the manifest's config, or re-run with --update if this is intended");
    }
  }

  // Step 1: the seeded world is rebuilt from scratch, not read from disk.
  const doneGen = ui.progress("regenerating world from seed");
  const world = generateWorld();
  const observations = observe(world);
  doneGen(`regenerated ${world.length.toLocaleString("en-IN")} attempts from seed`);
  const onDisk = readJsonl<WorldRecord>("data/world.jsonl");
  const sameWorld =
    onDisk.length === world.length &&
    world.every((w, i) => JSON.stringify(w) === JSON.stringify(onDisk[i]));
  if (!sameWorld) failed++;
  ui.line(`  ${sameWorld ? ui.OK : ui.FAIL} ${sameWorld ? "world matches the committed data byte for byte" : bad("regenerated world differs from data/world.jsonl")}`);
  void observations;

  // Step 2: every committed artifact hash.
  const rows: string[][] = [];
  for (const f of VERIFIED) {
    const expected = want.artifacts[f];
    if (!existsSync(f)) {
      failed++;
      rows.push([f, bad("MISSING"), dim("—")]);
      continue;
    }
    const actual = sha(f);
    const ok = actual === expected;
    if (!ok) failed++;
    rows.push([f.replace("data/", ""), ok ? good("match") : bad("DIFFERS"), dim(actual.slice(0, 12))]);
  }
  ui.table(["Artifact", "Hash", "sha256"], rows, ["l", "l", "l"]);

  // Step 3: headline scalars, so a failure names the number that moved.
  const now = headlineOf();
  const moved: string[][] = [];
  for (const [k, v] of Object.entries(want.headline)) {
    const n = now[k];
    if (n === undefined || Math.abs(n - v) > 1e-9) {
      failed++;
      moved.push([k, dim(String(v)), bad(String(n ?? "missing"))]);
    }
  }
  if (moved.length > 0) ui.table(["Metric", "Expected", "Actual"], moved, ["l", "r", "r"]);

  ui.blank();
  if (failed === 0) {
    ui.line("  " + good("✓ REPRODUCIBLE") + dim("  every artifact and headline metric matches the manifest"));
  } else {
    ui.line("  " + bad(`✗ ${failed} MISMATCH${failed === 1 ? "" : "ES"}`) + dim("  this run does not reproduce the committed reference"));
    process.exitCode = 1;
  }
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
  if (command === "explain") return runExplainCase();
  if (command === "verify") return runVerify();
  if (command === "features") return buildFeatures();
  if (command === "agent") return runAgentCommand();
  if (command === "policy") return runPolicies();
  if (command !== "generate") {
    console.error("usage: node src/cli.ts <generate|features|report|policy|agent|digest|explain <mandate_id>|verify|demo>");
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

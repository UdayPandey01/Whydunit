import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { indicators } from "./exceptions.ts";
import { runAgent } from "./agent/agent.ts";
import type { WorkItem } from "./agent/agent.ts";
import { HORIZON_DAYS, SEED } from "./config.ts";
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

  console.log(`${P} mandates ${mandates}  attempts ${world.length}  horizon ${HORIZON_DAYS}d  seed ${SEED}`);
  console.log(`${P} failures ${fails.length} (${pct(fails.length, world.length)} of attempts)`);

  const byCause = new Map<string, number>();
  for (const f of fails) byCause.set(f.cause!, (byCause.get(f.cause!) ?? 0) + 1);
  console.log(`${P} class distribution (deliberately imbalanced):`);
  for (const [cause, n] of [...byCause].sort((a, b) => b[1] - a[1])) {
    console.log(`${P}   ${cause.padEnd(22)} ${String(n).padStart(5)}  ${pct(n, fails.length).padStart(6)} of failures  ${pct(n, world.length).padStart(6)} of attempts`);
  }

  const multi = fails.filter((f) => f.multi_cause);
  console.log(`${P} multi-cause ${multi.length} (${pct(multi.length, fails.length)} of failures)`);

  // Sanity check on the one place cause information reaches an observable: if any
  // decline code were ~100% pure the classifier would be a lookup table.
  const byCode = new Map<string, Map<string, number>>();
  for (const f of fails) {
    const m = byCode.get(f.error_code!) ?? new Map<string, number>();
    m.set(f.cause!, (m.get(f.cause!) ?? 0) + 1);
    byCode.set(f.error_code!, m);
  }
  console.log(`${P} decline-code ambiguity (max P(cause | code)):`);
  for (const [code, m] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [topCause, topN] = [...m].sort((a, b) => b[1] - a[1])[0]!;
    console.log(`${P}   ${code.padEnd(5)} n=${String(total).padStart(4)}  ${pct(topN, total).padStart(6)} ${topCause}`);
  }

  const withReceipt = observations.filter((o) => o.notification.receipt !== null).length;
  const withRevoke = observations.filter((o) => o.lifecycle_events.length > 0).length;
  const silentChurn = world.filter((w) => w.world.churned_at !== null && !w.world.churn_emits_event).length;
  console.log(`${P} observability: delivery receipt on ${pct(withReceipt, observations.length)} of attempts`);
  console.log(`${P} observability: mandate.revoked visible on ${withRevoke} attempts; ${silentChurn} attempts sit under SILENT churn`);
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
  console.log(`${FP} wrote data/features.jsonl (${rows.length} failed attempts, ${nFeatures} features)`);

  for (const scheme of ["mandate", "bank", "time"] as const) {
    const counts = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const side = r.split[scheme];
      const m = counts.get(side) ?? new Map<string, number>();
      m.set(r.label, (m.get(r.label) ?? 0) + 1);
      counts.set(side, m);
    }
    const fmt = (side: string) => {
      const m = counts.get(side) ?? new Map<string, number>();
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const parts = [...m].sort().map(([k, v]) => `${k.slice(0, 2)}=${v}`).join(" ");
      return `${side} ${String(total).padStart(4)} [${parts}]`;
    };
    console.log(`${FP}   split by ${scheme.padEnd(8)} ${fmt("train")}  |  ${fmt("test")}`);
  }
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
  const predictions = new Map(preds.map((p) => [p.attempt_id, p.predicted]));
  const rulePredictions = new Map(preds.map((p) => [p.attempt_id, p.rule_predicted]));
  if (predictions.size === 0) throw new Error("no predictions -- run eval/evaluate.py first");

  const totalAmount = failures.reduce((a, r) => a + r.amount, 0);
  const rupeeRate = (rows: PolicyOutcome[]) => {
    const denom = rows.reduce((a, r) => a + r.amount, 0);
    return denom === 0 ? 0 : rows.filter((r) => r.recovered).reduce((a, r) => a + r.amount, 0) / denom;
  };
  const retriesPer = (rows: PolicyOutcome[]) =>
    rows.length === 0 ? 0 : rows.reduce((a, r) => a + r.retries_spent, 0) / rows.length;

  console.log(`${PP} ${failures.length} failed attempts, ${totalAmount.toLocaleString("en-IN")} rupees at risk`);
  console.log(`${PP} predictions are out-of-fold (5-fold grouped by mandate), retry budget ${3} per failure`);
  console.log(`${PP}`);
  console.log(`${PP} ${"policy".padEnd(20)}${"recovery rate (rupees)".padStart(28)}${"retries/failure".padStart(24)}${"rec/retry".padStart(11)}`);

  const results: Record<string, { rate: number; ci: [number, number]; retries: number; retries_ci: [number, number]; recovered: number; spent: number }> = {};
  const outcomes: Record<string, PolicyOutcome[]> = {};
  for (const [name, schedule] of Object.entries(schedulesFor(predictions, rulePredictions))) {
    const out = runPolicy(failures, customers, mandates, schedule);
    outcomes[name] = out;
    const rate = rupeeRate(out);
    const ci = bootstrapCI(out, rupeeRate);
    const retries = retriesPer(out);
    const retriesCi = bootstrapCI(out, retriesPer);
    const spent = out.reduce((a, r) => a + r.retries_spent, 0);
    const recovered = out.filter((r) => r.recovered).length;
    results[name] = { rate, ci, retries, retries_ci: retriesCi, recovered, spent };
    const perRetry = spent === 0 ? 0 : recovered / spent;
    console.log(
      `${PP} ${name.padEnd(20)}` +
        `${(`${(100 * rate).toFixed(1)}% [${(100 * ci[0]).toFixed(1)}, ${(100 * ci[1]).toFixed(1)}]`).padStart(28)}` +
        `${(`${retries.toFixed(2)} [${retriesCi[0].toFixed(2)}, ${retriesCi[1].toFixed(2)}]`).padStart(24)}` +
        `${perRetry.toFixed(3).padStart(11)}`,
    );
  }

  // The whole point of asking for CIs: say plainly whether the model is
  // distinguishable from the thing it is supposed to beat.
  console.log(`${PP}`);
  const deltas: Record<string, { delta: number; ci: [number, number] }> = {};
  for (const rival of ["naive_retry", "window_aware_retry", "rule_policy", "oracle_policy"]) {
    const d = pairedDeltaCI(outcomes.model_policy!, outcomes[rival]!, rupeeRate);
    deltas[rival] = d;
    const straddles = d.ci[0] <= 0 && d.ci[1] >= 0;
    console.log(
      `${PP} model_policy - ${rival.padEnd(19)} ` +
        `${(100 * d.delta).toFixed(1)}pp [${(100 * d.ci[0]).toFixed(1)}, ${(100 * d.ci[1]).toFixed(1)}]  ` +
        (straddles ? "<- CI STRADDLES ZERO, not distinguishable" : "<- distinguishable"),
    );
  }

  // Where does the recovery actually come from? Split by TRUE cause.
  console.log(`${PP}`);
  console.log(`${PP} recovery by true cause (rupees recovered / at risk), and retries burned:`);
  const causeOf = new Map(failures.map((f) => [f.attempt_id, f.cause!]));
  // churned_at is a MANDATE property, so it is also set on attempts that failed
  // for another reason before the cancellation. Scope by the attempt's own cause.
  const silent = new Set(
    failures
      .filter((f) => f.cause === "C4_CANCELLATION" && !f.world.churn_emits_event)
      .map((f) => f.attempt_id),
  );
  for (const cause of ["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL", "C4_CANCELLATION"]) {
    const pick = (rows: PolicyOutcome[]) => rows.filter((r) => causeOf.get(r.attempt_id) === cause);
    const m = pick(outcomes.model_policy!);
    const n = pick(outcomes.naive_retry!);
    console.log(
      `${PP}   ${cause.padEnd(22)} naive ${(100 * rupeeRate(n)).toFixed(1).padStart(5)}%  ` +
        `model ${(100 * rupeeRate(m)).toFixed(1).padStart(5)}%   ` +
        `model retries ${(m.reduce((a, r) => a + r.retries_spent, 0)).toString().padStart(4)}`,
    );
  }
  const wasted = outcomes.model_policy!.filter((r) => silent.has(r.attempt_id)).reduce((a, r) => a + r.retries_spent, 0);
  console.log(`${PP}   retries burned on SILENT churn (unrecoverable, undetected): ${wasted}`);

  writeFileSync("data/policy.json", JSON.stringify({ n_failures: failures.length, total_amount: totalAmount, results, paired_deltas: deltas }, null, 2) + "\n");
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
        routed_to_exception_queue: routed.has(r.attempt_id),
      };
    });

  mkdirSync("data", { recursive: true });
  const resuming = existsSync(dbPath);
  console.log(`${AP} ${work.length} failed attempts, db ${dbPath}${resuming ? " (resuming)" : " (new)"}`);
  const s = runAgent({ dbPath, work, customers, mandates, records: byId });

  console.log(`${AP} resumed ${s.resumed} in-flight intervention(s) from a previous run`);
  console.log(`${AP} audit rows ${s.audit_rows}, PSP effects ${s.psp_effects}`);
  console.log(`${AP} actions:`);
  for (const [k, v] of Object.entries(s.by_action).sort((a, b) => b[1] - a[1])) {
    console.log(`${AP}   ${k.padEnd(38)} ${String(v).padStart(5)}`);
  }
  console.log(`${AP} outcomes:`);
  for (const [k, v] of Object.entries(s.by_outcome).sort((a, b) => b[1] - a[1])) {
    console.log(`${AP}   ${k.padEnd(38)} ${String(v).padStart(5)}`);
  }
  console.log(`${AP} cycle end states:`);
  for (const [k, v] of Object.entries(s.by_cycle_status).sort((a, b) => b[1] - a[1])) {
    console.log(`${AP}   ${k.padEnd(38)} ${String(v).padStart(5)}`);
  }
  console.log(`${AP} recovered ${s.recovered_amount.toLocaleString("en-IN")} rupees`);
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

  console.log(`${RP} ${report.headline}`);
  for (const line of renderAttribution(report)) console.log(`${RP} ${line}`);
  console.log(`${RP} macro-F1 over ALL failures, routed or not: ${report.macro_f1_all.toFixed(3)}`);
  console.log(`${RP} wrote data/report.json and data/exceptions.jsonl`);
  console.log(`${RP} run the agent, then \`npm run digest\` for the merchant summary`);
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
  for (const line of digest) console.log(`${DP} ${line}`);
  console.log(`${DP} wrote data/digest.txt`);

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
  if (command === "features") return buildFeatures();
  if (command === "agent") return runAgentCommand();
  if (command === "policy") return runPolicies();
  if (command !== "generate") {
    console.error("usage: node src/cli.ts <generate|features|report|policy|agent|digest>");
    process.exit(1);
  }

  const world = generateWorld();
  if (world.length === 0) throw new Error("generator produced no attempts");
  const observations = observe(world);

  mkdirSync("data", { recursive: true });
  writeJsonl("data/world.jsonl", world);
  writeJsonl("data/observations.jsonl", observations);

  console.log(`${P} wrote data/world.jsonl (${world.length} records, ground truth included)`);
  console.log(`${P} wrote data/observations.jsonl (${observations.length} records, merchant-visible only)`);
  summarise(world, observations);
}

main();

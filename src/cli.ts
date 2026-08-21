import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { HORIZON_DAYS, SEED } from "./config.ts";
import { computeFeatures } from "./features.ts";
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

type Prediction = { attempt_id: string; predicted: Cause; rule_predicted: Cause };

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

function main(): void {
  const command = process.argv[2];
  if (command === "features") return buildFeatures();
  if (command === "policy") return runPolicies();
  if (command !== "generate") {
    console.error("usage: node src/cli.ts <generate|features|policy>");
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

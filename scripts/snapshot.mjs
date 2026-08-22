/**
 * Freezes the real pipeline artifacts into one small JSON the web app imports at
 * build time. data/ is gitignored, so without this a fresh clone (or Vercel) has
 * no numbers — and hardcoding them in the frontend would let them drift from the
 * pipeline silently. The provenance block is what makes the snapshot auditable.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const lines = (p) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const report = read("data/report.json");
const policy = read("data/policy.json");
const evaluation = read("data/evaluation.json");
const manifest = read("reference/manifest.json");

// The hero case, pulled live rather than transcribed.
const HERO = "mdt_00004";
const obs = lines("data/observations.jsonl").filter((o) => o.mandate_id === HERO)
  .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
const preds = new Map(lines("data/predictions.jsonl").map((p) => [p.attempt_id, p]));
const failures = obs.filter((o) => !o.success);
const subject = failures[failures.length - 1];

const snapshot = {
  provenance: {
    seed: manifest.config.seed,
    horizon_days: manifest.config.horizon_days,
    generated: new Date().toISOString().slice(0, 10),
    manifest_sha: createHash("sha256").update(readFileSync("reference/manifest.json")).digest("hex").slice(0, 12),
  },
  totals: {
    failures: report.n_failures,
    classified: report.n_classified,
    routed: report.n_routed,
    at_risk: report.amount_at_risk,
    classified_amount: report.amount_classified,
    routed_amount: report.amount_routed,
    macro_f1: report.macro_f1_classified,
    macro_f1_ci: report.macro_f1_classified_ci,
    macro_f1_all: report.macro_f1_all,
    ece: evaluation.schemes.mandate.ece,
    oof_vs_rule: evaluation.out_of_fold.model_minus_expert_rule,
  },
  causes: Object.entries(report.by_cause).map(([id, v]) => ({
    id, n: v.n, amount: v.amount, correct: v.correct,
  })),
  queue: report.by_reason,
  policies: Object.entries(policy.results).map(([id, v]) => ({
    id, rate: v.rate, retries: v.retries,
  })),
  deltas: policy.paired_deltas,
  sweep: policy.sweep.map((s) => ({ t: s.threshold, rate: s.rate, retries: s.retries, net: s.net })),
  hero: {
    mandate: HERO,
    bank: subject.bank,
    amount: subject.amount,
    timestamp: subject.timestamp,
    error_code: subject.error_code,
    receipt: subject.notification.receipt,
    proba: preds.get(subject.attempt_id).proba,
    attempts: obs.map((o) => ({
      at: o.timestamp,
      hour: Number(o.timestamp.slice(11, 13)) + Number(o.timestamp.slice(14, 16)) / 60,
      day: Number(o.timestamp.slice(8, 10)),
      ok: o.success,
    })),
  },
};

writeFileSync("web/src/data/snapshot.json", JSON.stringify(snapshot, null, 2) + "\n");
console.log(`[snapshot] ${snapshot.totals.failures} failures · seed ${snapshot.provenance.seed} · ${snapshot.provenance.horizon_days}d`);
console.log(`[snapshot] hero ${HERO} ${subject.bank} ₹${subject.amount} @ ${subject.timestamp.slice(0, 16)} code ${subject.error_code}`);

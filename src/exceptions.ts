import type { FeatureRow } from "./features.ts";
import type { Cause } from "./world/types.ts";

export const AMBIGUITY_MARGIN = 0.15;
export const MIN_PRIOR_ATTEMPTS = 2;
export const MIN_BANK_TRAIN_ROWS = 40;
export const NOVEL_FEATURE_THRESHOLD = 2;

export type ExceptionReason =
  | "insufficient_history"
  | "ambiguous_top_two"
  | "multi_cause_conflict"
  | "outside_training_support";

export type Support = {
  banks: string[];
  bank_train_counts: Record<string, number>;
  feature_range: Record<string, [number | null, number | null]>;
};

export type Hypothesis = { cause: Cause; probability: number; evidence: string[] };

export type ExceptionRecord = {
  attempt_id: string;
  mandate_id: string;
  bank: string;
  timestamp: string;
  amount: number;
  reasons: ExceptionReason[];
  detail: string[];
  hypotheses: Hypothesis[];
  resolving_evidence: string[];
  model_said: Cause;
  model_confidence: number;
};

const LABEL: Record<Cause, string> = {
  C1_EXECUTION_WINDOW: "execution window",
  C2_NOTIFICATION_FAIL: "notification failure",
  C3_BALANCE_SHORTFALL: "balance shortfall",
  C4_CANCELLATION: "cancellation",
};

/**
 * Observable indicators of each mechanism.
 *
 * The world's `multi_cause` flag is hidden by construction, so a conflict has to
 * be inferred from evidence a merchant actually holds: two or more independent
 * indicators firing on the same attempt. This is a much weaker detector than the
 * hidden flag — see DESIGN.md §5 for its measured recall — but it is the only
 * version that does not reach across the observation boundary.
 */
export function indicators(f: Record<string, number | null>): Record<Cause, string[]> {
  const out: Record<Cause, string[]> = {
    C1_EXECUTION_WINDOW: [],
    C2_NOTIFICATION_FAIL: [],
    C3_BALANCE_SHORTFALL: [],
    C4_CANCELLATION: [],
  };
  if (f.in_restricted_window === 1) {
    out.C1_EXECUTION_WINDOW.push(`attempted at ${String(f.hour).padStart(2, "0")}:00 IST, inside the NPCI 10:00-13:00 restricted window`);
  }
  if (f.receipt_delivered === 0) {
    out.C2_NOTIFICATION_FAIL.push("the PSP delivery receipt for the pre-debit notification came back FAILED");
  }
  if (f.notify_lead_under_24 === 1) {
    out.C2_NOTIFICATION_FAIL.push(`notification dispatched ${Number(f.notify_lead_hours).toFixed(1)}h before the debit, under the 24h NPCI minimum`);
  }
  if (f.revoked_before_attempt === 1) {
    out.C4_CANCELLATION.push(`a mandate.revoked webhook arrived ${Number(f.hours_since_revoke).toFixed(0)}h before this attempt`);
  }
  if (f.code_Z9 === 1) {
    out.C3_BALANCE_SHORTFALL.push("bank returned Z9 (insufficient funds)");
  }
  return out;
}

function firing(f: Record<string, number | null>): Cause[] {
  return (Object.entries(indicators(f)) as [Cause, string[]][])
    .filter(([, ev]) => ev.length > 0)
    .map(([c]) => c);
}

// Circumstantial support, used to explain a hypothesis that has no hard indicator.
// Always returns at least one line: a competing hypothesis listed with no evidence
// at all tells a reviewer nothing, and the ABSENCE of an indicator is itself the
// useful fact ("it was not in the window, so the window does not explain it").
function circumstantial(f: Record<string, number | null>, cause: Cause): string[] {
  const ev: string[] = [];
  if (cause === "C2_NOTIFICATION_FAIL") {
    if (f.receipt_missing === 1) ev.push("no delivery receipt came back at all, so bank-side delivery is unobserved");
    if (f.bank_burst_z !== null && f.bank_burst_z !== undefined && f.bank_burst_z > 2) {
      ev.push(`this bank's 24h failure rate is ${Number(f.bank_burst_z).toFixed(1)}σ above its own 30d baseline, consistent with an outage burst`);
    }
  }
  if (cause === "C3_BALANCE_SHORTFALL" && f.day_of_month !== null) {
    ev.push(`day ${f.day_of_month} of the month, ${f.mandate_prior_n} prior attempt(s) on this mandate`);
  }
  if (cause === "C4_CANCELLATION") {
    if (f.all_prior_failed === 1 && Number(f.prior_distinct_fail_hours) > 1) {
      ev.push(`${f.consecutive_prior_failures} consecutive failures across ${f.prior_distinct_fail_hours} distinct hours — no situational factor explains them`);
    }
    if (f.mandate_prior_n === 0) ev.push("no prior attempts, so failure invariance cannot be assessed at all");
  }
  if (ev.length === 0) ev.push(ABSENT[cause](f));
  return ev;
}

// Why a hypothesis is NOT directly indicated. Stated explicitly so a reviewer can
// see what was ruled out rather than inferring it from silence.
const ABSENT: Record<Cause, (f: Record<string, number | null>) => string> = {
  C1_EXECUTION_WINDOW: (f) =>
    `attempted at ${String(f.hour).padStart(2, "0")}:00 IST, outside the 10:00-13:00 window, so the window does not explain it`,
  C2_NOTIFICATION_FAIL: (f) =>
    f.receipt_delivered === 1
      ? "the notification was confirmed delivered on time, so notification failure is not indicated"
      : "no direct notification evidence either way",
  C3_BALANCE_SHORTFALL: () => "no insufficient-funds decline code was returned",
  C4_CANCELLATION: () => "no revoke webhook, and no invariant run of failures to point at cancellation",
};

// What would actually settle a given contest. Keyed by the competing pair so the
// queue tells a human what to go and look at, not just that it is unsure.
const RESOLVES: Record<string, string[]> = {
  "C1_EXECUTION_WINDOW|C3_BALANCE_SHORTFALL": [
    "retry outside 10:00-13:00 at the same point in the salary cycle: success isolates the window, failure isolates funds",
  ],
  "C2_NOTIFICATION_FAIL|C3_BALANCE_SHORTFALL": [
    "obtain the delivery receipt for the pre-debit notification from the PSP",
    "re-dispatch the notification and retry 26h later: success isolates notification delivery",
  ],
  "C3_BALANCE_SHORTFALL|C4_CANCELLATION": [
    "one successful debit on this mandate in any later cycle rules out cancellation",
    "a mandate.revoked webhook, or the customer's UPI app showing the mandate paused, confirms cancellation",
    "retry just after the customer's next credit: success isolates funds",
  ],
  "C1_EXECUTION_WINDOW|C2_NOTIFICATION_FAIL": [
    "re-dispatch the notification and retry outside the restricted window: this separates the two in one attempt",
  ],
  "C2_NOTIFICATION_FAIL|C4_CANCELLATION": [
    "re-dispatch the notification and retry: continued failure with a confirmed delivery points to cancellation",
  ],
  "C1_EXECUTION_WINDOW|C4_CANCELLATION": [
    "retry outside the restricted window: continued failure points to cancellation",
  ],
};

function resolvingEvidence(top: Cause[], reasons: ExceptionReason[]): string[] {
  const out: string[] = [];
  const key = [top[0]!, top[1]!].sort().join("|");
  out.push(...(RESOLVES[key] ?? ["a further attempt under changed conditions is needed to separate the hypotheses"]));
  if (reasons.includes("insufficient_history")) {
    out.push(`at least ${MIN_PRIOR_ATTEMPTS} prior attempts on this mandate, so that failure invariance can be assessed`);
  }
  if (reasons.includes("outside_training_support")) {
    out.push("labelled examples from this bank or this operating regime, to bring it inside training support");
  }
  return out;
}

/**
 * The routing decision. Pure, deterministic, and entirely in code — no model and
 * no LLM participates in deciding what a human sees.
 *
 * Returns null when the attempt can be auto-attributed.
 */
export function routeException(
  row: FeatureRow,
  probabilities: Record<Cause, number>,
  support: Support,
  amount: number,
): ExceptionRecord | null {
  const f = row.features;
  const ranked = (Object.entries(probabilities) as [Cause, number][]).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const margin = top![1] - second![1];
  const fired = firing(f);

  const reasons: ExceptionReason[] = [];
  const detail: string[] = [];

  // Rule A, narrowed: thin history only matters when no single observable already
  // settles the call. Blanket routing measured WORSE than no queue at all --
  // it swept away easy in-window and revoke-webhook cases and kept the residue.
  // See DESIGN.md §5.
  const decisive = fired.length === 1;
  if (Number(f.mandate_prior_n) < MIN_PRIOR_ATTEMPTS && !decisive) {
    reasons.push("insufficient_history");
    detail.push(`${f.mandate_prior_n} prior attempt(s), and no single observable settles the cause`);
  }

  if (margin < AMBIGUITY_MARGIN) {
    reasons.push("ambiguous_top_two");
    detail.push(`top two hypotheses separated by only ${margin.toFixed(3)} (${LABEL[top![0]]} ${top![1].toFixed(2)} vs ${LABEL[second![0]]} ${second![1].toFixed(2)})`);
  }

  if (fired.length >= 2) {
    reasons.push("multi_cause_conflict");
    detail.push(`${fired.length} independent mechanisms show observable evidence at once: ${fired.map((c) => LABEL[c]).join(" and ")}`);
  }

  const bankCount = support.bank_train_counts[row.bank] ?? 0;
  if (!support.banks.includes(row.bank) || bankCount < MIN_BANK_TRAIN_ROWS) {
    reasons.push("outside_training_support");
    detail.push(
      support.banks.includes(row.bank)
        ? `bank ${row.bank} has only ${bankCount} training rows, below the ${MIN_BANK_TRAIN_ROWS} needed to trust a bank-relative feature`
        : `bank ${row.bank} was never seen in training`,
    );
  } else {
    const novel = Object.entries(f).filter(([name, v]) => {
      const range = support.feature_range[name];
      if (v === null || range === undefined || range[0] === null || range[1] === null) return false;
      return v < range[0] || v > range[1];
    });
    if (novel.length >= NOVEL_FEATURE_THRESHOLD) {
      if (!reasons.includes("outside_training_support")) reasons.push("outside_training_support");
      detail.push(`${novel.length} features fall outside their training range (${novel.slice(0, 3).map(([n]) => n).join(", ")})`);
    }
  }

  if (reasons.length === 0) return null;

  const hypotheses: Hypothesis[] = ranked
    .filter(([, p], i) => i < 2 || p >= 0.05)
    .map(([cause, probability]) => {
      const hard = indicators(f)[cause];
      return {
        cause,
        probability: Math.round(probability * 1000) / 1000,
        evidence: hard.length > 0 ? hard : circumstantial(f, cause),
      };
    });

  return {
    attempt_id: row.attempt_id,
    mandate_id: row.mandate_id,
    bank: row.bank,
    timestamp: row.timestamp,
    amount,
    reasons,
    detail,
    hypotheses,
    resolving_evidence: resolvingEvidence(ranked.map(([c]) => c), reasons),
    model_said: top![0],
    model_confidence: Math.round(top![1] * 1000) / 1000,
  };
}

import { DEFAULT_COST_RATIO, HORIZON_DAYS, NOTIFY_MIN_LEAD_HOURS, START_MS } from "../config.ts";
import { decideCause, stopThreshold } from "../decision.ts";
import { hash32, makeRng } from "../rng.ts";
import { cycleOf, nextMonthDay, SAFE_HOUR, toSafeHour } from "../schedule.ts";
import { DAY_MS, HOUR_MS, istMs, istParts, toIso } from "../time.ts";
import { wasDeliveredByBank } from "../world/notification.ts";
import { attemptAt } from "../world/replay.ts";
import type { Notify } from "../world/replay.ts";
import type { Cause, Customer, Mandate, WorldRecord } from "../world/types.ts";
import { CHECKS, checkConstraints, EFFECTFUL, MAX_INTERVENTIONS_PER_CYCLE } from "./constraints.ts";
import type { ActionName, CheckedPlan, Plan } from "./constraints.ts";
import { openDb } from "./db.ts";
import type { Db } from "./db.ts";
import { fire } from "./psp.ts";

// The agent may only act inside the window it can actually observe. Beyond this
// the world would still answer, but we would be booking recoveries in a period
// the simulation never generated -- so instead the agent hands those to a human.
export const HORIZON_END_MS = START_MS + HORIZON_DAYS * DAY_MS;

// What the agent is allowed to know: predictions and merchant-visible facts.
export type WorkItem = {
  source_attempt: string;
  mandate_id: string;
  bank: string;
  failed_at: number;
  notification_dispatch_at: number;
  revoked_at: number | null;
  cause: Cause | null;
  confidence: number;
  // Full calibrated distribution. The stop decision needs P(C4) itself, not the
  // argmax label, because the two mistakes it trades off are not symmetric.
  proba: Record<Cause, number> | null;
  // Set by src/exceptions.ts. The router is the single authority on what a human
  // sees; Phase 3's bare confidence threshold was a placeholder and is gone, so
  // two thresholds can never disagree.
  routed_to_exception_queue: boolean;
};

export type AgentOptions = {
  dbPath: string;
  work: WorkItem[];
  // Adjudication only. The agent never reads these to make a decision; they are
  // the world answering "would that retry have worked".
  customers: Map<string, Customer>;
  mandates: Map<string, Mandate>;
  records: Map<string, WorldRecord>;
  crashAfter?: number;
  /** Cost-derived P(C4) above which stopping is the cheaper bet. */
  stopThreshold?: number;
};

// ---------- crash injection ----------

let crashBudget: number | null = null;

// SIGKILL to self: uncatchable, no unwinding, no finally, no flush. Anything the
// process believed but had not committed is simply gone -- which is the only
// honest way to test a durability claim.
function checkpoint(): void {
  if (crashBudget === null) return;
  crashBudget -= 1;
  if (crashBudget <= 0) process.kill(process.pid, "SIGKILL");
}

// ---------- decision ----------

export function decide(
  item: WorkItem,
  attemptNo: number,
  revokedBefore: boolean,
  threshold: number = stopThreshold(DEFAULT_COST_RATIO),
): { action: ActionName; cause: Cause | null } {
  // An explicit revoke is certain knowledge, not a prediction, so it stops
  // unconditionally. Everything below is a belief and gets the cost test.
  if (revokedBefore) return { action: "stop", cause: "C4_CANCELLATION" };
  if (attemptNo > MAX_INTERVENTIONS_PER_CYCLE) return { action: "escalate_to_human", cause: item.cause };
  if (item.routed_to_exception_queue) return { action: "escalate_to_human", cause: item.cause };
  if (item.proba === null) return { action: "escalate_to_human", cause: item.cause };

  const { cause, stop } = decideCause(item.proba, threshold);
  if (stop) return { action: "stop", cause };
  switch (cause) {
    case "C2_NOTIFICATION_FAIL":
      return { action: "refire_notification_then_reschedule", cause };
    default:
      return { action: "reschedule", cause };
  }
}

// Cause-matched timing. Each branch addresses that cause and nothing else.
// Returns null when no legal slot exists inside the horizon, which the caller
// turns into an escalation rather than a silent no-op.
export function scheduleFor(cause: Cause | null, attemptNo: number, from: number): number | null {
  let at: number;
  if (cause === "C1_EXECUTION_WINDOW") {
    const p = istParts(from);
    const sameDay = istMs(p.year, p.month, p.day, SAFE_HOUR, p.minute);
    const first = sameDay > from ? sameDay : toSafeHour(from + 24 * HOUR_MS);
    at = toSafeHour(first + [0, 24, 72][attemptNo - 1]! * HOUR_MS);
  } else if (cause === "C2_NOTIFICATION_FAIL") {
    at = toSafeHour(from + [26, 50, 96][attemptNo - 1]! * HOUR_MS);
  } else if (attemptNo === 3) {
    at = nextMonthDay(from, 2);
  } else {
    at = toSafeHour(from + [72, 168][attemptNo - 1]! * HOUR_MS);
  }
  return at <= from || at >= HORIZON_END_MS ? null : at;
}

// ---------- persistence helpers ----------

type CycleRow = { interventions_used: number; status: string };

function cycleState(db: Db, mandate: string, cycle: string): CycleRow {
  db.prepare(
    "INSERT OR IGNORE INTO cycle_state(mandate_id, cycle, interventions_used, status) VALUES (?,?,0,'open')",
  ).run(mandate, cycle);
  return db
    .prepare("SELECT interventions_used, status FROM cycle_state WHERE mandate_id=? AND cycle=?")
    .get(mandate, cycle) as CycleRow;
}

function notifyFor(opts: AgentOptions, item: WorkItem, plan: Plan): Notify {
  if (plan.action === "refire_notification_then_reschedule") {
    const dispatchMs = plan.notification_dispatch_at!;
    // Seeded from the idempotency key so a replayed fire re-draws identically.
    const rng = makeRng(hash32(plan.idempotency_key));
    return { dispatchMs, delivered: wasDeliveredByBank(item.bank, dispatchMs, rng) };
  }
  const rec = opts.records.get(item.source_attempt)!;
  return {
    dispatchMs: item.notification_dispatch_at,
    delivered: rec.world.notification_delivered_by_bank,
  };
}

// The ONLY function that produces an effect, and it accepts nothing but a
// CheckedPlan, so an unchecked plan cannot reach the PSP.
function execute(db: Db, opts: AgentOptions, item: WorkItem, plan: CheckedPlan) {
  const customer = opts.customers.get(opts.records.get(item.source_attempt)!.customer_id)!;
  const mandate = opts.mandates.get(item.mandate_id)!;
  const notify = notifyFor(opts, item, plan);
  return fire(db, plan.idempotency_key, plan.mandate_id, toIso(plan.scheduled_at!), () =>
    attemptAt(customer, mandate, plan.scheduled_at!, notify),
  );
}

function recordIntent(db: Db, plan: Plan, checks: { passed: string[]; failed: string[]; skipped: string[] }) {
  // Intent and budget consumption commit together. If the process dies after
  // this, the mandate has already spent the intervention and the pending row is
  // resumable -- it can never quietly acquire a fourth.
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO audit_log
       (idempotency_key, decided_at, mandate_id, cycle, attempt_no, source_attempt, cause,
        confidence, action, scheduled_at, notification_at, checks_passed, checks_failed, checks_skipped, status, outcome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', NULL)`,
    ).run(
      plan.idempotency_key, toIso(plan.decided_at), plan.mandate_id, plan.cycle, plan.attempt_no,
      plan.source_attempt, plan.cause, plan.confidence, plan.action,
      plan.scheduled_at === null ? null : toIso(plan.scheduled_at),
      plan.notification_dispatch_at === null ? null : toIso(plan.notification_dispatch_at),
      JSON.stringify(checks.passed), JSON.stringify(checks.failed), JSON.stringify(checks.skipped),
    );
    db.prepare(
      "UPDATE cycle_state SET interventions_used = interventions_used + 1 WHERE mandate_id=? AND cycle=?",
    ).run(plan.mandate_id, plan.cycle);
  })();
}

function recordTerminal(
  db: Db, plan: Plan, checks: { passed: string[]; failed: string[]; skipped: string[] },
  outcome: string, cycleStatus: string,
) {
  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO audit_log
       (idempotency_key, decided_at, mandate_id, cycle, attempt_no, source_attempt, cause,
        confidence, action, scheduled_at, notification_at, checks_passed, checks_failed, checks_skipped, status, outcome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'completed', ?)`,
    ).run(
      plan.idempotency_key, toIso(plan.decided_at), plan.mandate_id, plan.cycle, plan.attempt_no,
      plan.source_attempt, plan.cause, plan.confidence, plan.action,
      plan.scheduled_at === null ? null : toIso(plan.scheduled_at),
      plan.notification_dispatch_at === null ? null : toIso(plan.notification_dispatch_at),
      JSON.stringify(checks.passed), JSON.stringify(checks.failed), JSON.stringify(checks.skipped), outcome,
    );
    db.prepare("UPDATE cycle_state SET status=? WHERE mandate_id=? AND cycle=?").run(
      cycleStatus, plan.mandate_id, plan.cycle,
    );
  })();
}

function completeIntervention(db: Db, key: string, mandate: string, cycle: string, recovered: boolean) {
  db.transaction(() => {
    db.prepare("UPDATE audit_log SET status='completed', outcome=? WHERE idempotency_key=?").run(
      recovered ? "recovered" : "failed", key,
    );
    const st = db
      .prepare("SELECT interventions_used, status FROM cycle_state WHERE mandate_id=? AND cycle=?")
      .get(mandate, cycle) as CycleRow;
    const next = recovered
      ? "recovered"
      : st.interventions_used >= MAX_INTERVENTIONS_PER_CYCLE
        ? "exhausted"
        : "open";
    db.prepare("UPDATE cycle_state SET status=? WHERE mandate_id=? AND cycle=?").run(next, mandate, cycle);
  })();
}

// ---------- resume ----------

type PendingRow = {
  idempotency_key: string; mandate_id: string; cycle: string; source_attempt: string;
  action: string; scheduled_at: string;
};

/**
 * Finish anything that was mid-flight. The PSP ledger is authoritative, and
 * `fire` is idempotent, so this is simply "do the effect" again: if it already
 * happened the ledger returns the stored result, and if it did not, it happens
 * now. Correctness does not depend on knowing where the crash landed.
 */
function resumePending(db: Db, opts: AgentOptions): number {
  const rows = db.prepare("SELECT * FROM audit_log WHERE status='pending'").all() as PendingRow[];
  const byAttempt = new Map(opts.work.map((w) => [w.source_attempt, w]));
  for (const r of rows) {
    const item = byAttempt.get(r.source_attempt);
    if (item === undefined) throw new Error(`resume: unknown source attempt ${r.source_attempt}`);
    const plan: Plan = {
      idempotency_key: r.idempotency_key,
      mandate_id: r.mandate_id,
      cycle: r.cycle,
      attempt_no: 0,
      source_attempt: r.source_attempt,
      cause: item.cause,
      confidence: item.confidence,
      action: r.action as ActionName,
      decided_at: item.failed_at,
      scheduled_at: Date.parse(r.scheduled_at),
      notification_dispatch_at:
        r.action === "refire_notification_then_reschedule"
          ? Date.parse(r.scheduled_at) - (NOTIFY_MIN_LEAD_HOURS + 2) * HOUR_MS
          : item.notification_dispatch_at,
    };
    const res = execute(db, opts, item, plan as CheckedPlan);
    completeIntervention(db, r.idempotency_key, r.mandate_id, r.cycle, res.success);
  }
  return rows.length;
}

// ---------- the loop ----------

function processItem(db: Db, opts: AgentOptions, item: WorkItem, cycle: string, threshold: number): void {
  for (;;) {
    const st = cycleState(db, item.mandate_id, cycle);
    if (st.status !== "open") return;

    const attemptNo = st.interventions_used + 1;
    const revokedBefore = item.revoked_at !== null && item.revoked_at <= item.failed_at;
    const decision = decide(item, attemptNo, revokedBefore, threshold);
    const proposed = decision.action;
    // Schedule against the cause we ACTED on, not the argmax label, so the audit
    // trail and the timing agree with the decision that was actually made.
    const actedCause = decision.cause;
    const scheduled = EFFECTFUL.includes(proposed)
      ? scheduleFor(actedCause, Math.min(attemptNo, MAX_INTERVENTIONS_PER_CYCLE), item.failed_at)
      : null;
    // No legal slot left inside the horizon: a human takes it, rather than the
    // agent booking a retry it cannot honestly account for.
    const action = EFFECTFUL.includes(proposed) && scheduled === null ? "escalate_to_human" : proposed;

    const plan: Plan = {
      idempotency_key: `${item.mandate_id}:${cycle}:${attemptNo}`,
      mandate_id: item.mandate_id,
      cycle,
      attempt_no: attemptNo,
      source_attempt: item.source_attempt,
      cause: actedCause,
      confidence: item.confidence,
      action,
      decided_at: item.failed_at,
      scheduled_at: scheduled,
      notification_dispatch_at:
        action === "refire_notification_then_reschedule" && scheduled !== null
          ? scheduled - (NOTIFY_MIN_LEAD_HOURS + 2) * HOUR_MS
          : item.notification_dispatch_at,
    };

    const checks = checkConstraints(plan, {
      interventions_used: st.interventions_used,
      revoked_at: item.revoked_at,
    });

    if (!checks.ok || checks.plan === null) {
      const status = checks.failed.includes(CHECKS.MAX_INTERVENTIONS)
        ? "exhausted"
        : checks.failed.includes(CHECKS.NOT_CANCELLED)
          ? "stopped"
          : "escalated";
      recordTerminal(db, plan, checks, "blocked_by_constraint", status);
      return;
    }

    if (!EFFECTFUL.includes(action)) {
      recordTerminal(db, plan, checks, "not_applicable", action === "stop" ? "stopped" : "escalated");
      return;
    }

    recordIntent(db, plan, checks);
    checkpoint(); // crash here: intent committed, effect not yet attempted
    const res = execute(db, opts, item, checks.plan);
    checkpoint(); // crash here: effect committed, outcome not yet recorded
    completeIntervention(db, plan.idempotency_key, plan.mandate_id, cycle, res.success);
    checkpoint(); // crash here: everything committed
  }
}

export type AgentSummary = {
  audit_rows: number;
  psp_effects: number;
  resumed: number;
  by_action: Record<string, number>;
  by_outcome: Record<string, number>;
  by_cycle_status: Record<string, number>;
  recovered_amount: number;
};

export function runAgent(opts: AgentOptions): AgentSummary {
  const db = openDb(opts.dbPath);
  crashBudget = opts.crashAfter ?? null;
  try {
    const resumed = resumePending(db, opts);
    const work = [...opts.work].sort((a, b) => a.failed_at - b.failed_at);
    const threshold = opts.stopThreshold ?? stopThreshold(DEFAULT_COST_RATIO);
    for (const item of work) processItem(db, opts, item, cycleOf(item.failed_at), threshold);
    return summarise(db, opts, resumed);
  } finally {
    crashBudget = null;
    db.close();
  }
}

function tally(db: Db, sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare(sql).all() as { k: string | null; n: number }[]) out[r.k ?? "null"] = r.n;
  return out;
}

function summarise(db: Db, opts: AgentOptions, resumed: number): AgentSummary {
  const recovered = db
    .prepare("SELECT mandate_id FROM audit_log WHERE outcome='recovered'")
    .all() as { mandate_id: string }[];
  return {
    audit_rows: (db.prepare("SELECT COUNT(*) n FROM audit_log").get() as { n: number }).n,
    psp_effects: (db.prepare("SELECT COUNT(*) n FROM psp_ledger").get() as { n: number }).n,
    resumed,
    by_action: tally(db, "SELECT action k, COUNT(*) n FROM audit_log GROUP BY action"),
    by_outcome: tally(db, "SELECT outcome k, COUNT(*) n FROM audit_log GROUP BY outcome"),
    by_cycle_status: tally(db, "SELECT status k, COUNT(*) n FROM cycle_state GROUP BY status"),
    recovered_amount: recovered.reduce((a, r) => a + (opts.mandates.get(r.mandate_id)?.amount ?? 0), 0),
  };
}

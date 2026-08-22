import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { decide, runAgent, scheduleFor, HORIZON_END_MS } from "../src/agent/agent.ts";
import type { WorkItem } from "../src/agent/agent.ts";
import { CHECKS, checkConstraints, MAX_INTERVENTIONS_PER_CYCLE } from "../src/agent/constraints.ts";
import { stopThreshold } from "../src/decision.ts";
import type { Plan } from "../src/agent/constraints.ts";
import { NOTIFY_MIN_LEAD_HOURS } from "../src/config.ts";
import { isRestrictedTime } from "../src/schedule.ts";
import { HOUR_MS, istMs } from "../src/time.ts";
import { buildFixture } from "./fixture.ts";

const basePlan: Plan = {
  idempotency_key: "m:2026-01:1",
  mandate_id: "m",
  cycle: "2026-01",
  attempt_no: 1,
  source_attempt: "att_1",
  cause: "C3_BALANCE_SHORTFALL",
  confidence: 0.9,
  action: "reschedule",
  decided_at: istMs(2026, 0, 5, 9, 0),
  scheduled_at: istMs(2026, 0, 8, 14, 0),
  notification_dispatch_at: istMs(2026, 0, 5, 8, 0),
};
const okCtx = { interventions_used: 0, revoked_at: null };

test("a clean plan passes every applicable check", () => {
  const r = checkConstraints(basePlan, okCtx);
  assert.ok(r.ok);
  assert.ok(r.plan !== null);
  assert.deepEqual(r.failed, []);
  assert.equal(r.passed.length, 4);
});

test("constraint: max 3 interventions per mandate per cycle", () => {
  const r = checkConstraints(basePlan, { ...okCtx, interventions_used: MAX_INTERVENTIONS_PER_CYCLE });
  assert.equal(r.ok, false);
  assert.equal(r.plan, null);
  assert.ok(r.failed.includes(CHECKS.MAX_INTERVENTIONS));
});

test("constraint: never schedule inside the restricted window", () => {
  const r = checkConstraints({ ...basePlan, scheduled_at: istMs(2026, 0, 8, 11, 30) }, okCtx);
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes(CHECKS.NOT_RESTRICTED));
});

test("constraint: never schedule a debit within 24h of notification dispatch", () => {
  const scheduled = istMs(2026, 0, 8, 14, 0);
  const r = checkConstraints(
    { ...basePlan, scheduled_at: scheduled, notification_dispatch_at: scheduled - 23 * HOUR_MS },
    okCtx,
  );
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes(CHECKS.NOTIFY_LEAD));

  const edge = checkConstraints(
    { ...basePlan, scheduled_at: scheduled, notification_dispatch_at: scheduled - NOTIFY_MIN_LEAD_HOURS * HOUR_MS },
    okCtx,
  );
  assert.ok(edge.ok, "exactly 24h must be allowed");
});

test("constraint: never retry after a C4 determination or an explicit revoke", () => {
  const c4 = checkConstraints({ ...basePlan, cause: "C4_CANCELLATION" }, okCtx);
  assert.equal(c4.ok, false);
  assert.ok(c4.failed.includes(CHECKS.NOT_CANCELLED));

  const revoked = checkConstraints(basePlan, { ...okCtx, revoked_at: istMs(2026, 0, 6, 0, 0) });
  assert.equal(revoked.ok, false);
  assert.ok(revoked.failed.includes(CHECKS.NOT_CANCELLED));
});

test("checks are recorded as skipped, never silently passed", () => {
  // `stop` is subject to none of the four: two are effectful-only, two need a
  // scheduled time. The audit says "skipped" rather than "passed", so the log
  // never claims a check was satisfied when it simply did not apply.
  const stop = checkConstraints({ ...basePlan, action: "stop", scheduled_at: null }, okCtx);
  assert.equal(stop.skipped.length, 4);
  assert.deepEqual(stop.passed, []);
  assert.ok(stop.ok);

  // An effectful action still skips only the scheduling pair when it has no time.
  const noTime = checkConstraints({ ...basePlan, scheduled_at: null }, okCtx);
  assert.deepEqual(noTime.skipped.sort(), [CHECKS.NOT_RESTRICTED, CHECKS.NOTIFY_LEAD].sort());
  assert.deepEqual(noTime.passed.sort(), [CHECKS.MAX_INTERVENTIONS, CHECKS.NOT_CANCELLED].sort());
});

test("decide maps each cause to its matched action", () => {
  const item = (cause: WorkItem["cause"], routed = false, pC4 = 0.01): WorkItem => ({
    source_attempt: "a", mandate_id: "m", bank: "HDFC", failed_at: 0,
    notification_dispatch_at: 0, revoked_at: null, cause, confidence: 0.9,
    routed_to_exception_queue: routed,
    proba: {
      C1_EXECUTION_WINDOW: cause === "C1_EXECUTION_WINDOW" ? 0.9 : 0.02,
      C2_NOTIFICATION_FAIL: cause === "C2_NOTIFICATION_FAIL" ? 0.9 : 0.02,
      C3_BALANCE_SHORTFALL: cause === "C3_BALANCE_SHORTFALL" ? 0.9 : 0.02,
      C4_CANCELLATION: pC4,
    },
  });
  const act = (...args: Parameters<typeof decide>) => decide(...args).action;
  assert.equal(act(item("C1_EXECUTION_WINDOW"), 1, false), "reschedule");
  assert.equal(act(item("C2_NOTIFICATION_FAIL"), 1, false), "refire_notification_then_reschedule");
  assert.equal(act(item("C3_BALANCE_SHORTFALL"), 1, false), "reschedule");
  assert.equal(act(item("C3_BALANCE_SHORTFALL"), 1, true), "stop", "an explicit revoke stops everything");
  assert.equal(act(item("C3_BALANCE_SHORTFALL", true), 1, false), "escalate_to_human");
  assert.equal(act(item("C1_EXECUTION_WINDOW"), 4, false), "escalate_to_human");
});

test("stopping is cost-sensitive, not argmax", () => {
  const withC4 = (pC4: number): WorkItem => ({
    source_attempt: "a", mandate_id: "m", bank: "HDFC", failed_at: 0,
    notification_dispatch_at: 0, revoked_at: null, cause: "C4_CANCELLATION",
    confidence: pC4, routed_to_exception_queue: false,
    proba: {
      C1_EXECUTION_WINDOW: 0.01, C2_NOTIFICATION_FAIL: 0.01,
      C3_BALANCE_SHORTFALL: 1 - pC4 - 0.02, C4_CANCELLATION: pC4,
    },
  });
  const t = stopThreshold(20); // 0.952

  // C4 is the argmax at 0.60, but nowhere near confident enough to abandon the
  // money. The old argmax rule stopped here; this is the bug being fixed.
  const marginal = decide(withC4(0.6), 1, false, t);
  assert.equal(marginal.action, "reschedule");
  assert.equal(marginal.cause, "C3_BALANCE_SHORTFALL", "must act on the best RETRYABLE cause");

  assert.equal(decide(withC4(0.97), 1, false, t).action, "stop");
  assert.equal(decide(withC4(0.951), 1, false, t).action, "reschedule", "just below the line keeps trying");
  // A symmetric cost model reverts to argmax-like behaviour at 0.5.
  assert.equal(decide(withC4(0.6), 1, false, stopThreshold(1)).action, "stop");
});

test("the planner never proposes a time outside the horizon", () => {
  for (const cause of ["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL"] as const) {
    for (let n = 1; n <= MAX_INTERVENTIONS_PER_CYCLE; n++) {
      const late = scheduleFor(cause, n, HORIZON_END_MS - 2 * HOUR_MS);
      assert.equal(late, null, `${cause}/${n} scheduled past the horizon`);
    }
  }
});

// ---------- end-to-end: the audit log must be able to prove the constraints ----------

const dir = mkdtempSync(join(tmpdir(), "whydunit-agent-"));
const dbPath = join(dir, "agent.db");
const fixture = buildFixture();
const summary = await runAgent({ dbPath, ...fixture });
const db = new Database(dbPath, { readonly: true });
const audit = db.prepare("SELECT * FROM audit_log").all() as Record<string, string | number | null>[];

test("the run is substantial enough to test", () => {
  assert.ok(audit.length > 100, `only ${audit.length} audit rows`);
  assert.ok(summary.psp_effects > 60);
});

test("every audit record is complete", () => {
  for (const r of audit) {
    for (const field of ["idempotency_key", "decided_at", "mandate_id", "cycle", "attempt_no",
      "source_attempt", "action", "checks_passed", "checks_failed", "checks_skipped", "status", "outcome"]) {
      assert.notEqual(r[field], null, `${field} missing on ${r.idempotency_key}`);
    }
    assert.equal(r.status, "completed");
    const checks = [
      ...(JSON.parse(r.checks_passed as string) as string[]),
      ...(JSON.parse(r.checks_failed as string) as string[]),
      ...(JSON.parse(r.checks_skipped as string) as string[]),
    ];
    assert.equal(new Set(checks).size, 4, `${r.idempotency_key} did not account for all 4 checks`);
  }
});

test("no scheduled debit ever landed in the restricted window", () => {
  const scheduled = audit.filter((r) => r.scheduled_at !== null);
  assert.ok(scheduled.length > 50);
  for (const r of scheduled) {
    assert.equal(isRestrictedTime(Date.parse(r.scheduled_at as string)), false, r.idempotency_key as string);
  }
});

test("no scheduled debit ever sat under 24h from its notification", () => {
  for (const r of audit.filter((x) => x.scheduled_at !== null)) {
    const lead = (Date.parse(r.scheduled_at as string) - Date.parse(r.notification_at as string)) / HOUR_MS;
    assert.ok(lead >= NOTIFY_MIN_LEAD_HOURS, `${r.idempotency_key} lead ${lead.toFixed(1)}h`);
  }
});

test("no mandate exceeded its per-cycle intervention budget", () => {
  const used = db.prepare("SELECT mandate_id, cycle, interventions_used u FROM cycle_state")
    .all() as { mandate_id: string; cycle: string; u: number }[];
  assert.ok(used.length > 40);
  for (const r of used) assert.ok(r.u <= MAX_INTERVENTIONS_PER_CYCLE, `${r.mandate_id}/${r.cycle}=${r.u}`);

  const perKey = new Map<string, number>();
  for (const r of audit) {
    if (r.outcome === "blocked_by_constraint" || r.outcome === "not_applicable") continue;
    const k = `${r.mandate_id}:${r.cycle}`;
    perKey.set(k, (perKey.get(k) ?? 0) + 1);
  }
  for (const [k, n] of perKey) assert.ok(n <= MAX_INTERVENTIONS_PER_CYCLE, `${k} fired ${n} interventions`);
});

test("nothing effectful ever happened after a cancellation", () => {
  const revoked = new Map(
    fixture.work.filter((w) => w.revoked_at !== null).map((w) => [w.mandate_id, w.revoked_at!]),
  );
  let examinedOnRevokedMandates = 0;
  for (const r of audit) {
    if (r.scheduled_at === null) continue;
    // A vetoed plan still records the time it WOULD have used -- that is the
    // audit doing its job. Only plans that actually reached the PSP count here.
    if (r.outcome === "blocked_by_constraint") continue;
    assert.notEqual(r.cause, "C4_CANCELLATION", `${r.idempotency_key} scheduled a retry on a C4`);
    const rev = revoked.get(r.mandate_id as string);
    if (rev !== undefined) {
      examinedOnRevokedMandates++;
      assert.ok(Date.parse(r.scheduled_at as string) < rev, `${r.idempotency_key} fired after revoke`);
    }
  }
  // Non-vacuity, where the horizon makes it possible. At 90 days explicit churn is
  // rare enough that a 200-mandate fixture can contain none at all, so this is
  // conditional; the veto logic itself is covered unconditionally by the next test.
  if (revoked.size > 0) {
    assert.ok(examinedOnRevokedMandates > 0, "no effectful action was examined on a revoked mandate");
  }
});

// The veto itself is tested directly rather than via a rare fixture coincidence:
// since the revoke fix, a mandate's last attempt can precede its cancellation, so
// the agent does propose retries landing after it, and the constraint must refuse.
test("a retry scheduled past a revoke is vetoed", () => {
  const rev = istMs(2026, 0, 10, 0, 0);
  const r = checkConstraints(
    { ...basePlan, decided_at: istMs(2026, 0, 5, 9, 0), scheduled_at: istMs(2026, 0, 12, 14, 0) },
    { interventions_used: 0, revoked_at: rev },
  );
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes(CHECKS.NOT_CANCELLED));

  const before = checkConstraints(
    { ...basePlan, scheduled_at: istMs(2026, 0, 8, 14, 0) },
    { interventions_used: 0, revoked_at: rev },
  );
  assert.ok(before.ok, "a retry landing before the revoke is still allowed");
});

test("the PSP saw one effect per scheduled intervention, and no more", () => {
  const scheduled = audit.filter((r) => r.scheduled_at !== null && r.outcome !== "blocked_by_constraint");
  const ledger = db.prepare("SELECT idempotency_key FROM psp_ledger").all() as { idempotency_key: string }[];
  assert.equal(ledger.length, scheduled.length);
  assert.equal(new Set(ledger.map((l) => l.idempotency_key)).size, ledger.length);
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

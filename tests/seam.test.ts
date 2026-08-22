import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runAgent } from "../src/agent/agent.ts";
import { SimulatedPsp } from "../src/psp/simulated.ts";
import { CODE_MAP, UNMAPPED, evidenceFor } from "../src/psp/razorpay-codes.ts";
import { mapEvent, verifySignature } from "../src/psp/webhook.ts";
import { observationFromPayment } from "../src/psp/razorpay.ts";
import { FAILED, OK } from "../src/psp/types.ts";
import type { Observation, PspClient, Result } from "../src/psp/types.ts";
import { Whydunit } from "../src/whydunit.ts";
import { buildFixture } from "./fixture.ts";

/**
 * A second implementation that shares NO code with the simulator: it answers from
 * a fixed script. If the agent behaves identically against both, it demonstrably
 * does not know which one it holds.
 */
class ScriptedPsp implements PspClient {
  readonly name = "scripted";
  readonly calls: string[] = [];
  private readonly succeedOn: Set<string>;
  constructor(succeedOn: Set<string>) {
    this.succeedOn = succeedOn;
  }
  async fetchFailedDebits(): Promise<Observation[]> {
    return [];
  }
  async scheduleDebit(mandateId: string, at: Date, key: string): Promise<Result> {
    this.calls.push(`debit:${mandateId}@${at.toISOString()}`);
    return this.succeedOn.has(key) ? OK(key) : FAILED("payment_declined", "C3_BALANCE_SHORTFALL");
  }
  async sendPreDebitNotification(_m: string, key: string): Promise<Result> {
    this.calls.push(`notify:${_m}`);
    return OK(key);
  }
  async cancelMandate(_m: string, key: string): Promise<Result> {
    return OK(key);
  }
}

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "seam-")), "a.db");
}

function auditOf(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare("SELECT idempotency_key, action, cause, scheduled_at, checks_passed, checks_failed, status FROM audit_log ORDER BY idempotency_key")
    .all();
  db.close();
  return rows;
}

test("the same agent cycle runs against two unrelated PSP implementations", async () => {
  const fixture = buildFixture(31, 120);

  const simPath = tmpDb();
  const sim = await runAgent({ dbPath: simPath, work: fixture.work, psp: fixture.psp });

  // Every key the simulator settled as recovered, the script also succeeds on, so
  // the two runs should agree on every decision AND every outcome.
  const dbSim = new Database(simPath, { readonly: true });
  const recovered = new Set(
    (dbSim.prepare("SELECT idempotency_key FROM psp_ledger WHERE result='recovered'").all() as
      { idempotency_key: string }[]).map((r) => r.idempotency_key),
  );
  dbSim.close();

  const scripted = new ScriptedPsp(recovered);
  const scriptPath = tmpDb();
  const scr = await runAgent({ dbPath: scriptPath, work: fixture.work, psp: scripted });

  assert.ok(sim.audit_rows > 50, `fixture too small: ${sim.audit_rows} rows`);
  assert.equal(scr.audit_rows, sim.audit_rows);
  assert.equal(scr.psp_effects, sim.psp_effects);
  assert.deepEqual(scr.by_action, sim.by_action);
  assert.deepEqual(scr.by_outcome, sim.by_outcome);
  assert.deepEqual(scr.by_cycle_status, sim.by_cycle_status);
  // The strongest form: the audit trails are identical row for row.
  assert.deepEqual(auditOf(scriptPath), auditOf(simPath));
  assert.ok(scripted.calls.length > 0, "the scripted PSP was never actually called");

  rmSync(simPath, { force: true });
  rmSync(scriptPath, { force: true });
});

test("constraints still bind against a PSP that would accept anything", async () => {
  // A PSP that succeeds on everything must not be able to talk the agent past its
  // own limits: the constraints live in the agent, not in the implementation.
  const fixture = buildFixture(31, 120);
  const yesMan = new ScriptedPsp(new Set());
  const dbPath = tmpDb();
  await runAgent({ dbPath, work: fixture.work, psp: yesMan });
  const db = new Database(dbPath, { readonly: true });
  const used = db.prepare("SELECT MAX(interventions_used) m FROM cycle_state").get() as { m: number };
  db.close();
  assert.ok(used.m <= 3, `budget breached against a permissive PSP: ${used.m}`);
  rmSync(dbPath, { force: true });
});

test("attribute / plan / execute each work standalone", async () => {
  const psp = new SimulatedPsp({ seed: 7, mandates: 60 });
  const w = new Whydunit({ psp, costRatio: 40, maxInterventions: 3 });
  const observations = await psp.fetchFailedDebits(new Date(0));
  assert.ok(observations.length > 10, `only ${observations.length} failures`);

  // attribution alone: no PSP calls, no execution
  const attributions = await w.attribute(observations);
  assert.equal(attributions.length, observations.length);
  for (const a of attributions) {
    assert.ok(a.confidence > 0 && a.confidence <= 1);
    assert.equal(Object.keys(a.probabilities).length, 4);
  }

  // planning alone: still no side effects
  const plan = await w.plan(attributions);
  assert.equal(plan.length, attributions.length);
  assert.ok(plan.every((p) => ["reschedule", "refire_notification_then_reschedule", "stop"].includes(p.action)));

  const result = await w.execute(plan, observations);
  assert.ok(result.audit_rows > 0);
  assert.ok(result.psp_effects <= result.audit_rows);
});

test("cost ratio changes the stop threshold, and the default rule never stops alone", async () => {
  const psp = new SimulatedPsp({ seed: 7, mandates: 60 });
  const observations = await psp.fetchFailedDebits(new Date(0));
  // The rule caps itself at 0.90, below any sane threshold, so a rule-only
  // deployment can never abandon a mandate on its own say-so.
  for (const ratio of [5, 20, 40]) {
    const w = new Whydunit({ psp, costRatio: ratio });
    const plan = await w.plan(await w.attribute(observations));
    assert.equal(plan.filter((p) => p.stop).length, 0, `rule scorer stopped at ratio ${ratio}`);
  }
});

test("webhook signatures are verified over the raw body", () => {
  const secret = "whsec_test";
  const raw = Buffer.from(JSON.stringify({ event: "subscription.cancelled", payload: {} }));
  const good = createHmac("sha256", secret).update(raw).digest("hex");
  assert.ok(verifySignature(raw, good, secret));
  assert.ok(!verifySignature(raw, good, "wrong_secret"));
  assert.ok(!verifySignature(Buffer.from(raw.toString() + " "), good, secret), "tampered body must fail");
  assert.ok(!verifySignature(raw, "deadbeef", secret));
});

test("razorpay events map to our types, and cancellation has no decline code", () => {
  const cancelled = mapEvent({ event: "subscription.cancelled", payload: {} });
  assert.equal(cancelled.lifecycle, "mandate.revoked");
  assert.equal(cancelled.observation, null);

  const charged = mapEvent({
    event: "payment.failed",
    payload: { payment: { entity: {
      id: "pay_1", amount: 49900, created_at: 1770000000, status: "failed",
      error_reason: "insufficient_funds", bank: "HDFC",
    } } },
  });
  assert.equal(charged.observation?.error_code, "insufficient_funds");
  assert.equal(charged.observation?.amount, 499);
  assert.equal(charged.observation?.success, false);
  assert.equal(charged.observation?.notification.receipt, null, "bank-side delivery is unobservable");
});

test("the code map claims only what Razorpay documents", () => {
  assert.equal(evidenceFor("insufficient_funds"), "C3_BALANCE_SHORTFALL");
  assert.equal(evidenceFor("payment_declined"), null, "generic declines must stay ambiguous");
  assert.equal(evidenceFor("some_code_we_invented"), null);
  assert.equal(evidenceFor(null), null);

  // The gap list is load-bearing documentation: C1 and C2 have no reachable code.
  const needs = UNMAPPED.map((u) => u.need).join(" ");
  assert.ok(needs.includes("mandate revoked"));
  assert.ok(needs.includes("pre-debit notification"));
  assert.ok(needs.includes("restricted window"));
  assert.ok(Object.values(CODE_MAP).filter((v) => v.evidence_for !== null).length <= 2,
    "at most two Razorpay codes are real evidence for one of our causes");
});

test("a razorpay payment with no bank does not invent one", () => {
  const o = observationFromPayment(
    { id: "pay_2", amount: 19900, created_at: 1770000000, status: "failed" },
    new Map(),
  );
  assert.equal(o.bank, "UNKNOWN");
  assert.equal(o.error_code, null);
  assert.deepEqual(o.prior_attempts, []);
});

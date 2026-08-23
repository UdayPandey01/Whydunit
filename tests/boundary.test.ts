import test from "node:test";
import assert from "node:assert/strict";
import { HIDDEN_KEYS, observe } from "../src/observe.ts";
import { generateWorld } from "../src/world/generate.ts";

function keyNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keyNames(v, into);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keyNames(v, into);
    }
  }
  return into;
}

const EXPECTED_KEYS = new Set([
  "attempt_id", "mandate_id", "timestamp", "bank", "amount", "max_amount",
  "frequency", "mandate_age_days", "attempt_index", "success", "error_code",
  "notification", "dispatched_at", "hours_before_debit", "receipt",
  "prior_attempts", "lifecycle_events", "type",
]);

const world = generateWorld({ seed: 7, mandates: 400 });
const observations = observe(world, 99);

test("the walker actually finds ground truth when it is there (positive control)", () => {
  const worldKeys = keyNames(JSON.parse(JSON.stringify(world)));
  for (const hidden of ["cause", "blockers", "multi_cause", "balance_at_attempt"]) {
    assert.ok(worldKeys.has(hidden), `world.jsonl should contain ${hidden}`);
  }
});

test("no observation record contains any hidden key", () => {
  for (const o of observations) {
    const keys = keyNames(JSON.parse(JSON.stringify(o)));
    for (const hidden of HIDDEN_KEYS) {
      assert.ok(!keys.has(hidden), `leaked hidden key ${hidden} in ${o.attempt_id}`);
    }
  }
});

test("observation keys are exactly the allowlist, nothing more", () => {
  const seen = keyNames(JSON.parse(JSON.stringify(observations)));
  assert.deepEqual(
    [...seen].sort(),
    [...EXPECTED_KEYS].sort(),
    "observation key set drifted from the declared merchant-visible set",
  );
});

test("no cause label appears anywhere in the serialized observations", () => {
  const text = observations.map((o) => JSON.stringify(o)).join("\n");
  for (const label of [
    "C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL",
    "C3_BALANCE_SHORTFALL", "C4_CANCELLATION",
  ]) {
    assert.ok(!text.includes(label), `label ${label} leaked as a value`);
  }
});

test("silent churn is invisible: revoked events only ever come from emitters", () => {
  const emitters = new Set(
    world.filter((w) => w.world.churn_emits_event).map((w) => w.mandate_id),
  );
  const visible = observations.filter((o) => o.lifecycle_events.length > 0);
  for (const o of visible) assert.ok(emitters.has(o.mandate_id));

  const silent = new Set(
    world
      .filter((w) => w.world.churned_at !== null && !w.world.churn_emits_event)
      .map((w) => w.mandate_id),
  );
  assert.ok(silent.size > 0, "fixture should contain silent churn to be meaningful");
  const visibleMandates = new Set(visible.map((o) => o.mandate_id));
  for (const m of silent) assert.ok(!visibleMandates.has(m), `silent churn ${m} became visible`);
});

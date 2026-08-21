import test from "node:test";
import assert from "node:assert/strict";
import { generateWorld } from "../src/world/generate.ts";
import type { Cause } from "../src/world/types.ts";

const world = generateWorld();
const fails = world.filter((w) => !w.success);
const share = (n: number) => n / fails.length;

const byCause = new Map<Cause, number>();
for (const f of fails) byCause.set(f.cause!, (byCause.get(f.cause!) ?? 0) + 1);

test("run size lands near the 2000-mandate / 90-day target", () => {
  assert.ok(world.length > 5000 && world.length < 6500, `attempts=${world.length}`);
});

test("failure rate sits in the 15-25% band", () => {
  const rate = fails.length / world.length;
  assert.ok(rate >= 0.15 && rate <= 0.25, `failure rate=${rate.toFixed(3)}`);
});

test("all four classes are present and the mix stays imbalanced", () => {
  for (const c of [
    "C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL",
    "C3_BALANCE_SHORTFALL", "C4_CANCELLATION",
  ] as Cause[]) {
    assert.ok((byCause.get(c) ?? 0) > 20, `${c} too rare to learn: ${byCause.get(c)}`);
  }
  const shares = [...byCause.values()].map(share);
  const max = Math.max(...shares);
  const min = Math.min(...shares);
  // Real base rates are skewed; a near-uniform mix would mean we normalised them.
  assert.ok(max > 0.4, `largest class only ${max.toFixed(2)} -- distribution looks normalised`);
  assert.ok(min < 0.2, `smallest class ${min.toFixed(2)} -- distribution looks normalised`);
  assert.equal(
    [...byCause].sort((a, b) => b[1] - a[1])[0]![0],
    "C3_BALANCE_SHORTFALL",
    "balance shortfall should dominate, as it does in reality",
  );
});

test("roughly 5% of failures are multi-cause", () => {
  const multi = share(fails.filter((f) => f.multi_cause).length);
  assert.ok(multi >= 0.03 && multi <= 0.10, `multi-cause=${multi.toFixed(3)}`);
  for (const f of fails) {
    assert.equal(f.multi_cause, f.blockers.length > 1);
    assert.equal(f.cause, f.blockers[0]);
  }
});

test("successes have no blockers and no decline code", () => {
  for (const w of world.filter((x) => x.success)) {
    assert.equal(w.blockers.length, 0);
    assert.equal(w.error_code, null);
    assert.equal(w.cause, null);
  }
});

// The one place cause information reaches an observable. If any code became a
// near-perfect predictor the classifier would be a lookup table and the whole
// premise of the project would be void.
test("no decline code is a lookup table for its cause", () => {
  const byCode = new Map<string, Map<string, number>>();
  for (const f of fails) {
    const m = byCode.get(f.error_code!) ?? new Map<string, number>();
    m.set(f.cause!, (m.get(f.cause!) ?? 0) + 1);
    byCode.set(f.error_code!, m);
  }
  assert.ok(byCode.size >= 4, "need several codes in circulation");
  for (const [code, m] of byCode) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const top = Math.max(...m.values());
    assert.ok(top / total < 0.95, `code ${code} is ${(100 * top / total).toFixed(0)}% pure`);
    assert.ok(m.size >= 2, `code ${code} only ever appears for one cause`);
  }
});

test("each class carries its declared invariance signature", () => {
  const c1 = fails.filter((f) => f.cause === "C1_EXECUTION_WINDOW");
  for (const f of c1) assert.ok(f.world.restricted_window, "C1 must be inside the window");

  const c3 = fails.filter((f) => f.cause === "C3_BALANCE_SHORTFALL");
  for (const f of c3) assert.ok(f.amount > f.world.balance_at_attempt, "C3 must be short");
  // C3 varies with day-of-month: it should cluster later in the salary cycle.
  const lateShare = c3.filter((f) => f.world.days_since_salary > 14).length / c3.length;
  assert.ok(lateShare > 0.5, `C3 not concentrated late in the cycle: ${lateShare.toFixed(2)}`);

  // C4 is invariant to everything: once it fires nothing later ever succeeds.
  const churnedMandates = new Set(
    world.filter((w) => w.world.churned_at !== null).map((w) => w.mandate_id),
  );
  for (const w of world) {
    if (!churnedMandates.has(w.mandate_id)) continue;
    const churnedAt = w.world.churned_at === null ? null : Date.parse(w.world.churned_at);
    if (churnedAt !== null && w.timestamp_ms >= churnedAt) {
      assert.equal(w.success, false, `${w.attempt_id} succeeded after cancellation`);
    }
  }
});

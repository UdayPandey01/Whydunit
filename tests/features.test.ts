import test from "node:test";
import assert from "node:assert/strict";
import { computeFeatures } from "../src/features.ts";
import { observe } from "../src/observe.ts";
import { assignSplits, HOLDOUT_BANKS, TIME_SPLIT_DAY } from "../src/splits.ts";
import { generateWorld } from "../src/world/generate.ts";

const world = generateWorld({ seed: 21, mandates: 700 });
const observations = observe(world, 22);
const rows = computeFeatures(observations);

test("rows are failed attempts only, and every one of them", () => {
  const failed = observations.filter((o) => !o.success);
  assert.equal(rows.length, failed.length);
  assert.ok(rows.length > 100, `too few rows to test: ${rows.length}`);
  assert.deepEqual(
    new Set(rows.map((r) => r.attempt_id)),
    new Set(failed.map((o) => o.attempt_id)),
  );
});

test("no feature row carries a label or an identity field in the matrix", () => {
  const banned = ["label", "cause", "blockers", "multi_cause", "mandate_id", "bank", "attempt_id", "customer_id"];
  for (const r of rows) {
    for (const k of Object.keys(r.features)) {
      assert.ok(!banned.includes(k), `feature matrix contains ${k}`);
    }
  }
});

test("every feature value is numeric or null", () => {
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.features)) {
      assert.ok(v === null || (typeof v === "number" && Number.isFinite(v)), `${k}=${v}`);
    }
  }
});

test("features are strictly point-in-time", () => {
  const all = [...observations].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const cutIdx = Math.floor(all.length * 0.6);
  const cutMs = Date.parse(all[cutIdx]!.timestamp);
  const truncated = all.filter((o) => Date.parse(o.timestamp) < cutMs);

  const full = new Map(computeFeatures(observations).map((r) => [r.attempt_id, r.features]));
  const partial = computeFeatures(truncated);
  assert.ok(partial.length > 50, "truncated set too small to be meaningful");

  for (const r of partial) {
    assert.deepEqual(
      r.features,
      full.get(r.attempt_id),
      `${r.attempt_id} changed when later attempts were removed -- look-ahead leak`,
    );
  }
});

test("a revoke webhook arriving after the attempt stays invisible", () => {
  const late = observations.filter((o) => {
    const e = o.lifecycle_events[0];
    return e !== undefined && Date.parse(e.timestamp) > Date.parse(o.timestamp) && !o.success;
  });
  assert.ok(late.length > 0, "fixture needs post-attempt revokes to be meaningful");
  const byId = new Map(rows.map((r) => [r.attempt_id, r.features]));
  for (const o of late) {
    assert.equal(byId.get(o.attempt_id)!.revoked_before_attempt, 0, o.attempt_id);
    assert.equal(byId.get(o.attempt_id)!.hours_since_revoke, null, o.attempt_id);
  }
});

test("splits are deterministic, disjoint and non-degenerate", () => {
  const a = rows.map((r) => assignSplits(r));
  const b = rows.map((r) => assignSplits(r));
  assert.deepEqual(a, b);

  const byMandate = new Map<string, Set<string>>();
  rows.forEach((r, i) => {
    const s = byMandate.get(r.mandate_id) ?? new Set<string>();
    s.add(a[i]!.mandate);
    byMandate.set(r.mandate_id, s);
  });
  for (const [m, sides] of byMandate) assert.equal(sides.size, 1, `mandate ${m} spans both sides`);

  rows.forEach((r, i) => {
    assert.equal(a[i]!.bank, HOLDOUT_BANKS.includes(r.bank) ? "test" : "train");
    assert.equal(a[i]!.time, r.day_index < TIME_SPLIT_DAY ? "train" : "test");
  });

  for (const scheme of ["mandate", "bank", "time"] as const) {
    const test_n = a.filter((s) => s[scheme] === "test").length;
    assert.ok(test_n > 50 && test_n < rows.length - 50, `${scheme} split degenerate: ${test_n}`);
  }
});

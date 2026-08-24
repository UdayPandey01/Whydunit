import test from 'node:test';
import assert from 'node:assert/strict';
import { COST_RETRY_RUPEES } from '../src/config.ts';
import {
  decideCause,
  retryBudgetFor,
  stopThreshold,
  stopThresholdFor,
} from '../src/decision.ts';
import type { Cause } from '../src/world/types.ts';

const proba = (pC4: number): Record<Cause, number> => ({
  C1_EXECUTION_WINDOW: 0.01,
  C2_NOTIFICATION_FAIL: 0.01,
  C3_BALANCE_SHORTFALL: Math.max(0, 1 - pC4 - 0.02),
  C4_CANCELLATION: pC4,
});

test('the amount-aware threshold scales with what a wrongful stop forfeits', () => {
  assert.ok(stopThresholdFor(149) < stopThresholdFor(999));
  assert.ok(stopThresholdFor(999) < stopThresholdFor(4999));
  assert.ok(stopThresholdFor(4999) < 1);

  const r = COST_RETRY_RUPEES;
  assert.ok(Math.abs(stopThresholdFor(20 * r, r) - stopThreshold(20)) < 1e-12);

  assert.equal(stopThresholdFor(0), 1);
  assert.equal(stopThresholdFor(-5), 1);
});

test('a small mandate is abandoned at a belief that would keep a large one alive', () => {
  const belief = 0.9;
  assert.equal(
    decideCause(proba(belief), stopThresholdFor(149)).stop,
    true,
    '₹149 should be let go',
  );
  assert.equal(
    decideCause(proba(belief), stopThresholdFor(4999)).stop,
    false,
    '₹4,999 should be fought for',
  );

  const flat = stopThreshold();
  assert.equal(
    decideCause(proba(belief), flat).stop,
    decideCause(proba(belief), flat).stop,
  );
});

test('amount-weighting is inert against a predictor with degenerate probabilities', () => {
  const certain: Record<Cause, number> = {
    C1_EXECUTION_WINDOW: 0,
    C2_NOTIFICATION_FAIL: 0,
    C3_BALANCE_SHORTFALL: 0,
    C4_CANCELLATION: 1,
  };

  for (const v of [149, 499, 4999]) {
    assert.equal(decideCause(certain, stopThresholdFor(v)).stop, true);
  }
  assert.equal(decideCause(certain, stopThreshold()).stop, true);

  assert.notEqual(
    decideCause(proba(0.9), stopThresholdFor(149)).stop,
    decideCause(proba(0.9), stopThresholdFor(4999)).stop,
  );
});

test('retry budget is bounded by expected return, and by the cycle limit', () => {
  assert.equal(retryBudgetFor(149, 3, 33, 0.33), 1);
  assert.equal(retryBudgetFor(299, 3, 33, 0.33), 2);
  assert.equal(
    retryBudgetFor(4999, 3, 33, 0.33),
    3,
    'never exceeds the per-cycle cap',
  );
  assert.equal(retryBudgetFor(10, 3, 33, 0.33), 0, 'not worth a single retry');

  assert.ok(retryBudgetFor(149, 3, 5, 0.33) > retryBudgetFor(149, 3, 80, 0.33));
});

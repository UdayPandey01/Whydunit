import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AMBIGUITY_MARGIN,
  indicators,
  MIN_BANK_TRAIN_ROWS,
  routeException,
} from '../src/exceptions.ts';
import type { Support } from '../src/exceptions.ts';
import type { FeatureRow } from '../src/features.ts';
import type { Cause } from '../src/world/types.ts';

const SUPPORT: Support = {
  banks: ['HDFC', 'ICICI'],
  bank_train_counts: { HDFC: 300, ICICI: 200 },
  feature_range: {
    hour: [0, 23],
    amount: [149, 4999],
    mandate_prior_n: [0, 2],
  },
};

function row(
  features: Record<string, number | null>,
  bank = 'HDFC',
): FeatureRow {
  return {
    attempt_id: 'att_1',
    mandate_id: 'mdt_1',
    bank,
    day_index: 5,
    timestamp: '2026-01-06T14:00:00+05:30',
    features: {
      mandate_prior_n: 2,
      in_restricted_window: 0,
      receipt_delivered: 1,
      notify_lead_under_24: 0,
      revoked_before_attempt: 0,
      code_Z9: 0,
      hour: 14,
      amount: 499,
      receipt_missing: 0,
      bank_burst_z: 0,
      day_of_month: 6,
      all_prior_failed: 0,
      consecutive_prior_failures: 0,
      prior_distinct_fail_hours: 0,
      hours_since_revoke: null,
      notify_lead_hours: 40,
      ...features,
    },
  };
}
const CONFIDENT: Record<Cause, number> = {
  C1_EXECUTION_WINDOW: 0.05,
  C2_NOTIFICATION_FAIL: 0.05,
  C3_BALANCE_SHORTFALL: 0.85,
  C4_CANCELLATION: 0.05,
};

test('a well-supported, unambiguous attempt is not routed', () => {
  assert.equal(routeException(row({}), CONFIDENT, SUPPORT, 499), null);
});

test('rule: thin history routes ONLY when no single observable settles it', () => {
  const decisive = routeException(
    row({ mandate_prior_n: 0, in_restricted_window: 1, hour: 11 }),
    CONFIDENT,
    SUPPORT,
    499,
  );
  assert.equal(
    decisive,
    null,
    'a decisive observable should override thin history',
  );

  const thin = routeException(
    row({ mandate_prior_n: 0 }),
    CONFIDENT,
    SUPPORT,
    499,
  );
  assert.ok(thin !== null);
  assert.ok(thin.reasons.includes('insufficient_history'));
});

test('rule: top-two probabilities within the margin', () => {
  const close: Record<Cause, number> = {
    C1_EXECUTION_WINDOW: 0.02,
    C2_NOTIFICATION_FAIL: 0.02,
    C3_BALANCE_SHORTFALL: 0.49,
    C4_CANCELLATION: 0.47,
  };
  const r = routeException(row({}), close, SUPPORT, 499);
  assert.ok(r !== null);
  assert.ok(r.reasons.includes('ambiguous_top_two'));
  assert.ok(0.49 - 0.47 < AMBIGUITY_MARGIN);
  assert.equal(r.hypotheses[0]!.cause, 'C3_BALANCE_SHORTFALL');
  assert.equal(r.hypotheses[1]!.cause, 'C4_CANCELLATION');
  assert.ok(
    r.resolving_evidence.some((e) => e.includes('rules out cancellation')),
    'a C3-vs-C4 contest must say what would rule out cancellation',
  );
});

test('rule: multi-cause conflict, detected from observables only', () => {
  const r = routeException(
    row({ in_restricted_window: 1, hour: 11, receipt_delivered: 0 }),
    CONFIDENT,
    SUPPORT,
    499,
  );
  assert.ok(r !== null);
  assert.ok(r.reasons.includes('multi_cause_conflict'));
  assert.ok(
    r.detail.some(
      (d) => d.includes('execution window') && d.includes('notification'),
    ),
  );
});

test('rule: bank outside training support', () => {
  const unseen = routeException(row({}, 'SBI'), CONFIDENT, SUPPORT, 499);
  assert.ok(unseen !== null);
  assert.ok(unseen.reasons.includes('outside_training_support'));
  assert.ok(unseen.detail.some((d) => d.includes('never seen in training')));

  const thin: Support = {
    ...SUPPORT,
    bank_train_counts: { HDFC: MIN_BANK_TRAIN_ROWS - 1, ICICI: 200 },
  };
  const under = routeException(row({}), CONFIDENT, thin, 499);
  assert.ok(under !== null);
  assert.ok(under.reasons.includes('outside_training_support'));
});

test('every exception carries reason, competing hypotheses and resolving evidence', () => {
  const r = routeException(
    row({ mandate_prior_n: 0 }),
    CONFIDENT,
    SUPPORT,
    499,
  );
  assert.ok(r !== null);
  assert.ok(r.reasons.length > 0);
  assert.ok(r.detail.length > 0);
  assert.ok(
    r.hypotheses.length >= 2,
    'an exception needs competing hypotheses, not one',
  );
  assert.ok(r.resolving_evidence.length > 0);
  for (const h of r.hypotheses)
    assert.ok(h.evidence.length > 0, `${h.cause} has no evidence line`);
});

test('the observable multi-cause detector never reaches for world state', () => {
  const f = row({ in_restricted_window: 1, hour: 11 }).features;
  const before = JSON.stringify(indicators(f));
  const after = JSON.stringify(
    indicators({ ...f, multi_cause: 1, cause: 1, balance_at_attempt: 0 }),
  );
  assert.equal(before, after);

  const src = readFileSync(
    new URL('../src/exceptions.ts', import.meta.url),
    'utf8',
  );
  for (const banned of [
    'multi_cause',
    'balance_at_attempt',
    'churned_at',
    'notification_delivered_by_bank',
  ]) {
    assert.ok(
      !src.includes(`.${banned}`),
      `exceptions.ts reads hidden world field ${banned}`,
    );
  }
});

test('no exception record leaks the ground-truth label', () => {
  const r = routeException(
    row({ mandate_prior_n: 0 }),
    CONFIDENT,
    SUPPORT,
    499,
  )!;
  const keys = Object.keys(r);
  for (const banned of [
    'label',
    'actual',
    'cause',
    'multi_cause',
    'blockers',
  ]) {
    assert.ok(!keys.includes(banned), `exception record contains ${banned}`);
  }
});

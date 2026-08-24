import test from 'node:test';
import assert from 'node:assert/strict';
import { observe } from '../src/observe.ts';
import { generateWorld } from '../src/world/generate.ts';

const jsonl = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('same seed produces byte-identical world and observations at full size', () => {
  const a = generateWorld();
  const b = generateWorld();
  assert.equal(jsonl(a), jsonl(b));
  assert.equal(jsonl(observe(a)), jsonl(observe(b)));
});

test('a different seed produces different output', () => {
  const a = generateWorld({ seed: 1, mandates: 200 });
  const b = generateWorld({ seed: 2, mandates: 200 });
  assert.notEqual(jsonl(a), jsonl(b));
});

test('changing the observation seed leaves the world untouched', () => {
  const world = generateWorld({ seed: 5, mandates: 200 });
  const before = jsonl(world);
  const o1 = observe(world, 11);
  const o2 = observe(world, 12);
  assert.equal(jsonl(world), before);
  assert.notEqual(jsonl(o1), jsonl(o2));
  assert.deepEqual(
    o1.map((o) => o.attempt_id),
    o2.map((o) => o.attempt_id),
  );
});

test('output is independent of the host timezone', () => {
  const original = process.env.TZ;
  process.env.TZ = 'UTC';
  const a = jsonl(generateWorld({ seed: 3, mandates: 150 }));
  process.env.TZ = 'America/Los_Angeles';
  const b = jsonl(generateWorld({ seed: 3, mandates: 150 }));
  process.env.TZ = original;
  assert.equal(a, b);
});

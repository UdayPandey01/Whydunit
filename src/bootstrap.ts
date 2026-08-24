import { makeRng } from './rng.ts';

export function clusterBootstrapCI<T>(
  items: T[],
  groupOf: (item: T) => string,
  metric: (rows: T[]) => number,
  n = 1000,
  seed = 4242,
): [number, number] {
  const byGroup = new Map<string, T[]>();
  for (const it of items) {
    const arr = byGroup.get(groupOf(it)) ?? [];
    arr.push(it);
    byGroup.set(groupOf(it), arr);
  }
  const keys = [...byGroup.keys()];
  const rng = makeRng(seed);
  const draws: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample: T[] = [];
    for (let j = 0; j < keys.length; j++)
      sample.push(...byGroup.get(keys[Math.floor(rng() * keys.length)]!)!);
    draws.push(metric(sample));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * n)]!, draws[Math.floor(0.975 * n)]!];
}

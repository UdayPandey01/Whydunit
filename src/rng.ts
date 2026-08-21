export type Rng = () => number;

// mulberry32. Chosen over a dependency because a seeded stream is a primitive
// here, not an abstraction: every world process draws from the same one and
// byte-identical reproduction is a hard requirement.
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function bernoulli(rng: Rng, p: number): boolean {
  return rng() < p;
}

export function normal(rng: Rng, mu: number, sigma: number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function lognormal(rng: Rng, median: number, sigma: number): number {
  return median * Math.exp(normal(rng, 0, sigma));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// Insertion order of string keys is stable in JS, so the same weights table
// always consumes the stream the same way.
export function weighted<K extends string>(rng: Rng, weights: Record<K, number>): K {
  const keys = Object.keys(weights) as K[];
  let total = 0;
  for (const k of keys) total += weights[k];
  let r = rng() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1]!;
}

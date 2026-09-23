// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
// Game state stores the RNG cursor so every roll is reproducible from a save.

export interface Rng {
  /** Float in [0, 1). */
  next: () => number;
  /** Integer in [1, sides]. */
  die: (sides: number) => number;
  /** Integer in [min, max]. */
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  /** Current internal cursor — persist this back into state after use. */
  state: () => number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    die: (sides) => Math.floor(next() * sides) + 1,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    state: () => s,
  };
}

export interface DicePool {
  count: number;
  sides: number;
  bonus: number;
}

export function rollPool(rng: Rng, pool: DicePool): number {
  let total = pool.bonus;
  for (let i = 0; i < pool.count; i++) total += rng.die(pool.sides);
  return total;
}

export function poolAverage(pool: DicePool): number {
  return pool.count * ((pool.sides + 1) / 2) + pool.bonus;
}

export function poolLabel(pool: DicePool): string {
  const bonus = pool.bonus > 0 ? `+${pool.bonus}` : pool.bonus < 0 ? `${pool.bonus}` : '';
  return `${pool.count}d${pool.sides}${bonus}`;
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

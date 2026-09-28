// ── Running micro battles: single run, series, and baseline-vs-candidate ─────

import type { GameState } from '../types.ts';
import type { RulesOverride } from '../rules.ts';
import { mergeRules } from '../rules.ts';
import type { BattleResult, BattleRuleset } from './ruleset.ts';
import { ironRidgeRuleset } from './ruleset.ts';
import type { BattleSpec, ExpectedWinner, SpecExpect } from './spec.ts';
import { DEFAULT_TOLERANCE } from './spec.ts';

export interface RunOptions {
  /** Extra overrides layered on top of `spec.rules` (candidate rules). */
  rules?: RulesOverride;
  /** Safety cap on AI actions (default 20 000). Hitting it = draw ("step limit"). */
  maxSteps?: number;
  ruleset?: BattleRuleset<BattleSpec, GameState, BattleResult>;
}

function withExtraRules(spec: BattleSpec, rules: RulesOverride | undefined): BattleSpec {
  return rules ? { ...spec, rules: mergeRules(spec.rules, rules) } : spec;
}

/** One AI-vs-AI battle. Fully deterministic for a given (spec, seed, rules). */
export function runBattle(spec: BattleSpec, seed: number, opts: RunOptions = {}): BattleResult {
  const rs = opts.ruleset ?? ironRidgeRuleset;
  const s0 = withExtraRules(spec, opts.rules);
  const { grid } = rs.sizeGrid(s0);
  let state = rs.createBattle(s0, grid, seed);
  const cap = opts.maxSteps ?? 20000;
  for (let i = 0; i < cap && !rs.isOver(state); i++) state = rs.step(state);
  return rs.result(state);
}

export interface SeriesResult {
  name: string;
  runs: number;
  attackerWinPct: number;
  defenderWinPct: number;
  drawPct: number;
  avgRounds: number;
  /** attackerWinPct − defenderWinPct. */
  margin: number;
  /** Undefined when the spec has no `expect`. */
  pass?: boolean;
  expect?: SpecExpect;
  /** Wall-clock milliseconds for the whole series. */
  ms: number;
}

/**
 * Pass rule — one metric, margin = attacker win % − defender win %:
 *   'even'     passes when |margin| ≤ tolerance
 *   'attacker' passes when  margin  ≥ tolerance
 *   'defender' passes when −margin  ≥ tolerance
 * (tolerance defaults to 15 points; with no draws, 'attacker' ⇔ win% ≥ 57.5).
 */
export function seriesPasses(margin: number, expect: SpecExpect): boolean {
  const tol = expect.tolerance ?? DEFAULT_TOLERANCE;
  if (expect.winner === 'even') return Math.abs(margin) <= tol;
  if (expect.winner === 'attacker') return margin >= tol;
  return -margin >= tol;
}

/** Target band for attacker win % implied by `expect` (assuming no draws). */
export function expectBand(expect: SpecExpect): { lo: number; hi: number; winner: ExpectedWinner } {
  const half = (expect.tolerance ?? DEFAULT_TOLERANCE) / 2;
  if (expect.winner === 'even') return { lo: 50 - half, hi: 50 + half, winner: 'even' };
  if (expect.winner === 'attacker') return { lo: 50 + half, hi: 100, winner: 'attacker' };
  return { lo: 0, hi: 50 - half, winner: 'defender' };
}

const pct = (n: number, d: number): number => Math.round((1000 * n) / Math.max(1, d)) / 10;

/** `runs` battles with seeds seedBase, seedBase+1, … */
export function runSeries(
  spec: BattleSpec,
  runs: number,
  seedBase = 1,
  rules?: RulesOverride,
  opts: Omit<RunOptions, 'rules'> = {},
): SeriesResult {
  const t0 = performance.now();
  let att = 0;
  let def = 0;
  let draw = 0;
  let rounds = 0;
  for (let i = 0; i < runs; i++) {
    const r = runBattle(spec, seedBase + i, { ...opts, rules });
    if (r.winner === 'attacker') att++;
    else if (r.winner === 'defender') def++;
    else draw++;
    rounds += r.rounds;
  }
  const attackerWinPct = pct(att, runs);
  const defenderWinPct = pct(def, runs);
  const margin = Math.round((attackerWinPct - defenderWinPct) * 10) / 10;
  return {
    name: spec.name,
    runs,
    attackerWinPct,
    defenderWinPct,
    drawPct: pct(draw, runs),
    avgRounds: Math.round((10 * rounds) / Math.max(1, runs)) / 10,
    margin,
    ...(spec.expect ? { pass: seriesPasses(margin, spec.expect), expect: spec.expect } : {}),
    ms: Math.round(performance.now() - t0),
  };
}

export interface RulesComparison {
  name: string;
  baseline: SeriesResult;
  candidate: SeriesResult;
  /** candidate − baseline, in percentage points / rounds. */
  delta: { attackerWinPct: number; defenderWinPct: number; drawPct: number; avgRounds: number };
  band: ReturnType<typeof expectBand> | null;
}

/**
 * Run every spec under `baseline` and `candidate` overrides (each layered on
 * top of the spec's own `rules`) with the same seeds, so the delta reflects the
 * rules change rather than dice noise.
 */
export function compareRules(
  specs: BattleSpec[],
  baseline: RulesOverride | undefined,
  candidate: RulesOverride | undefined,
  runs: number,
  seedBase = 1,
  onProgress?: (done: number, total: number, last: RulesComparison) => void,
): RulesComparison[] {
  const out: RulesComparison[] = [];
  const r1 = (x: number): number => Math.round(x * 10) / 10;
  for (const spec of specs) {
    const b = runSeries(spec, runs, seedBase, baseline);
    const c = runSeries(spec, runs, seedBase, candidate);
    const cmp: RulesComparison = {
      name: spec.name,
      baseline: b,
      candidate: c,
      delta: {
        attackerWinPct: r1(c.attackerWinPct - b.attackerWinPct),
        defenderWinPct: r1(c.defenderWinPct - b.defenderWinPct),
        drawPct: r1(c.drawPct - b.drawPct),
        avgRounds: r1(c.avgRounds - b.avgRounds),
      },
      band: spec.expect ? expectBand(spec.expect) : null,
    };
    out.push(cmp);
    onProgress?.(out.length, specs.length, cmp);
  }
  return out;
}

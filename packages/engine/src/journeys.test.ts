// Journey tests: every standard save fixture loads, validates and plays to the
// end with the AI on both sides, holding the core invariants at every step.
// Regenerate fixtures with `pnpm --filter @iron-ridge/engine fixtures:saves`.

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import type { GameAction } from './actions.ts';
import { aiStep } from './runner.ts';
import { deserializeSave, serializeSave, validateGameState } from './save.ts';
import { isPresent, worldOf } from './strategic.ts';
import type { GameState } from './types.ts';
import { baseUnitType, unitType } from './units.ts';
import { withRules } from './rules.ts';

const DIR = new URL('../fixtures/saves/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, DIR), 'utf8');
const BROKEN = new Set(['corrupt.json', 'truncated.json']);
const FIXTURES = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !BROKEN.has(f))
  .sort();

function load(name: string): GameState {
  const r = deserializeSave(read(name));
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.save.state;
}

function aiBoth(s: GameState): GameState {
  return { ...s, settings: { ...s.settings, controllers: { A: 'ai', B: 'ai' } } };
}

/** One AI action for whoever acts (runAi's fallback policy, one step at a time). */
function step(s: GameState): GameState {
  const r = apply(s, aiStep(s));
  if (!r.error) return r.state;
  const fallback: GameAction =
    s.phase === 'battle'
      ? s.battle?.phase === 'deploy'
        ? { type: 'finishDeploy' }
        : { type: 'endBattleTurn' }
      : { type: 'endTurn' };
  const fb = apply(s, fallback);
  if (fb.error) throw new Error(`AI stuck in ${s.phase}: ${r.error} / ${fb.error}`);
  return fb.state;
}

function invariants(s: GameState): string[] {
  const out: string[] = [];
  const { world } = worldOf(s);
  const seen = new Map<string, string>();
  for (const a of s.armies) {
    if (world.subByKey.get(a.pos)?.main !== a.at) out.push(`${a.id}: at ${a.at} ≠ main(${a.pos})`);
    if (isPresent(a)) {
      if (seen.has(a.pos)) out.push(`${a.id} overlaps ${seen.get(a.pos)} at ${a.pos}`);
      seen.set(a.pos, a.id);
    }
    withRules(s.settings.rules, () => {
      for (const u of a.units) {
        const max = Math.max(baseUnitType(u.typeId).hp, unitType(u.typeId).hp);
        if (!(u.hp > 0) || u.hp > max) out.push(`${u.id}: hp ${u.hp}/${max}`);
      }
    });
  }
  if (s.cp.A < 0 || s.cp.B < 0) out.push(`negative CP ${s.cp.A}/${s.cp.B}`);
  if (s.battle) {
    const cells = new Set<string>();
    for (const u of s.battle.units) {
      if (u.hp < 0 || u.hp > u.maxHp) out.push(`battle ${u.id}: hp ${u.hp}/${u.maxHp}`);
      if (u.hp > 0 && u.pos) {
        if (cells.has(u.pos)) out.push(`battle units overlap at ${u.pos}`);
        cells.add(u.pos);
      }
    }
  }
  out.push(...validateGameState(s));
  return out;
}

function playOut(start: GameState, limit = 6000): { end: GameState; steps: number } {
  let s = aiBoth(start);
  let i = 0;
  for (; i < limit && s.phase !== 'over'; i++) {
    s = step(s);
    const bad = invariants(s);
    if (bad.length) throw new Error(`step ${i} (${s.phase}, turn ${s.turn}): ${bad.join('; ')}`);
  }
  return { end: s, steps: i };
}

function playN(s: GameState, n: number): GameState {
  for (let i = 0; i < n && s.phase !== 'over'; i++) s = step(s);
  return s;
}

describe('save fixtures', () => {
  it('includes the standard set', () => {
    for (const name of [
      'strategic-t1',
      'strategic-midgame',
      'battle-pending',
      'battle-deploy',
      'battle-combat',
      'battle-over',
      'hotseat-fog',
      'with-rules-override',
      'legacy-0.9.0',
    ])
      expect(FIXTURES).toContain(`${name}.json`);
  });

  it.each(FIXTURES)(
    '%s loads, validates and plays to completion (AI vs AI)',
    (name) => {
      const s = load(name);
      expect(validateGameState(s)).toEqual([]);
      expect(invariants(s)).toEqual([]);
      const { end } = playOut(s);
      expect(end.phase).toBe('over');
      expect(end.battle).toBeNull();
    },
    60_000,
  );

  it.each(FIXTURES)('%s round-trips through serialize → deserialize', (name) => {
    const s = load(name);
    const r = deserializeSave(serializeSave(s, 'rt'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.save.state).toEqual(s);
      expect(r.migrated).toEqual([]);
    }
  });

  it.each(['strategic-midgame.json', 'battle-combat.json', 'hotseat-fog.json'])(
    '%s: save/load mid-way ends the same as straight play',
    (name) => {
      const start = aiBoth(load(name));
      const N = 120;
      const k = 47;
      const straight = playN(start, N);
      const first = playN(start, k);
      const r = deserializeSave(serializeSave(first, 'mid'));
      expect(r.ok).toBe(true);
      const resumed = playN(r.ok ? r.save.state : first, N - k);
      expect(resumed).toEqual(straight);
      expect(JSON.stringify(resumed)).toBe(JSON.stringify(straight));
    },
    60_000,
  );

  it('legacy-0.9.0 migrates to a valid schema-2 state with notes', () => {
    const r = deserializeSave(read('legacy-0.9.0.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.save.state;
    expect(r.save.schema).toBe(2);
    expect(s.version).toBe('1.0.0');
    expect(r.migrated.length).toBeGreaterThanOrEqual(4);
    expect(r.migrated.join('\n')).toMatch(/objective/);
    expect(r.migrated.join('\n')).toMatch(/exposed/);
    expect(s.armies.every((a) => a.kind && a.pos)).toBe(true);
    expect(s.armies.filter((a) => a.kind === 'garrison')).toHaveLength(2);
    expect(s.battle!.objective.kind).toBe('capture_point');
    expect(s.battle!.units.every((u) => typeof u.exposed === 'boolean' && !('revealed' in u))).toBe(
      true,
    );
    // Once re-saved it is a plain schema-2 save: no further migration.
    const again = deserializeSave(serializeSave(s));
    expect(again.ok && again.migrated).toEqual([]);
  });

  it.each([
    ['corrupt.json', /validation/],
    ['truncated.json', /not valid JSON/],
  ])('%s is rejected with a readable error', (name, re) => {
    const r = deserializeSave(read(name));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });

  it('a future-schema copy of a fixture is rejected', () => {
    const env = JSON.parse(read('strategic-t1.json'));
    env.schema = 7;
    const r = deserializeSave(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version/);
  });

  it('with-rules-override keeps its rules and they still apply', () => {
    const s = load('with-rules-override.json');
    expect(s.settings.rules?.units?.ww2_rifle_infantry?.cost).toBe(2);
    const r = deserializeSave(serializeSave(s));
    expect(r.ok && r.save.state.settings.rules).toEqual(s.settings.rules);
    expect(s.phase).toBe('strategic');
    const res = apply(s, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
    expect(res.error).toBeNull();
    expect(res.state.cp[s.active]).toBe(s.cp[s.active] - 2);
    const recruit = res.state.armies
      .find((a) => a.team === s.active && a.kind === 'garrison')!
      .units.at(-1)!;
    expect(recruit.hp).toBe(12);
  });

  it('hotseat-fog is a human/human fog game mid battle', () => {
    const s = load('hotseat-fog.json');
    expect(s.settings.controllers).toEqual({ A: 'human', B: 'human' });
    expect(s.settings.fog).toBe(true);
    expect(s.battle?.phase).toBe('combat');
  });
});

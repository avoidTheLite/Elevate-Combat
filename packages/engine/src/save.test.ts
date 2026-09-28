/* eslint-disable @typescript-eslint/no-explicit-any -- tests poke at raw, untyped save JSON */
import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import {
  SAVE_SCHEMA,
  deserializeSave,
  migrateSave,
  serializeSave,
  validateGameState,
} from './save.ts';
import {
  COMMAND,
  ENGINE_VERSION,
  armyMoves,
  createGame,
  defaultSettings,
  worldOf,
} from './strategic.ts';
import type { GameState } from './types.ts';

function game(): GameState {
  return createGame({
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
    controllers: { A: 'ai', B: 'ai' },
  });
}

/** Strip a V1 strategic state back to the V0.9 bare shape. */
function legacyOf(s: GameState): Record<string, unknown> {
  const g = structuredClone(s) as unknown as Record<string, any>;
  g.version = '0.9.0';
  g.armies = g.armies
    .filter((a: any) => a.kind === 'commander')
    .map((a: any) => ({ id: a.id, team: a.team, at: a.at, units: a.units, movesLeft: 1 }));
  return g;
}

describe('serializeSave / deserializeSave', () => {
  it('wraps the state in a versioned envelope', () => {
    const s = game();
    const text = serializeSave(s, 'My save', '2026-02-03T04:05:06.000Z');
    const env = JSON.parse(text);
    expect(env).toMatchObject({
      format: 'iron-ridge-save',
      schema: SAVE_SCHEMA,
      engineVersion: ENGINE_VERSION,
      savedAt: '2026-02-03T04:05:06.000Z',
      label: 'My save',
    });
    expect(ENGINE_VERSION).toBe('1.0.0');
    expect(s.version).toBe('1.0.0');
  });

  it('defaults the label from turn and phase', () => {
    const r = deserializeSave(serializeSave(game()));
    expect(r.ok && r.save.label).toBe('Turn 1 · strategic');
  });

  it('round-trips a state exactly', () => {
    const s = game();
    const r = deserializeSave(serializeSave(s, 'x'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.save.state).toEqual(s);
      expect(r.migrated).toEqual([]);
    }
  });

  it.each([
    ['empty', ''],
    ['not JSON', 'hello there'],
    ['truncated', serializeSave(game()).slice(0, 200)],
    ['JSON null', 'null'],
    ['JSON array', '[1,2,3]'],
    ['foreign object', '{"hello":"world"}'],
    ['wrong format', JSON.stringify({ format: 'other-game', schema: 1, state: {} })],
    ['no schema', JSON.stringify({ format: 'iron-ridge-save', state: {} })],
    ['missing state', JSON.stringify({ format: 'iron-ridge-save', schema: 2 })],
  ])('rejects %s without throwing', (_, text) => {
    const r = deserializeSave(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
  });

  it('rejects a save from a newer schema with a clear message', () => {
    const env = JSON.parse(serializeSave(game()));
    env.schema = SAVE_SCHEMA + 1;
    env.engineVersion = '9.9.9';
    const r = deserializeSave(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version.*schema 3/);
  });

  it('never throws on non-string input', () => {
    expect(() => deserializeSave(undefined as unknown as string)).not.toThrow();
    expect(deserializeSave(42 as unknown as string).ok).toBe(false);
  });
});

describe('validateGameState', () => {
  const broken = (fn: (g: any) => void): string[] => {
    const g = structuredClone(game()) as any;
    fn(g);
    return validateGameState(g);
  };

  it('accepts a fresh game', () => {
    expect(validateGameState(game())).toEqual([]);
  });

  it.each<[string, (g: any) => void, RegExp]>([
    ['unknown era', (g) => (g.settings.era = 'space'), /settings\.era/],
    ['grid out of bounds', (g) => (g.settings.grid.subRadius = 40), /subRadius/],
    ['bad controller', (g) => (g.settings.controllers.B = 'robot'), /controllers/],
    ['bad rules', (g) => (g.settings.rules = { units: { nope: {} } }), /settings\.rules/],
    ['rules out of range', (g) => (g.settings.rules = { units: { ww2_tank: { hp: -1 } } }), /hp/],
    ['unknown phase', (g) => (g.phase = 'lunch'), /phase/],
    ['negative cp', (g) => (g.cp.A = -1), /cp/],
    ['hq off map', (g) => (g.hq.B = '99,99'), /hq\.B/],
    ['missing hex', (g) => delete g.hexes[g.hq.A], /hexes\./],
    ['army off grid', (g) => (g.armies[0].pos = '500,500'), /pos/],
    ['at/pos mismatch', (g) => (g.armies[0].at = g.hq.B), /does not contain/],
    [
      'holder overlap',
      (g) => (g.armies[1].pos = g.armies[0].pos),
      /shares sub-hex|does not contain/,
    ],
    ['duplicate army id', (g) => (g.armies[1].id = g.armies[0].id), /duplicate/],
    ['unknown kind', (g) => (g.armies[0].kind = 'navy'), /kind/],
    ['unknown typeId', (g) => (g.armies[0].units[0].typeId = 'laser'), /unknown unit type/],
    ['wrong-era typeId', (g) => (g.armies[0].units[0].typeId = 'med_infantry'), /not a ww2 unit/],
    ['hp too high', (g) => (g.armies[0].units[0].hp = 9999), /hp/],
    ['hp not a number', (g) => (g.armies[0].units[0].hp = 'full'), /hp/],
    ['battle phase without battle', (g) => (g.phase = 'battle'), /battle is null/],
    ['pending phase without pending', (g) => (g.phase = 'battle-pending'), /pending is null/],
    ['bad fort', (g) => (g.forts['0,0'] = 99), /forts/],
    ['no rng', (g) => delete g.rng, /rng/],
  ])('reports %s', (_, fn, re) => {
    const errs = broken(fn);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).toMatch(re);
  });

  it('does not crash on garbage', () => {
    for (const v of [null, 1, 'x', [], { settings: 3 }, { settings: { grid: null } }])
      expect(validateGameState(v).length).toBeGreaterThan(0);
  });
});

describe('migrateSave (schema 1 → 2)', () => {
  it('turns V0.9 armies into commanders on sub-hexes and adds HQ garrisons', () => {
    const s = game();
    const legacy = legacyOf(s);
    const r = migrateSave(legacy, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.state;
    expect(validateGameState(m)).toEqual([]);
    expect(m.version).toBe(ENGINE_VERSION);
    const { world } = worldOf(m);
    for (const a of m.armies) {
      expect(world.subByKey.get(a.pos)!.main).toBe(a.at);
    }
    const commanders = m.armies.filter((a) => a.kind === 'commander');
    expect(commanders).toHaveLength(2);
    // One main step in V0.9 = commandMove(n) sub-hex steps, capped at the holder's full allowance.
    for (const c of commanders)
      expect(c.movesLeft).toBe(Math.min(armyMoves(c, 2), COMMAND.commandMove(2)));
    for (const t of ['A', 'B'] as const) {
      const g = m.armies.find((a) => a.team === t && a.kind === 'garrison')!;
      expect(g.building).toBe('hq');
      expect(g.at).toBe(m.hq[t]);
    }
    expect(r.notes.join('\n')).toMatch(/garrison/);
    expect(r.notes.join('\n')).toMatch(/commanders/);
    // Migrated game is playable.
    const res = apply(m, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
    expect(res.error).toBeNull();
  });

  it('deserializes a bare legacy state and reports the upgrade', () => {
    const r = deserializeSave(JSON.stringify(legacyOf(game())));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.save.schema).toBe(SAVE_SCHEMA);
      expect(r.migrated[0]).toMatch(/Upgraded V0\.9\.0 save/);
    }
  });

  it('drops empty V0.9 armies and leaves V1 holders untouched', () => {
    const s = game();
    const legacy = legacyOf(s) as any;
    legacy.armies.push({ id: 'Xempty', team: 'A', at: s.hq.A, units: [], movesLeft: 0 });
    const r = migrateSave(legacy, 1);
    expect(r.ok && r.state.armies.some((a) => a.id === 'Xempty')).toBe(false);
    // A pre-release 0.9.0 state that already has holders only gets its version bumped.
    const pre = structuredClone(s) as any;
    pre.version = '0.9.0';
    const r2 = migrateSave(pre, 1);
    expect(r2.ok && r2.state.armies).toEqual(s.armies);
  });

  it('fails cleanly on states too broken to migrate', () => {
    expect(migrateSave(null).ok).toBe(false);
    expect(migrateSave({ settings: { grid: { mainCols: 3, mainRows: 3, subRadius: 2 } } }).ok).toBe(
      false,
    );
    const r = migrateSave({
      ...legacyOf(game()),
      armies: [{ id: 'x', team: 'A', at: 'nope', units: [{}] }],
    });
    expect(r.ok).toBe(false);
  });
});

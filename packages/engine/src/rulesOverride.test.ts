import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import { BASE_TN, FACING_MODS, previewAttack, resolveAttack } from './combat.ts';
import type { RulesOverride } from './rules.ts';
import { DEFAULT_MECHANICS, activeRules, mechanics, mergeRules, withRules } from './rules.ts';
import { validateRulesOverride } from './rulesValidate.ts';
import { createGame, defaultSettings } from './strategic.ts';
import { flatBattle, mkUnit, scriptedRng } from './testBattle.ts';
import { effectivenessMultiplier, unitType } from './units.ts';

const riflePair = (): ReturnType<typeof flatBattle> =>
  flatBattle([
    mkUnit('a', 'ww2_rifle_infantry', 'A', '0,0'),
    mkUnit('b', 'ww2_rifle_infantry', 'B', '2,0', 3),
  ]);

describe('runtime rules overrides', () => {
  it('unitType merges the active unit override (pools merge field by field)', () => {
    const base = unitType('ww2_tank');
    const o: RulesOverride = { units: { ww2_tank: { hp: 30, direct: { bonus: 9 } } } };
    withRules(o, () => {
      const t = unitType('ww2_tank');
      expect(t.hp).toBe(30);
      expect(t.direct).toEqual({ ...base.direct, bonus: 9 });
      expect(t.armorClass).toBe(base.armorClass);
      // Cached per override object.
      expect(unitType('ww2_tank')).toBe(t);
      // Untouched types are the baseline objects.
      expect(unitType('ww2_mortar')).toBe(unitType('ww2_mortar'));
    });
    expect(unitType('ww2_tank')).toBe(base);
    expect(unitType('ww2_tank').hp).toBe(18);
  });

  it('mechanics() deep-merges partial constants and exported constants stay baseline', () => {
    withRules(
      { mechanics: { FACING_MODS: { front: { tn: 5 } }, BASE_TN: { unarmored: 12 } } },
      () => {
        expect(mechanics().FACING_MODS.front).toEqual({ tn: 5, dmg: FACING_MODS.front.dmg });
        expect(mechanics().BASE_TN).toEqual({ ...BASE_TN, unarmored: 12 });
      },
    );
    expect(mechanics()).toBe(DEFAULT_MECHANICS);
    expect(BASE_TN.unarmored).toBe(15);
  });

  it('a mechanics override changes combat resolution', () => {
    const { ctx, battle } = riflePair();
    const base = previewAttack(ctx, battle, battle.units[0]!, '2,0');
    expect(base.tn).toBe(13); // 15 base, short 0, braced −2
    const easier: RulesOverride = { mechanics: { BASE_TN: { unarmored: 8 } } };
    const pv = withRules(easier, () => previewAttack(ctx, battle, battle.units[0]!, '2,0'));
    expect(pv.tn).toBe(6);

    // d20 = 10: misses under baseline, hits under the override.
    const miss = riflePair();
    const r0 = resolveAttack(
      miss.ctx,
      scriptedRng([10, 6]),
      miss.battle,
      miss.battle.units[0]!,
      '2,0',
    );
    expect('error' in r0 ? null : r0.result).toBe('miss');
    const hit = riflePair();
    const r1 = withRules(easier, () =>
      resolveAttack(hit.ctx, scriptedRng([10, 6]), hit.battle, hit.battle.units[0]!, '2,0'),
    );
    expect('error' in r1 ? null : r1.result).toBe('direct');
    expect(hit.battle.units[1]!.hp).toBe(10 - 6);
  });

  it('a unit override changes damage dealt', () => {
    const { ctx, battle } = riflePair();
    const buff: RulesOverride = { units: { ww2_rifle_infantry: { direct: { bonus: 3 } } } };
    withRules(buff, () =>
      resolveAttack(ctx, scriptedRng([20, 2]), battle, battle.units[0]!, '2,0'),
    );
    expect(battle.units[1]!.hp).toBe(10 - 5);
  });

  it('EFFECT_MULT is tunable', () => {
    expect(effectivenessMultiplier('piercing', 'heavy_armor')).toBeGreaterThan(0);
    withRules({ mechanics: { EFFECT_MULT: { high: 2 } } }, () => {
      expect(mechanics().EFFECT_MULT.high).toBe(2);
    });
  });

  it('withRules is nesting-safe and restores after a throw', () => {
    const a: RulesOverride = { units: { ww2_tank: { hp: 1 } } };
    const b: RulesOverride = { units: { ww2_tank: { hp: 2 } } };
    withRules(a, () => {
      expect(unitType('ww2_tank').hp).toBe(1);
      expect(() =>
        withRules(b, () => {
          expect(unitType('ww2_tank').hp).toBe(2);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(activeRules()).toBe(a);
      expect(unitType('ww2_tank').hp).toBe(1);
      // undefined means baseline, not "inherit".
      withRules(undefined, () => expect(unitType('ww2_tank').hp).toBe(18));
    });
    expect(activeRules()).toBeUndefined();
  });

  it('apply() runs every action under state.settings.rules', () => {
    const cheap: RulesOverride = { units: { ww2_rifle_infantry: { cost: 1 } } };
    const base = createGame({ ...defaultSettings(), controllers: { A: 'ai', B: 'ai' } });
    const tuned = createGame({
      ...defaultSettings(),
      controllers: { A: 'ai', B: 'ai' },
      rules: cheap,
    });
    const r0 = apply(base, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
    const r1 = apply(tuned, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
    expect(r0.error).toBeNull();
    expect(r1.error).toBeNull();
    expect(base.cp.A - r0.state.cp.A).toBe(3);
    expect(tuned.cp.A - r1.state.cp.A).toBe(1);
    // Nothing leaks out of apply.
    expect(activeRules()).toBeUndefined();
    expect(unitType('ww2_rifle_infantry').cost).toBe(3);
  });

  it('mergeRules layers overrides (later wins)', () => {
    const m = mergeRules(
      { units: { ww2_tank: { hp: 5, direct: { count: 4 } } } },
      { units: { ww2_tank: { direct: { bonus: 1 } } }, mechanics: { SPLASH_TN: 9 } },
    );
    expect(m).toEqual({
      units: { ww2_tank: { hp: 5, direct: { count: 4, bonus: 1 } } },
      mechanics: { SPLASH_TN: 9 },
    });
    expect(mergeRules(undefined, undefined)).toBeUndefined();
  });
});

describe('validateRulesOverride', () => {
  it('accepts a sane override and returns a copy', () => {
    const raw = {
      units: {
        ww2_tank: { hp: 20, direct: { bonus: 4 }, splash: null, charge: true, short: 'TK' },
      },
      mechanics: { BASE_TN: { unarmored: 14 }, FACING_MODS: { rear: { dmg: 3 } }, MAX_FORT: 4 },
    };
    const r = validateRulesOverride(raw);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rules).toEqual(raw);
    expect(r.rules).not.toBe(raw);
  });

  it('rejects unknown types, fields, non-finite and out-of-range values', () => {
    const r = validateRulesOverride({
      units: {
        nope: { hp: 3 },
        ww2_tank: { hp: Number.NaN, move: 99, bogus: 1, id: 'x', direct: { count: 1.5 } },
        ww2_mortar: { minRange: 9, maxRange: 4 },
      },
      mechanics: { BASE_TN: { unarmored: Infinity }, NOT_A_KNOB: 1, MAX_FORT: -1 },
      extra: {},
    });
    expect(r.ok).toBe(false);
    const text = r.errors.join('\n');
    for (const needle of [
      'units.nope: unknown unit type',
      'units.ww2_tank.hp: must be a finite number',
      'units.ww2_tank.move: 99 outside',
      'units.ww2_tank.bogus',
      'units.ww2_tank.id',
      'units.ww2_tank.direct.count: must be an integer',
      'units.ww2_mortar: minRange 9 > maxRange 4',
      'mechanics.BASE_TN.unarmored: must be a finite number',
      'mechanics.NOT_A_KNOB: unknown constant',
      'mechanics.MAX_FORT: -1 outside',
      'rules.extra: unknown section',
    ])
      expect(text).toContain(needle);
    expect(validateRulesOverride(null).ok).toBe(false);
    expect(validateRulesOverride([]).ok).toBe(false);
  });

  it('createGame builds starting units under the game’s own rules', () => {
    const rules: RulesOverride = { units: { ww2_rifle_infantry: { hp: 17 } } };
    const g = createGame({ ...defaultSettings(), rules });
    const rifles = g.armies
      .flatMap((a) => a.units)
      .filter((u) => u.typeId === 'ww2_rifle_infantry');
    expect(rifles.length).toBeGreaterThan(0);
    for (const u of rifles) expect(u.hp).toBe(17);
    expect(activeRules()).toBeUndefined();
  });
});

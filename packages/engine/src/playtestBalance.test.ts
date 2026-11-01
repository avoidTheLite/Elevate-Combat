import { describe, expect, it } from 'vitest';
import { PLAYTEST_BALANCE_RULES } from './playtestBalance.ts';
import { previewAttack, resolveAttack } from './combat.ts';
import type { AttackPreview } from './combat.ts';
import type { BattleUnit, GameState } from './types.ts';
import type { RulesOverride } from './rules.ts';
import { mechanics, withRules } from './rules.ts';
import { validateRulesOverride } from './rulesValidate.ts';
import { flatBattle, mkUnit, scriptedRng } from './testBattle.ts';
import { unitType } from './units.ts';
import { serializeSave, deserializeSave } from './save.ts';
const serialize = (state: Parameters<typeof serializeSave>[0]): string =>
  serializeSave(state, 'balance check', '2026-11-01T00:00:00Z');
const deserialize = (text: string): GameState => {
  const r = deserializeSave(text);
  if (!r.ok) throw new Error(r.error);
  return r.save.state;
};
import { createGame, defaultSettings } from './strategic.ts';

function shot(
  typeId: string,
  distance: number,
  moved = false,
  facing = 3,
  targetType = 'ww2_tank',
): ReturnType<typeof flatBattle> & { attacker: BattleUnit; target: BattleUnit; key: string } {
  const key = `${distance},${-Math.floor(distance / 2)}`;
  const attacker = mkUnit('shooter', typeId, 'A', '0,0');
  attacker.moved = moved;
  attacker.deployed = true;
  const target = mkUnit('target', targetType, 'B', key, facing);
  // Long-range weapons still need an actual friendly spotter; range grants no vision.
  const observer = mkUnit(
    'spotter',
    'ww2_rifle_infantry',
    'A',
    `${distance - 1},${1 - Math.floor(distance / 2)}`,
  );
  const pair = flatBattle([attacker, target, observer]);
  return { ...pair, attacker, target, key };
}

function preview(
  typeId: string,
  distance: number,
  rules?: RulesOverride,
  moved = false,
  facing = 3,
  targetType = 'ww2_tank',
): AttackPreview {
  return withRules(rules, () => {
    const x = shot(typeId, distance, moved, facing, targetType);
    return previewAttack(x.ctx, x.battle, x.attacker, x.key);
  });
}

describe('GAMES-ELEVATE-TACTICAL-UC-002: editable regular playtest balance', () => {
  it('opts into trial rules without mutating the baseline or existing saved games', () => {
    expect(validateRulesOverride(PLAYTEST_BALANCE_RULES).ok).toBe(true);
    expect(unitType('ww2_tank').maxRange).toBe(12);
    expect(unitType('ww2_at_infantry').maxRange).toBe(5);
    expect(unitType('ww2_artillery').hp).toBe(12);
    const state = createGame({ ...defaultSettings(), rules: { mechanics: { MOVED_FIRE_TN: 5 } } });
    const saved = serialize(state);
    expect(deserialize(saved).settings.rules).toEqual(state.settings.rules);
    withRules(PLAYTEST_BALANCE_RULES, () => {
      expect(unitType('ww2_tank').maxRange).toBe(8);
      expect(unitType('ww2_at_infantry').maxRange).toBe(10);
      expect(unitType('ww2_artillery').hp).toBe(8);
    });
    expect(serialize(state)).toBe(saved);
    expect(unitType('ww2_tank').maxRange).toBe(12);
  });

  it('keeps tanks strictly shorter ranged than bazookas, with real upper limits', () => {
    expect(preview('ww2_tank', 8, PLAYTEST_BALANCE_RULES).legal).toBe(true);
    expect(preview('ww2_tank', 9, PLAYTEST_BALANCE_RULES).reason).toBe('Out of range (8)');
    expect(preview('ww2_at_infantry', 10, PLAYTEST_BALANCE_RULES).legal).toBe(true);
    expect(preview('ww2_at_infantry', 11, PLAYTEST_BALANCE_RULES).reason).toBe('Out of range (10)');
  });

  it.each([2, 3, 4, 5])(
    'has a high-accuracy bazooka band at range %i against a frontal heavy vehicle',
    (distance) => {
      const p = preview('ww2_at_infantry', distance, PLAYTEST_BALANCE_RULES);
      expect(p.legal).toBe(true);
      expect(p.band).toBe('Bazooka accurate');
      expect(p.pDirect).toBe(0.95);
    },
  );

  it('drops accuracy immediately after five and keeps the full distant band to ten', () => {
    for (const distance of [6, 7, 8, 9, 10]) {
      const p = preview('ww2_at_infantry', distance, PLAYTEST_BALANCE_RULES);
      expect(p.legal).toBe(true);
      expect(p.band).toBe('Bazooka distant');
      expect(p.pDirect).toBe(0.5);
    }
    expect(preview('ww2_at_infantry', 5).pDirect).toBe(0.6);
  });

  it('retains visibility, minimum range and elevation effects with the accurate profile', () => {
    withRules(PLAYTEST_BALANCE_RULES, () => {
      const x = shot('ww2_at_infantry', 10);
      x.battle.units = [x.attacker, x.target];
      x.ctx.unitAt.delete('9,-4');
      expect(previewAttack(x.ctx, x.battle, x.attacker, x.key).reason).toBe('Target not spotted');
      const y = shot('ww2_at_infantry', 5);
      y.ctx.heightOf = (key) => (key === y.key ? 3 : 2);
      const p = previewAttack(y.ctx, y.battle, y.attacker, y.key);
      expect(p.effectiveRange).toBe(7);
      expect(p.band).toBe('Bazooka distant');
      const z = shot('ww2_at_infantry', 0);
      expect(previewAttack(z.ctx, z.battle, z.attacker, z.key).reason).toBe(
        'Inside minimum range (1)',
      );
    });
  });

  it('reduces tank movement penalty while preserving prior global movement overrides', () => {
    const oldMoved = preview('ww2_tank', 5, { mechanics: { MOVED_FIRE_TN: 5 } }, true);
    expect(oldMoved.modifiers.find((m) => m.label === 'Moved then fired')?.value).toBe(5);
    const base = preview('ww2_tank', 5, undefined, true);
    const trial = preview('ww2_tank', 5, PLAYTEST_BALANCE_RULES, true);
    expect(base.pDirect).toBe(0.35);
    expect(trial.pDirect).toBe(0.45);
    expect(trial.modifiers.find((m) => m.label === 'Moved then fired')?.value).toBe(1);
    expect(preview('ww2_tank', 5, PLAYTEST_BALANCE_RULES).pDirect).toBe(0.6);
    expect(
      preview('ww2_rifle_infantry', 5, PLAYTEST_BALANCE_RULES, true).modifiers.find(
        (m) => m.label === 'Moved then fired',
      )?.value,
    ).toBe(3);
  });

  it('improves vehicle side hit exposure separately from damage and armor', () => {
    const front = preview('ww2_tank', 5, PLAYTEST_BALANCE_RULES, true, 3);
    const side = preview('ww2_tank', 5, PLAYTEST_BALANCE_RULES, true, 2);
    expect(front.arc).toBe('front');
    expect(side.arc).toBe('side');
    expect(side.pDirect - front.pDirect).toBeCloseTo(0.25);
    withRules(PLAYTEST_BALANCE_RULES, () => {
      expect(mechanics().FACING_MODS.side.dmg).toBe(0);
      expect(mechanics().FACING_MODS.front.dmg).toBe(-2);
      expect(mechanics().ARMOR_RATING.heavy_armor).toBe(6);
    });
    const x = shot('ww2_tank', 5, true, 2);
    const r = withRules(PLAYTEST_BALANCE_RULES, () =>
      resolveAttack(x.ctx, scriptedRng([12, 4, 4, 4]), x.battle, x.attacker, x.key),
    );
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.result).toBe('direct');
  });

  it('makes artillery fragile through HP only, preserving armor, range and firepower', () => {
    const baseline = unitType('ww2_artillery');
    const trial = withRules(PLAYTEST_BALANCE_RULES, () => unitType('ww2_artillery'));
    expect(trial.armorClass).toBe('light_armor');
    expect(trial.hp).toBe(8);
    expect(trial.maxRange).toBe(baseline.maxRange);
    expect(trial.direct).toEqual(baseline.direct);
    expect(trial.splash).toEqual(baseline.splash);
    expect(preview('ww2_tank', 3, undefined, false, 3, 'ww2_artillery').expectedDamage).toBeCloseTo(
      4.675,
    );
    expect(
      preview('ww2_tank', 3, PLAYTEST_BALANCE_RULES, false, 3, 'ww2_artillery').expectedDamage,
    ).toBeCloseTo(4.675);
  });

  it('validates and serializes editable accurate-band knobs with the selected trial profile', () => {
    expect(validateRulesOverride({ mechanics: { BAZOOKA_ACCURATE_RANGE: -1 } }).ok).toBe(false);
    const s = createGame({ ...defaultSettings(), rules: structuredClone(PLAYTEST_BALANCE_RULES) });
    expect(deserialize(serialize(s)).settings.rules).toEqual(PLAYTEST_BALANCE_RULES);
    expect(
      preview('ww2_at_infantry', 5, {
        ...PLAYTEST_BALANCE_RULES,
        mechanics: { ...PLAYTEST_BALANCE_RULES.mechanics, BAZOOKA_ACCURATE_RANGE: 4 },
      }).band,
    ).toBe('Bazooka distant');
  });
});

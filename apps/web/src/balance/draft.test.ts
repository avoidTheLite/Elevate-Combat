import { describe, expect, it } from 'vitest';
import { baseUnitType, unitType, validateRulesOverride, withRules } from '@iron-ridge/engine';
import {
  changedFields,
  formToOverride,
  mechForm,
  mechFormToOverride,
  normalizeRules,
  rulesChangeCount,
  unitForm,
} from './draft.ts';

describe('unit form → RulesOverride', () => {
  it('an untouched form yields no override', () => {
    const r = formToOverride('ww2_tank', unitForm('ww2_tank'));
    expect(r).toEqual({ override: undefined, errors: [] });
  });

  it('edits produce a minimal, engine-valid override that unitType() honours', () => {
    const f = unitForm('ww2_tank');
    const base = baseUnitType('ww2_tank');
    f.nums.hp = String(base.hp + 5);
    f.direct.bonus = String(base.direct.bonus + 1);
    f.flags.suppresses = !base.suppresses;
    const r = formToOverride('ww2_tank', f);
    expect(r.errors).toEqual([]);
    expect(r.override).toEqual({
      hp: base.hp + 5,
      direct: { bonus: base.direct.bonus + 1 },
      suppresses: !base.suppresses,
    });
    const rules = { units: { ww2_tank: r.override! } };
    expect(validateRulesOverride(rules).ok).toBe(true);
    const t = withRules(rules, () => unitType('ww2_tank'));
    expect(t.hp).toBe(base.hp + 5);
    expect(t.direct.count).toBe(base.direct.count);
  });

  it('splash toggles: off → null, on for a unit without splash → full pool', () => {
    const mortar = baseUnitType('ww2_mortar');
    expect(mortar.splash).not.toBeNull();
    const off = unitForm('ww2_mortar');
    off.hasSplash = false;
    expect(formToOverride('ww2_mortar', off).override).toEqual({ splash: null });

    const rifle = unitForm('ww2_rifle_infantry');
    expect(rifle.hasSplash).toBe(false);
    rifle.hasSplash = true;
    expect(formToOverride('ww2_rifle_infantry', rifle).override).toEqual({
      splash: { count: 1, sides: 6, bonus: 0 },
    });
  });

  it('reports parse and bound errors instead of producing an override', () => {
    const f = unitForm('ww2_tank');
    f.nums.hp = '';
    expect(formToOverride('ww2_tank', f).errors).toEqual(['units.ww2_tank.hp: must be a number']);
    const g = unitForm('ww2_tank');
    g.nums.hp = '5000';
    expect(formToOverride('ww2_tank', g).errors[0]).toMatch(/hp: 5000 outside \[1, 999\]/);
    const h = unitForm('ww2_tank');
    h.nums.minRange = '9';
    h.nums.maxRange = '3';
    expect(formToOverride('ww2_tank', h).errors[0]).toMatch(/minRange 9 > maxRange 3/);
  });

  it('round-trips a saved override back into the form', () => {
    const o = { hp: 3, profile: 'melee' as const };
    const f = unitForm('ww2_tank', o);
    expect(f.nums.hp).toBe('3');
    expect(f.profile).toBe('melee');
    expect([...changedFields(f, unitForm('ww2_tank'))].sort()).toEqual(['hp', 'profile']);
  });
});

describe('mechanics form', () => {
  it('builds a nested minimal override from flattened paths', () => {
    const f = mechForm();
    f['BASE_TN.unarmored'] = '13';
    f.BLIND_FIRE_TN = '4';
    f['FACING_MODS.rear.dmg'] = '3';
    const r = mechFormToOverride(f);
    expect(r.errors).toEqual([]);
    expect(r.override).toEqual({
      BASE_TN: { unarmored: 13 },
      BLIND_FIRE_TN: 4,
      FACING_MODS: { rear: { dmg: 3 } },
    });
    expect(mechForm(r.override)['BASE_TN.unarmored']).toBe('13');
    expect(rulesChangeCount({ mechanics: r.override })).toBe(3);
  });

  it('rejects out-of-range mechanics', () => {
    const f = mechForm();
    f.MAX_FORT = '99';
    expect(mechFormToOverride(f).errors[0]).toMatch(/MAX_FORT/);
  });
});

it('normalizeRules drops empty sections', () => {
  expect(normalizeRules({ units: {}, mechanics: {} })).toEqual({});
});

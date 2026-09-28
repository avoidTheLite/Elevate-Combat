import { describe, expect, it } from 'vitest';
import type { AttackOutcome } from '@iron-ridge/engine';
import { UNIT_TYPES } from '@iron-ridge/engine';
import { flightTime, fxDuration, planAttackFx, weaponStyle } from './effects.ts';
import { FX_AMBER, FX_CORE, FX_DUST, FX_ORANGE, FX_YELLOW } from './fx.ts';
import { TEAM_COLOR } from './spec.ts';

function outcome(over: Partial<AttackOutcome> = {}): AttackOutcome {
  return {
    attackerId: 'a1',
    from: '0,0',
    target: '4,0',
    kind: 'direct',
    roll: 12,
    result: 'direct',
    damage: 2,
    killed: [],
    hits: [{ unitId: 'b1', pos: '4,0', damage: 2, killed: false }],
    log: [],
    ...over,
  };
}

describe('weapon → animation mapping', () => {
  it.each([
    ['ww2_mortar', 'lob', 'explosion'],
    ['ww2_artillery', 'lob', 'explosion'],
    ['med_artillery', 'lob', 'explosion'],
    ['ww2_tank', 'shell', 'explosion'],
    ['ww2_at_gun', 'shell', 'explosion'],
    ['ww2_at_infantry', 'shell', 'explosion'],
    ['ww2_rifle_infantry', 'bullet', 'dust'],
    ['ww2_machine_gun', 'bullet', 'dust'],
    ['ww2_light_armored_vehicle', 'bullet', 'dust'],
    ['med_archers', 'arrow', 'dust'],
    ['med_infantry', 'none', 'slash'],
    ['med_horseman', 'none', 'slash'],
  ])('%s → %s + %s', (typeId, projectile, impact) => {
    expect(weaponStyle(typeId)).toMatchObject({ projectile, impact });
  });

  it('every unit type has a style', () => {
    for (const id of Object.keys(UNIT_TYPES)) expect(weaponStyle(id).projectile).toBeDefined();
  });

  it('machine guns fire a burst; artillery gets the big blast', () => {
    expect(weaponStyle('ww2_machine_gun').rounds).toBe(3);
    expect(weaponStyle('ww2_rifle_infantry').rounds).toBe(1);
    expect(weaponStyle('ww2_artillery').big).toBe(true);
    expect(weaponStyle('ww2_mortar').big).toBe(false);
  });

  it('lobbed rounds hang in the air longer than bullets', () => {
    expect(flightTime('lob', 6)).toBeGreaterThan(flightTime('shell', 6));
    expect(flightTime('shell', 6)).toBeGreaterThan(flightTime('bullet', 6));
  });
});

describe('attack effect plan', () => {
  const all = (): boolean => true;

  it('shows "-Nhp" rising from each damaged unit', () => {
    const fx = planAttackFx(outcome(), 'ww2_rifle_infantry', 1, all, 'b1');
    expect(fx.labels).toEqual([{ key: '4,0', text: '-2hp', tone: 'damage' }]);
    expect(fx.distance).toBe(4);
    expect(fxDuration(fx)).toBeGreaterThan(fx.flight);
  });

  it('marks kills and splash damage on bystanders', () => {
    const fx = planAttackFx(
      outcome({
        hits: [
          { unitId: 'b1', pos: '4,0', damage: 9, killed: true },
          { unitId: 'b2', pos: '5,0', damage: 3, killed: false },
        ],
      }),
      'ww2_mortar',
      1,
      all,
      'b1',
    );
    expect(fx.labels.map((l) => l.text)).toEqual(['-9hp ✖', '-3hp']);
    expect(fx.labels[0]!.tone).toBe('kill');
  });

  it('labels a miss or a deflection on a visible target', () => {
    const miss = planAttackFx(outcome({ result: 'miss', hits: [] }), 'ww2_tank', 1, all, 'b1');
    expect(miss.labels).toEqual([{ key: '4,0', text: 'MISS', tone: 'miss' }]);
    expect(miss.miss).toBe(true);
    const bounce = planAttackFx(outcome({ hits: [] }), 'ww2_rifle_infantry', 1, all, 'b1');
    expect(bounce.labels[0]!.text).toBe('NO EFFECT');
  });

  it('never reveals hidden units through damage numbers', () => {
    const hidden = (id: string): boolean => id !== 'b1';
    const fx = planAttackFx(outcome(), 'ww2_artillery', 1, hidden, 'b1');
    expect(fx.labels).toEqual([]);
    const blind = planAttackFx(
      outcome({ result: 'miss', hits: [] }),
      'ww2_artillery',
      1,
      hidden,
      'b1',
    );
    expect(blind.labels).toEqual([]);
  });

  it('adds no label when shelling an empty cell', () => {
    const fx = planAttackFx(outcome({ kind: 'indirect', hits: [] }), 'ww2_mortar', 1, all, null);
    expect(fx.labels).toEqual([]);
  });
});

describe('effect palette', () => {
  it('uses only neutral highlight colours, never a team colour', () => {
    const teams = Object.values(TEAM_COLOR);
    for (const c of [FX_YELLOW, FX_AMBER, FX_ORANGE, FX_CORE, FX_DUST])
      expect(teams).not.toContain(c);
  });
});

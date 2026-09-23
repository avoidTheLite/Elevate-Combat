import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import unitsJson from './data/units.json' with { type: 'json' };
import {
  BASE_TN,
  effectiveRange,
  facingArc,
  inDepressionDeadZone,
  pAtLeast,
  previewAttack,
  rangeBand,
} from './combat.ts';
import { lineOfSight } from './los.ts';
import { effectivenessMultiplier, unitType } from './units.ts';
import type { Battle, BattleUnit } from './types.ts';
import type { BattleContext } from './battleMap.ts';
import { refreshOccupancy } from './battleMap.ts';
import { spiral, hexKey } from './hex.ts';
import { buildWorld } from './grid.ts';
import { generateTerrain } from './terrain.ts';

describe('unit data', () => {
  it('engine copy of the units JSON matches docs/iron-ridge-units.json', () => {
    const docs = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../docs/iron-ridge-units.json', import.meta.url)),
        'utf8',
      ),
    );
    expect(unitsJson).toEqual(docs);
  });

  it('damage matrix yields asymmetric tank vs rifle outcome', () => {
    expect(effectivenessMultiplier('non_piercing', 'heavy_armor')).toBe(0);
    expect(effectivenessMultiplier('siege', 'heavy_armor')).toBe(1);
    expect(unitType('ww2_tank').armorClass).toBe('heavy_armor');
  });
});

describe('combat rules v1', () => {
  it('§1 base TNs', () => {
    expect(BASE_TN).toEqual({ heavy_armor: 7, light_armor: 10, unarmored: 15 });
  });

  it('§3 range bands', () => {
    expect(rangeBand(1).name).toBe('Point-Blank');
    expect(rangeBand(3).name).toBe('Short');
    expect(rangeBand(6).name).toBe('Medium');
    expect(rangeBand(10).name).toBe('Long');
    expect(rangeBand(11).name).toBe('Extreme');
    expect(rangeBand(1).mod.tank_cannon).toBeNull();
    expect(rangeBand(8).mod.rifle_mg).toBe(6);
  });

  it('§4 worked example: dist 3, target +2 uphill → effective range 7 (Long)', () => {
    expect(effectiveRange(3, 1, 3)).toBe(7);
    expect(effectiveRange(3, 3, 1)).toBe(3); // downhill: no change
  });

  it('§6 tank depression: dist 3 with a 2-level drop is a dead zone', () => {
    expect(inDepressionDeadZone(3, 5, 3)).toBe(true);
    expect(inDepressionDeadZone(3, 4, 3)).toBe(false);
    expect(inDepressionDeadZone(6, 5, 3)).toBe(false);
  });

  it('d20 probability honours natural 1/20', () => {
    expect(pAtLeast(10)).toBeCloseTo(0.55);
    expect(pAtLeast(30)).toBeCloseTo(0.05);
    expect(pAtLeast(-5)).toBeCloseTo(0.95);
  });

  it('§7a facing arcs', () => {
    // Defender at origin facing +q (dir 0).
    expect(facingArc('0,0', 0, '3,0')).toBe('front');
    expect(facingArc('0,0', 0, '-3,0')).toBe('rear');
    expect(facingArc('0,0', 0, '-2,4')).toBe('side'); // 90° off the facing
  });
});

describe('line of sight', () => {
  it('a ridge between shooter and target blocks direct fire', () => {
    const heights: Record<string, number> = { '0,0': 2, '1,0': 2, '2,0': 8, '3,0': 2, '4,0': 2 };
    const los = lineOfSight({ q: 0, r: 0 }, { q: 4, r: 0 }, (k) => heights[k]);
    expect(los.status).toBe('blocked');
    const flat = lineOfSight({ q: 0, r: 0 }, { q: 4, r: 0 }, () => 2);
    expect(flat.status).toBe('clear');
  });
});

function flatContext(): { ctx: BattleContext; battle: Battle } {
  const world = buildWorld({ mainCols: 3, mainRows: 3, subRadius: 2 });
  const terrain = generateTerrain(world, 1);
  const cells = new Set(spiral({ q: 0, r: 0 }, 12).map(hexKey));
  const ctx: BattleContext = { world, terrain, cells, heightOf: () => 2, unitAt: new Map() };
  const mk = (
    id: string,
    typeId: string,
    team: 'A' | 'B',
    pos: string,
    facing = 0,
  ): BattleUnit => ({
    id,
    typeId,
    label: id,
    team,
    hp: unitType(typeId).hp,
    maxHp: unitType(typeId).hp,
    pos,
    facing,
    mp: 5,
    moved: false,
    movedDist: 0,
    acted: false,
    deployed: false,
    suppressed: false,
    revealed: false,
    firstStrikeUsed: false,
  });
  const battle = {
    phase: 'combat',
    active: 'A',
    attacker: 'A',
    defender: 'B',
    round: 1,
    forts: {},
    log: [],
    units: [
      mk('tank', 'ww2_tank', 'A', '0,0'),
      mk('rifle', 'ww2_rifle_infantry', 'B', '5,0', 3),
      mk('at', 'ww2_at_gun', 'B', '1,0', 3),
    ],
  } as unknown as Battle;
  refreshOccupancy(ctx, battle);
  return { ctx, battle };
}

describe('attack preview', () => {
  it('tank cannot fire point-blank (min range)', () => {
    const { ctx, battle } = flatContext();
    const pv = previewAttack(ctx, battle, battle.units[0]!, '1,0');
    expect(pv.legal).toBe(false);
  });

  it('braced tank vs rifle at medium range: TN 15 +2 −2 = 15 with splash band', () => {
    const { ctx, battle } = flatContext();
    const pv = previewAttack(ctx, battle, battle.units[0]!, '5,0');
    expect(pv.legal).toBe(true);
    expect(pv.band).toBe('Medium');
    expect(pv.tn).toBe(15);
    expect(pv.splashTn).toBe(10);
  });

  it('rifle fire does nothing to a tank (non_piercing vs heavy_armor = none)', () => {
    const { ctx, battle } = flatContext();
    battle.active = 'B';
    const pv = previewAttack(ctx, battle, battle.units[1]!, '0,0');
    expect(pv.legal).toBe(true);
    expect(pv.expectedDamage).toBe(0);
  });
});

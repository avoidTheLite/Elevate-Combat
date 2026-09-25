import { describe, expect, it } from 'vitest';
import { buildWorld } from '../grid.ts';
import { GRID_LIMITS } from '../grid.ts';
import { deploymentZone, liveUnits } from '../battleMap.ts';
import { contextFor } from '../tactical.ts';
import { activeRules } from '../rules.ts';
import { unitType } from '../units.ts';
import type { BattleSpec } from './spec.ts';
import { parseBattleSpec } from './spec.ts';
import { battleSite, inSimScope, ironRidgeRuleset, simTerrain, sizeBattleGrid } from './ruleset.ts';
import { compareRules, expectBand, runBattle, runSeries, seriesPasses } from './run.ts';
import { STANDARD_SCENARIOS, scenarioByName } from './scenarios.ts';

const SLOW = 120_000;

const small: BattleSpec = {
  name: 'small',
  era: 'ww2',
  attacker: { units: [{ typeId: 'ww2_rifle_infantry', count: 2 }] },
  defender: { units: [{ typeId: 'ww2_rifle_infantry', count: 2 }] },
};

describe('BattleSpec parsing', () => {
  it('accepts every standard scenario', () => {
    expect(STANDARD_SCENARIOS.length).toBeGreaterThanOrEqual(8);
    for (const s of STANDARD_SCENARIOS) expect(parseBattleSpec(s).errors).toEqual([]);
    expect(new Set(STANDARD_SCENARIOS.map((s) => s.name)).size).toBe(STANDARD_SCENARIOS.length);
  });

  it('rejects bad specs with readable errors', () => {
    const r = parseBattleSpec({
      name: '',
      era: 'ww2',
      attacker: { units: [{ typeId: 'med_horseman', count: 1 }] },
      defender: { units: [] },
      terrain: { kind: 'lava' },
      rules: { units: { nope: {} } },
      expect: { winner: 'nobody' },
    });
    expect(r.ok).toBe(false);
    const text = r.errors.join('\n');
    expect(text).toContain('name');
    expect(text).toContain('not a ww2 unit');
    expect(text).toContain('defender.units');
    expect(text).toContain('terrain.kind');
    expect(text).toContain('rules.units.nope');
    expect(text).toContain('expect.winner');
  });
});

describe('sizeBattleGrid', () => {
  it('picks the minimum grid for a small spec', () => {
    const g = sizeBattleGrid(small);
    expect(g.fits).toBe(true);
    expect(g.grid).toEqual({
      mainCols: GRID_LIMITS.mainCols.min,
      mainRows: GRID_LIMITS.mainRows.min,
      subRadius: GRID_LIMITS.subRadius.min,
    });
    expect(g.maxRange).toBe(unitType('ww2_rifle_infantry').maxRange);
  });

  it('grows the sub-radius until big forces fit their deploy zones', () => {
    const big: BattleSpec = {
      ...small,
      attacker: { units: [{ typeId: 'ww2_rifle_infantry', count: 30 }] },
      defender: { units: [{ typeId: 'ww2_machine_gun', count: 20 }] },
    };
    const g = sizeBattleGrid(big);
    expect(g.fits).toBe(true);
    expect(g.grid.subRadius).toBeGreaterThan(GRID_LIMITS.subRadius.min);
    expect(g.zoneCells.attacker).toBeGreaterThanOrEqual(30);
    expect(g.zoneCells.defender).toBeGreaterThanOrEqual(20);
    // …and it is the smallest such radius.
    const smaller = sizeBattleGrid({
      ...big,
      attacker: { units: [{ ...big.attacker.units[0]!, count: 1 }] },
      defender: { units: [{ typeId: 'ww2_machine_gun', count: 1 }] },
    });
    expect(smaller.grid.subRadius).toBeLessThan(g.grid.subRadius);
    // Deterministic.
    expect(sizeBattleGrid(big)).toEqual(g);
    // Zone counts match the real deploymentZone of a created battle.
    const state = ironRidgeRuleset.createBattle(big, g.grid, 1);
    inSimScope(state, () => {
      const ctx = contextFor(state);
      expect(deploymentZone(ctx, state.battle!, 'A').length).toBe(g.zoneCells.attacker);
      expect(deploymentZone(ctx, state.battle!, 'B').length).toBe(g.zoneCells.defender);
    });
  });

  it('grows the grid so the longest weapon range fits the footprint', () => {
    const longGun: BattleSpec = {
      ...small,
      rules: { units: { ww2_rifle_infantry: { maxRange: 18 } } },
    };
    const g = sizeBattleGrid(longGun);
    expect(g.maxRange).toBe(18);
    expect(g.span).toBeGreaterThanOrEqual(18);
    expect(g.grid.subRadius).toBeGreaterThan(sizeBattleGrid(small).grid.subRadius);
  });

  it('reports fits:false when nothing is big enough', () => {
    const huge: BattleSpec = {
      ...small,
      attacker: { units: [{ typeId: 'ww2_rifle_infantry', count: 40 }] },
      rules: { units: { ww2_rifle_infantry: { maxRange: 40 } } },
    };
    const g = sizeBattleGrid(huge);
    expect(g.fits).toBe(false);
    expect(g.grid.subRadius).toBe(GRID_LIMITS.subRadius.max);
  });
});

describe('battle container', () => {
  it('creates a deploy-phase battle with the spec forces, forts and rules', () => {
    const spec = scenarioByName('ww2-mortar-vs-dug-in')!;
    const state = ironRidgeRuleset.createBattle(spec, sizeBattleGrid(spec).grid, 3);
    const b = state.battle!;
    expect(state.phase).toBe('battle');
    expect(b.phase).toBe('deploy');
    expect(b.units.filter((u) => u.team === b.attacker).map((u) => u.typeId)).toEqual([
      'ww2_mortar',
      'ww2_mortar',
      'ww2_rifle_infantry',
    ]);
    expect(b.units.filter((u) => u.team === b.defender)).toHaveLength(2);
    expect(Object.values(b.forts).length).toBeGreaterThan(0);
    expect(Object.values(b.forts).every((l) => l === 2)).toBe(true);
    expect(b.warnedPlacements).toBe(0);
  });

  it('applies spec hp and spec rules to the created units', () => {
    const spec: BattleSpec = {
      ...small,
      attacker: { units: [{ typeId: 'ww2_rifle_infantry', count: 1, hp: 4 }] },
      rules: { units: { ww2_rifle_infantry: { hp: 25 } } },
    };
    const state = ironRidgeRuleset.createBattle(spec, sizeBattleGrid(spec).grid, 1);
    const [a, d] = [state.battle!.units[0]!, state.battle!.units[1]!];
    expect(a.hp).toBe(4);
    expect(a.maxHp).toBe(25);
    expect(d.hp).toBe(25);
    expect(state.settings.rules).toEqual(spec.rules);
    expect(activeRules()).toBeUndefined();
  });

  it('flat / slope / ridge terrain is deterministic and oriented origin → target', () => {
    const world = buildWorld({ mainCols: 3, mainRows: 3, subRadius: 3 });
    const site = battleSite(world);
    const at = (kind: 'flat' | 'slope' | 'ridge', key: string): number =>
      simTerrain(world, kind).heights[world.subByKey.get(key)!.index]!;
    const o = `${site.origin.center.q},${site.origin.center.r}`;
    const t = `${site.target.center.q},${site.target.center.r}`;
    expect(at('flat', o)).toBe(2);
    expect(at('flat', t)).toBe(2);
    expect(at('slope', t)).toBeGreaterThan(at('slope', o));
    expect(at('ridge', t)).toBeGreaterThan(at('ridge', o));
    expect(at('ridge', t)).toBe(Math.max(...simTerrain(world, 'ridge').heights));
    expect(simTerrain(world, 'ridge')).toBe(simTerrain(world, 'ridge'));
  });
});

describe('runBattle / runSeries / compareRules', () => {
  it(
    'is deterministic per seed',
    () => {
      const spec = scenarioByName('ww2-rifle-mirror')!;
      const a = runBattle(spec, 11);
      const b = runBattle(spec, 11);
      expect(a).toEqual(b);
      expect(a.rounds).toBeGreaterThanOrEqual(1);
      expect(activeRules()).toBeUndefined();
    },
    SLOW,
  );

  it(
    'runs every standard scenario to a result',
    () => {
      for (const spec of STANDARD_SCENARIOS) {
        const r = runBattle(spec, 1);
        expect(r.winner, spec.name).not.toBeNull();
        expect(r.endReason).not.toBe('step limit');
        expect(r.survivors.attacker + r.survivors.defender).toBeGreaterThan(0);
        expect(r.hpLeft.attacker).toBeGreaterThanOrEqual(0);
      }
    },
    SLOW,
  );

  it(
    'series percentages sum to 100 and pass/fail follows expect',
    () => {
      const spec = scenarioByName('ww2-tank-vs-at-gun')!;
      const s = runSeries(spec, 4, 1);
      expect(s.runs).toBe(4);
      expect(s.attackerWinPct + s.defenderWinPct + s.drawPct).toBeCloseTo(100, 5);
      expect(s.pass).toBe(seriesPasses(s.margin, spec.expect!));
      expect(runSeries(small, 2).pass).toBeUndefined();
    },
    SLOW,
  );

  it('pass rule and target bands', () => {
    expect(seriesPasses(10, { winner: 'even' })).toBe(true);
    expect(seriesPasses(-20, { winner: 'even' })).toBe(false);
    expect(seriesPasses(20, { winner: 'attacker' })).toBe(true);
    expect(seriesPasses(10, { winner: 'attacker' })).toBe(false);
    expect(seriesPasses(-40, { winner: 'defender', tolerance: 30 })).toBe(true);
    expect(expectBand({ winner: 'even' })).toEqual({ lo: 42.5, hi: 57.5, winner: 'even' });
    expect(expectBand({ winner: 'defender', tolerance: 20 })).toEqual({
      lo: 0,
      hi: 40,
      winner: 'defender',
    });
  });

  it(
    'compareRules detects a big buff to the attacker',
    () => {
      const spec: BattleSpec = {
        name: 'tank vs 2 AT guns',
        era: 'ww2',
        attacker: { units: [{ typeId: 'ww2_tank', count: 1 }] },
        defender: { units: [{ typeId: 'ww2_at_gun', count: 2 }] },
      };
      const [cmp] = compareRules(
        [spec],
        undefined,
        { units: { ww2_tank: { direct: { bonus: 23 } } } },
        6,
      );
      expect(cmp!.candidate.attackerWinPct).toBeGreaterThan(cmp!.baseline.attackerWinPct);
      expect(cmp!.delta.attackerWinPct).toBeGreaterThan(0);
      expect(activeRules()).toBeUndefined();
    },
    SLOW,
  );

  it(
    'runs AI vs AI to completion with every live unit accounted for',
    () => {
      const spec = scenarioByName('med-cav-vs-spears')!;
      let state = ironRidgeRuleset.createBattle(spec, sizeBattleGrid(spec).grid, 5);
      let steps = 0;
      while (!ironRidgeRuleset.isOver(state) && steps < 20000) {
        state = ironRidgeRuleset.step(state);
        steps++;
      }
      const r = ironRidgeRuleset.result(state);
      const b = state.battle!;
      expect(b.phase).toBe('over');
      expect(r.survivors.attacker).toBe(liveUnits(b, b.attacker).length);
      expect(r).toEqual(runBattle(spec, 5));
    },
    SLOW,
  );
});

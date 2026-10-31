import { describe, expect, it } from 'vitest';
import { hexDistance, parseKey } from '../hex.ts';
import {
  compareSupplyPaths,
  evaluateSupplyGraph,
  supplyStepCost,
  type SupplyCell,
  type SupplyConnector,
  type SupplyGraphInput,
  type SupplyProfile,
} from './supplyGraph.ts';

const profile: SupplyProfile = {
  terrainCosts: { land: 1, marsh: 2 },
  minimumStepCost: 0.1,
  uphillSurcharge: 1,
  downhillCredit: 0.25,
  maximumClimb: 3,
  maximumDrop: 4,
  roadMultiplier: 0.5,
  legRange: 8,
  distanceFloor: 0.3,
  distanceDecay: 0.06,
  hostileClaimFactor: 0.5,
};
const connector = (
  id: string,
  subHex: string,
  authority: SupplyConnector['authority'] = null,
  relayRangeBonus = 0,
): SupplyConnector => ({ id, subHex, authority, relayRangeBonus, owner: 'A', operational: true });
function line(length: number): SupplyGraphInput {
  return {
    cells: Array.from({ length }, (_, i) => ({
      key: `${i},0`,
      mainHex: 'main',
      height: 1,
      terrain: 'land',
    })),
    connectors: [connector('hq', '0,0', 'home'), connector('target', `${length - 1},0`)],
    roads: [],
    blockers: [],
    claims: { main: 'A' },
    profile,
    team: 'A',
  };
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: weighted supply paths', () => {
  it('penalizes each distinct hostile MainHex once after the distance floor', () => {
    const input = line(5);
    const cells = input.cells.map((cell, i) => ({
      ...cell,
      mainHex: i === 1 || i === 2 ? 'hostile-1' : i === 3 ? 'hostile-2' : 'main',
    }));
    const result = evaluateSupplyGraph({
      ...input,
      cells,
      claims: { main: 'A', 'hostile-1': 'B', 'hostile-2': 'B' },
      profile: { ...profile, distanceDecay: 1 },
    });
    const route = result.nodes.target.activeRoute!;
    expect(route.hostileMainHexes).toEqual(['hostile-1', 'hostile-2']);
    expect(route.distanceEfficiency).toBe(0.3);
    expect(route.effectiveEfficiency).toBe(0.075);
    expect(route.path).toHaveLength(5);
  });

  it('chooses a costlier friendly detour over a hostile shortcut', () => {
    const input = line(3);
    const cells = [
      ...input.cells.map((cell, i) => ({ ...cell, mainHex: i === 1 ? 'enemy' : 'main' })),
      { key: '0,1', mainHex: 'main', terrain: 'land', height: 1 },
      { key: '1,1', mainHex: 'main', terrain: 'land', height: 1 },
    ];
    const result = evaluateSupplyGraph({ ...input, cells, claims: { main: 'A', enemy: 'B' } });
    expect(result.nodes.target.activeRoute!.path).toEqual(['0,0', '0,1', '1,1', '2,0']);
    expect(result.nodes.target.activeRoute!.weightedCost).toBe(3);
    expect(result.nodes.target.activeRoute!.hostileMainHexes).toEqual([]);
  });

  it('uses actual enemy blockers, not ownership, and automatically detours/reconnects', () => {
    const input = line(3);
    const cells = [
      ...input.cells,
      { key: '0,1', mainHex: 'main', terrain: 'land', height: 1 },
      { key: '1,1', mainHex: 'main', terrain: 'land', height: 1 },
    ];
    const blocked = evaluateSupplyGraph({
      ...input,
      cells,
      blockers: [{ unitId: 'guard', team: 'B', subHex: '1,0' }],
    });
    expect(blocked.nodes.target.activeRoute!.path).not.toContain('1,0');
    expect(blocked.blockedCells).toEqual(['1,0']);
    expect(evaluateSupplyGraph({ ...input, cells }).nodes.target.activeRoute!.weightedCost).toBe(2);
    expect(
      evaluateSupplyGraph({
        ...input,
        blockers: [{ unitId: 'friendly', team: 'A', subHex: '1,0' }],
      }).nodes.target.activeRoute,
    ).not.toBeNull();
  });

  it('restores a road discount only when the section is operational', () => {
    const input = { ...line(3), profile: { ...profile, legRange: 1.5 } };
    const section = { id: 'road', mainHex: 'main', path: ['0,0', '1,0', '2,0'], damaged: true };
    expect(evaluateSupplyGraph({ ...input, roads: [section] }).nodes.target.connection).toBe(
      'none',
    );
    const repaired = evaluateSupplyGraph({ ...input, roads: [{ ...section, damaged: false }] });
    expect(repaired.nodes.target.activeRoute!.weightedCost).toBe(1);
    expect(repaired.nodes.target.activeRoute!.path).toEqual(section.path);
  });

  it('checks range per leg and requires an independently reached outgoing relay', () => {
    const input = line(7);
    const result = evaluateSupplyGraph({
      ...input,
      profile: { ...profile, legRange: 2 },
      connectors: [...input.connectors, connector('relay', '2,0', null, 2)],
    });
    const route = result.nodes.target.activeRoute!;
    expect(route.weightedCost).toBe(6);
    expect(
      route.legs.map((leg) => [
        leg.fromConnector,
        leg.toConnector,
        leg.weightedCost,
        leg.rangeBudget,
      ]),
    ).toEqual([
      ['hq', 'relay', 2, 2],
      ['relay', 'target', 4, 4],
    ]);
    const unreachable = evaluateSupplyGraph({
      ...input,
      profile: { ...profile, legRange: 2 },
      connectors: [
        ...input.connectors,
        connector('relay-a', '3,0', null, 5),
        connector('relay-b', '5,0', null, 5),
      ],
    });
    expect(unreachable.nodes['relay-a'].activeRoute).toBeNull();
    expect(unreachable.nodes['relay-b'].activeRoute).toBeNull();
    expect(unreachable.nodes.target.activeRoute).toBeNull();
  });

  it('defines islands through legal connector links rather than passable terrain alone', () => {
    const input = line(6);
    const disconnected = evaluateSupplyGraph({ ...input, profile: { ...profile, legRange: 2 } });
    expect(disconnected.islands).toHaveLength(2);
    expect(disconnected.nodes.target.connection).toBe('none');
    const regional = evaluateSupplyGraph({
      ...input,
      profile: { ...profile, legRange: 2 },
      connectors: [...input.connectors, connector('regional', '4,0', 'regional')],
    });
    expect(regional.nodes.target.connection).toBe('regional');
    expect(regional.nodes.target.homeConnected).toBe(false);
  });

  it('uses numeric axial path order and remains stable through serialization/reordering', () => {
    const cells = ['0,0', '1,-1', '1,0', '2,-1'].map((key) => ({
      key,
      mainHex: 'main',
      height: 1,
      terrain: 'land',
    }));
    const input = {
      ...line(3),
      cells,
      connectors: [connector('hq', '0,0', 'home'), connector('target', '2,-1')],
    };
    const original = evaluateSupplyGraph(input);
    expect(original.nodes.target.activeRoute!.path).toEqual(['0,0', '1,-1', '2,-1']);
    expect(
      evaluateSupplyGraph({ ...JSON.parse(JSON.stringify(input)), cells: [...cells].reverse() }),
    ).toEqual(original);
    expect(compareSupplyPaths(['2,0'], ['10,0'])).toBeLessThan(0);
  });

  it('uses destination marsh, climb/drop limits and a positive discounted step floor', () => {
    const cell: SupplyCell = { key: '0,0', mainHex: 'main', height: 1, terrain: 'land' };
    expect(supplyStepCost(cell, { ...cell, height: 0, terrain: 'marsh' }, profile, false)).toBe(
      1.75,
    );
    expect(supplyStepCost(cell, { ...cell, height: 5 }, profile, false)).toBeNull();
    expect(supplyStepCost({ ...cell, height: 6 }, cell, profile, false)).toBeNull();
    expect(
      supplyStepCost({ ...cell, height: 4 }, cell, { ...profile, downhillCredit: 0.9 }, true),
    ).toBe(0.1);
  });

  it('rejects duplicate identities, invalid profiles and nonlocal/nonadjacent roads', () => {
    const input = line(3);
    expect(() =>
      evaluateSupplyGraph({ ...input, profile: { ...profile, legRange: Infinity } }),
    ).toThrow();
    expect(() =>
      evaluateSupplyGraph({ ...input, profile: { ...profile, minimumStepCost: 0 } }),
    ).toThrow();
    expect(() =>
      evaluateSupplyGraph({ ...input, connectors: [...input.connectors, connector('hq', '1,0')] }),
    ).toThrow('Duplicate');
    expect(() =>
      evaluateSupplyGraph({
        ...input,
        roads: [{ id: 'bad', mainHex: 'main', path: ['0,0', '2,0'], damaged: false }],
      }),
    ).toThrow('face adjacent');
  });

  it('accumulates decimal step costs exactly at a per-leg range boundary', () => {
    const input = line(4);
    const result = evaluateSupplyGraph({
      ...input,
      profile: { ...profile, terrainCosts: { land: 0.1 }, minimumStepCost: 0.01, legRange: 0.3 },
    });
    expect(result.nodes.target.activeRoute).toMatchObject({
      exactWeightedCost: { decimal: '0.3' },
      exactDistanceEfficiency: { decimal: '0.982' },
    });
  });

  it('does not turn an exact additive relay bonus into extra outgoing reach', () => {
    const input = line(3);
    const nodes = input.connectors.map((node) =>
      node.id === 'hq' ? { ...node, relayRangeBonus: { decimal: '0.3' } } : node,
    );
    const cells = input.cells.map((cell, index) => ({
      ...cell,
      terrain: index === 1 ? 'first' : index === 2 ? 'last' : 'land',
    }));
    const configured = {
      ...input,
      cells,
      connectors: nodes,
      profile: {
        ...profile,
        minimumStepCost: 0.01,
        legRange: 0.2,
        terrainCosts: { land: 1, first: 0.3, last: 0.20000000000000004 },
      },
    };
    const result = evaluateSupplyGraph(configured);
    expect(result.nodes.hq.activeRoute!.legs[0].exactRangeBudget).toEqual({ decimal: '0.5' });
    expect(result.nodes.target.activeRoute).toBeNull();
    const binarySum = evaluateSupplyGraph({
      ...configured,
      connectors: configured.connectors.map((node) =>
        node.id === 'hq' ? { ...node, relayRangeBonus: 0.1 + 0.2 } : node,
      ),
    });
    expect(binarySum.nodes.target.activeRoute!.exactWeightedCost).toEqual({
      decimal: '0.50000000000000004',
    });
  });

  it('uses exact cost ordering when numeric display previews collapse two path costs', () => {
    const input = line(3);
    const cells = ['0,0', '1,-1', '1,0', '2,-1'].map((key) => ({
      key,
      mainHex: 'main',
      height: 1,
      terrain: key === '1,-1' ? 'expensive' : key === '1,0' ? 'cheap' : 'land',
    }));
    const result = evaluateSupplyGraph({
      ...input,
      cells,
      connectors: [connector('hq', '0,0', 'home'), connector('target', '2,-1')],
      profile: {
        ...profile,
        terrainCosts: { land: 1e16, cheap: 0.1, expensive: 0.2 },
        minimumStepCost: 0.01,
        legRange: 1e16 + 2,
        distanceDecay: 0,
      },
    });
    expect(result.nodes.target.activeRoute!.path).toEqual(['0,0', '1,0', '2,-1']);
    expect(result.nodes.target.activeRoute!.exactWeightedCost).toEqual({
      decimal: '10000000000000000.1',
    });
  });
});

/** Independent exhaustive simple-path oracle for small graphs without intermediate connectors. */
function oracle(
  input: SupplyGraphInput,
): { path: string[]; cost: number; hostile: number; efficiency: number } | null {
  const source = input.connectors[0].subHex;
  const target = input.connectors[1].subHex;
  const blocked = new Set(
    input.blockers
      .filter((blocker) => blocker.team !== input.team)
      .map((blocker) => blocker.subHex),
  );
  const answers: { path: string[]; cost: number; hostile: number; efficiency: number }[] = [];
  const visit = (path: string[], cost: number): void => {
    const key = path[path.length - 1];
    if (key === target) {
      const enemies = new Set(
        path
          .map((position) => input.cells.find((cell) => cell.key === position)!.mainHex)
          .filter((main) => input.claims[main] !== null && input.claims[main] !== input.team),
      );
      answers.push({
        path,
        cost,
        hostile: enemies.size,
        // These fixture costs are quarters, decay is exactly .06 and floor exactly .3.
        // One integer numerator/division avoids reproducing binary intermediate rounding.
        efficiency: Math.max(300, 1000 - cost * 60) / (1000 * 2 ** enemies.size),
      });
      return;
    }
    const from = input.cells.find((cell) => cell.key === key)!;
    for (const to of input.cells) {
      if (
        path.includes(to.key) ||
        blocked.has(to.key) ||
        hexDistance(parseKey(key), parseKey(to.key)) !== 1
      )
        continue;
      const climb = to.height - from.height;
      if (climb > input.profile.maximumClimb || -climb > input.profile.maximumDrop) continue;
      const step = Math.max(
        input.profile.minimumStepCost,
        input.profile.terrainCosts[to.terrain] +
          Math.max(0, climb) * input.profile.uphillSurcharge -
          Math.max(0, -climb) * input.profile.downhillCredit,
      );
      if (cost + step <= input.profile.legRange) visit([...path, to.key], cost + step);
    }
  };
  visit([source], 0);
  return (
    answers.sort(
      (a, b) =>
        b.efficiency - a.efficiency ||
        a.cost - b.cost ||
        a.hostile - b.hostile ||
        compareSupplyPaths(a.path, b.path),
    )[0] ?? null
  );
}

describe('small-graph exhaustive route oracle', () => {
  it('matches every exhaustive optimum across 48 deterministic weighted/hostile/blocker fixtures', () => {
    for (let seed = 0; seed < 48; seed++) {
      const cells = ['0,0', '1,0', '2,0', '0,1', '1,1', '2,1'].map((key, i) => ({
        key,
        mainHex: key,
        height: 1 + ((seed >>> (i % 5)) & 1),
        terrain: 'land',
      }));
      const input: SupplyGraphInput = {
        cells,
        connectors: [connector('hq', '0,0', 'home'), connector('target', '2,1')],
        claims: Object.fromEntries(
          cells.map((cell, i) => [cell.mainHex, i > 0 && i < 5 && (seed >>> i) & 1 ? 'B' : 'A']),
        ),
        profile,
        team: 'A',
        roads: [],
        blockers: seed % 3 === 0 ? [{ unitId: 'guard', team: 'B', subHex: '1,0' }] : [],
      };
      const expected = oracle(input);
      const actual = evaluateSupplyGraph(input).nodes.target.activeRoute;
      expect(actual?.path ?? null, `fixture ${seed}`).toEqual(expected?.path ?? null);
      expect(actual?.weightedCost ?? null).toEqual(expected?.cost ?? null);
      expect(actual?.effectiveEfficiency ?? null).toEqual(expected?.efficiency ?? null);
    }
  });
});

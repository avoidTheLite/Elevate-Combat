import { describe, expect, it } from 'vitest';
import { buildWorld } from '../grid.ts';
import type { Army, Team } from '../types.ts';
import {
  calculateTerritorialIncome,
  projectGameTerritorialControl,
  projectTerritorialControl,
  territorialClaimCounts,
  territoryIncome,
  type TerritorialControl,
  type TerritorialHolderFact,
  type TerritorialNodeFact,
} from './control.ts';

const mainHexIds = ['0,0', '1,0', '2,0'];
const node = (owner: Team | null, mainHexId = '0,0'): TerritorialNodeFact => ({
  id: `node/${mainHexId}`,
  mainHexId,
  owner,
});
const holder = (team: Team, mainHexId = '0,0', id: string = team): TerritorialHolderFact => ({
  id,
  mainHexId,
  team,
  livingUnitIds: [`unit/${id}`],
});
const project = (owner: Team | null, teams: readonly Team[]): TerritorialControl =>
  projectTerritorialControl({
    mainHexIds,
    nodes: [node(owner)],
    holders: teams.map((team) => holder(team)),
  });

describe('territorial claim projection', () => {
  it.each<{
    owner: Team | null;
    teams: Team[];
    claim: Team | null;
    contested: boolean;
  }>([
    { owner: null, teams: [], claim: null, contested: false },
    { owner: null, teams: ['A'], claim: 'A', contested: false },
    { owner: null, teams: ['B'], claim: 'B', contested: false },
    { owner: null, teams: ['A', 'B'], claim: null, contested: true },
    { owner: 'A', teams: [], claim: 'A', contested: false },
    { owner: 'A', teams: ['A'], claim: 'A', contested: false },
    { owner: 'A', teams: ['B'], claim: 'A', contested: true },
    { owner: 'A', teams: ['A', 'B'], claim: 'A', contested: true },
    { owner: 'B', teams: [], claim: 'B', contested: false },
    { owner: 'B', teams: ['A'], claim: 'B', contested: true },
    { owner: 'B', teams: ['B'], claim: 'B', contested: false },
    { owner: 'B', teams: ['A', 'B'], claim: 'B', contested: true },
  ])('node $owner, presence $teams => claim $claim, contested $contested', (test) => {
    expect(project(test.owner, test.teams)['0,0']).toEqual({
      mainHexId: '0,0',
      nodeOwner: test.owner,
      presentTeams: test.teams,
      claim: test.claim,
      contested: test.contested,
    });
  });

  it('capture flips claim while opposing troops remain; raze leaves opposing troops unclaimed', () => {
    const before = project('A', ['A', 'B']);
    const captured = project('B', ['A', 'B']);
    const razed = project(null, ['A', 'B']);
    expect(before['0,0'].claim).toBe('A');
    expect(captured['0,0']).toMatchObject({ claim: 'B', contested: true });
    expect(razed['0,0']).toMatchObject({ nodeOwner: null, claim: null, contested: true });
    expect(territoryIncome(razed, 'A')).toBe(0);
    expect(territoryIncome(razed, 'B')).toBe(0);
  });

  it('unowned sole presence claims, and leaving after raze returns the tile to neutral', () => {
    const occupied = project(null, ['B']);
    const abandoned = projectTerritorialControl({ mainHexIds, nodes: [], holders: [] });
    expect(occupied['0,0']).toMatchObject({ claim: 'B', presentTeams: ['B'], contested: false });
    expect(abandoned['0,0']).toMatchObject({
      nodeOwner: null,
      claim: null,
      presentTeams: [],
      contested: false,
    });
  });

  it('ignores empty holder presence while retaining owned-node claim', () => {
    const control = projectTerritorialControl({
      mainHexIds,
      nodes: [node('A')],
      holders: [{ ...holder('B'), livingUnitIds: [] }],
    });
    expect(control['0,0']).toMatchObject({ claim: 'A', presentTeams: [], contested: false });
  });

  it('is deterministic under fact reordering and leaves inputs unchanged', () => {
    const input = {
      mainHexIds: [...mainHexIds],
      nodes: [node('A'), node('B', '1,0')],
      holders: [holder('B'), holder('A')],
    };
    const original = structuredClone(input);
    const expected = projectTerritorialControl(input);
    expect(
      projectTerritorialControl({
        mainHexIds: [...input.mainHexIds].reverse(),
        nodes: [...input.nodes].reverse(),
        holders: [...input.holders].reverse(),
      }),
    ).toEqual(expected);
    expect(input).toEqual(original);
    expect(JSON.parse(JSON.stringify(expected))).toEqual(expected);
  });
});

describe('territory income, score and elimination share claim counts', () => {
  const control = projectTerritorialControl({
    mainHexIds,
    nodes: [node('A')],
    holders: [holder('B'), holder('B', '1,0', 'B/second')],
  });

  it('counts contested owned nodes and uncontested presence, using neither retained owner nor supply', () => {
    const counts = territorialClaimCounts(control);
    expect(counts).toEqual({ A: 1, B: 1, unclaimed: 1 });
    expect(control['0,0'].contested).toBe(true);
    for (const team of ['A', 'B'] as const) {
      expect(territoryIncome(control, team)).toBe(counts[team]);
      expect(calculateTerritorialIncome(control, team).cp).toBe(3 + counts[team]);
    }
  });

  it('disconnected/ineligible node income does not remove territorial CP or the base grant', () => {
    const payment = calculateTerritorialIncome(control, 'A', [
      {
        sourceId: 'disconnected-building',
        value: 100,
        active: true,
        eligible: false,
      },
    ]);
    expect(payment.cp).toBe(4);
    expect(payment.appliedSources).toEqual(['territory/0,0']);
  });

  it('adds qualified active building income and floors once after exact contributions', () => {
    const payment = calculateTerritorialIncome(control, 'A', [
      { sourceId: 'forge', value: { decimal: '0.7' }, active: true, eligible: true },
      { sourceId: 'market', value: 0.2, active: true, eligible: true },
      { sourceId: 'node', value: 0.1, active: true, eligible: true },
      { sourceId: 'ruined', value: 100, active: false, eligible: true },
    ]);
    expect(payment.cp).toBe(5);
    expect(payment.exactTotal.decimal).toBe('5');
    expect(payment.exactDiscardedFraction.decimal).toBe('0');
  });

  it('keeps only the base grant when all tiles are unclaimed', () => {
    const neutral = project(null, ['A', 'B']);
    expect(territorialClaimCounts(neutral)).toEqual({ A: 0, B: 0, unclaimed: 3 });
    expect(calculateTerritorialIncome(neutral, 'A').cp).toBe(3);
  });
});

describe('strategic holder adapter', () => {
  const world = buildWorld({ mainCols: 3, mainRows: 3, subRadius: 2 });
  const strategicHolder = (team: Team, hp: number, id: string = team): Army => ({
    id,
    team,
    kind: 'garrison',
    at: '0,0',
    pos: '0,0',
    movesLeft: 0,
    units: [{ id: `unit/${id}`, typeId: 'unused', label: 'Guard', hp }],
  });

  it('uses actual living troops plus explicit nodes, ignoring old MainHex owners', () => {
    const state = {
      armies: [strategicHolder('A', 0), strategicHolder('B', 1)],
      hexes: { '0,0': { owner: 'A' as const, warning: 0 } },
    };
    const control = projectGameTerritorialControl(state, world, []);
    expect(control['0,0']).toMatchObject({ claim: 'B', presentTeams: ['B'], contested: false });
    expect(projectGameTerritorialControl(state, world, [node('A')])['0,0']).toMatchObject({
      nodeOwner: 'A',
      claim: 'A',
      presentTeams: ['B'],
      contested: true,
    });
  });

  it('rejects a stale holder MainHex instead of assigning its presence to the wrong tile', () => {
    const army = { ...strategicHolder('A', 1), at: '1,0' };
    expect(() => projectGameTerritorialControl({ armies: [army] }, world, [])).toThrow(
      'position/MainHex mismatch',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects corrupt HP %s', (hp) => {
    expect(() =>
      projectGameTerritorialControl({ armies: [strategicHolder('A', hp)] }, world, []),
    ).toThrow('Invalid unit HP');
  });

  it('rejects duplicate IDs even when one duplicated unit is dead', () => {
    const armies = [strategicHolder('A', 0), strategicHolder('B', 1)];
    armies[1].units[0].id = armies[0].units[0].id;
    expect(() => projectGameTerritorialControl({ armies }, world, [])).toThrow('Duplicate unit ID');
  });
});

describe('invalid territorial facts fail closed', () => {
  const valid = (): Parameters<typeof projectTerritorialControl>[0] => ({
    mainHexIds,
    nodes: [node('A')],
    holders: [holder('B')],
  });

  it.each([
    () => ({ ...valid(), mainHexIds: ['0,0', '0,0'] }),
    () => ({
      ...valid(),
      nodes: [node('A'), node('B', '1,0')].map((n) => ({ ...n, id: 'duplicate' })),
    }),
    () => ({ ...valid(), nodes: [node('A'), { ...node('B'), id: 'second' }] }),
    () => ({ ...valid(), nodes: [node('A', '99,99')] }),
    () => ({ ...valid(), nodes: [{ ...node('A'), owner: 'C' as Team }] }),
    () => ({ ...valid(), holders: [holder('A'), holder('A')] }),
    () => ({ ...valid(), holders: [holder('A'), { ...holder('B'), livingUnitIds: ['unit/A'] }] }),
    () => ({ ...valid(), holders: [{ ...holder('A'), livingUnitIds: [''] }] }),
    () => ({ ...valid(), holders: [holder('A', '99,99')] }),
    () => ({ ...valid(), holders: [{ ...holder('A'), team: 'C' as Team }] }),
  ])('rejects malformed, duplicate or unknown facts %#', (input) => {
    expect(() => projectTerritorialControl(input())).toThrow();
  });

  it('rejects a forged projection before score or income can consume it', () => {
    const forged = structuredClone(project('A', ['B']));
    forged['0,0'].claim = 'B';
    expect(() => territorialClaimCounts(forged)).toThrow('does not match');
    expect(() => territoryIncome(forged, 'B')).toThrow('does not match');
    expect(() => calculateTerritorialIncome(forged, 'B')).toThrow('does not match');
  });

  it('rejects invalid income teams and non-finite building amounts', () => {
    expect(() => territoryIncome(project(null, []), 'C' as Team)).toThrow('Invalid income team');
    expect(() =>
      calculateTerritorialIncome(project(null, []), 'A', [
        {
          sourceId: 'building',
          value: Number.POSITIVE_INFINITY,
          active: true,
          eligible: true,
        },
      ]),
    ).toThrow();
  });
});

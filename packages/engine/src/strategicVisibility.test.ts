import { describe, expect, it, vi } from 'vitest';
import { apply } from './actions.ts';
import { hexDistance, hexKey } from './hex.ts';
import { mainNeighbors } from './grid.ts';
import type { MainCell, World } from './grid.ts';
import { lineOfSight } from './los.ts';
import * as los from './los.ts';
import {
  COMMAND,
  createGame,
  defaultSettings,
  refreshOwnershipKnowledge,
  setHolderPos,
  strategicVisibleCells,
  strategicVisibleMains,
  visibleArmies,
  worldOf,
} from './strategic.ts';
import { deserializeSave, SAVE_SCHEMA, serializeSave, validateGameState } from './save.ts';
import type { Army, GameState } from './types.ts';

function fixture(): GameState {
  const state = createGame({
    ...defaultSettings(),
    seed: 892143,
    grid: { mainCols: 7, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human', B: 'human' },
  });
  const { world, terrain } = worldOf(state);
  // An isolated seed's flat terrain makes exact sight-boundary cases readable.
  terrain.heights.fill(1);
  for (const main of Object.values(state.hexes)) main.owner = null;
  state.armies = state.armies.filter((holder) => holder.kind === 'commander');
  for (const team of ['A', 'B'] as const) {
    const holder = state.armies.find((army) => army.team === team)!;
    const main = world.mains.find((cell) => cell.col === (team === 'A' ? 0 : 6) && cell.row === 1)!;
    setHolderPos(world, holder, hexKey(main.center));
  }
  state.ownershipKnowledge = { A: {}, B: {} };
  return state;
}

function step(state: GameState, action: Parameters<typeof apply>[1]): GameState {
  const result = apply(state, action);
  expect(result.error).toBeNull();
  return result.state;
}

function edgeObservation(): {
  state: GameState;
  world: World;
  eye: Army;
  target: MainCell;
  edge: string;
  back: string;
} {
  const state = fixture();
  const { world } = worldOf(state);
  const eye = state.armies.find((army) => army.team === 'A')!;
  const home = world.mainByKey.get(eye.at)!;
  const target = world.mains.find((main) => main.col === 2 && main.row === 1)!;
  const distance = (key: string): number =>
    hexDistance(world.subByKey.get(key)!.hex, target.center);
  const edge = [...home.subKeys].sort((a, b) => distance(a) - distance(b))[0]!;
  setHolderPos(world, eye, edge);
  const back = home.subKeys.find(
    (key) =>
      hexDistance(world.subByKey.get(key)!.hex, world.subByKey.get(edge)!.hex) === 1 &&
      distance(key) > distance(edge),
  )!;
  return { state, world, eye, target, edge, back };
}

describe('GAMES-ELEVATE-WORLD-UC-002: strategic ownership observations', () => {
  it('uses the existing holder LOS/range and territory adjacency for actual tile visibility', () => {
    const state = fixture();
    const { world, terrain } = worldOf(state);
    const eye = state.armies.find((army) => army.team === 'A')!;
    const foe = state.armies.find((army) => army.team === 'B')!;
    const cells = strategicVisibleCells(state, 'A');
    expect(cells.has(eye.pos)).toBe(true);
    expect(cells.has(foe.pos)).toBe(false);
    expect(visibleArmies(state, 'A').map((holder) => holder.id)).toEqual([eye.id]);
    const near = world.subs.find(
      (cell) => hexDistance(cell.hex, world.subByKey.get(eye.pos)!.hex) === 3,
    )!;
    expect(cells.has(near.key)).toBe(true);
    // Pick the exact LOS interior rather than relying on a neighboring ridge.
    const ray = lineOfSight(world.subByKey.get(eye.pos)!.hex, near.hex, () => 1, COMMAND.sightEye);
    const ridge = world.subByKey.get(hexKey(ray.path[1]!))!;
    terrain.heights[ridge.index] = 9;
    expect(strategicVisibleCells(state, 'A').has(near.key)).toBe(false);
    state.hexes[mainNeighbors(world, foe.at)[0]!.key]!.owner = 'A';
    expect(strategicVisibleCells(state, 'A').has(foe.pos)).toBe(true);
    expect(visibleArmies(state, 'A').some((holder) => holder.id === foe.id)).toBe(true);
    state.settings.fog = false;
    expect(strategicVisibleCells(state, 'A').size).toBe(world.subs.length);
  });

  it('learns a MainHex from one visible edge tile without requiring its center or an enemy unit', () => {
    const { state, target } = edgeObservation();
    const cells = strategicVisibleCells(state, 'A');
    expect(cells.has(hexKey(target.center))).toBe(false);
    expect(target.subKeys.some((key) => cells.has(key))).toBe(true);
    expect(strategicVisibleMains(state, 'A').has(target.key)).toBe(true);
    refreshOwnershipKnowledge(state);
    expect(Object.hasOwn(state.ownershipKnowledge!.A, target.key)).toBe(true);
    expect(state.ownershipKnowledge!.A[target.key]).toBeNull();
  });

  it('retains the prior owner during hidden changes and updates both players only after resighting', () => {
    const { state: initial, world, eye, target, edge, back } = edgeObservation();
    const foe = initial.armies.find((army) => army.team === 'B')!;
    setHolderPos(world, foe, hexKey(target.center));
    refreshOwnershipKnowledge(initial);
    let state = step(initial, { type: 'moveCommander', armyId: eye.id, dest: back });
    expect(strategicVisibleMains(state, 'A').has(target.key)).toBe(false);
    expect(state.ownershipKnowledge!.A[target.key]).toBeNull();
    state = step(state, { type: 'endTurn' });
    const foeDestination = target.subKeys.find(
      (key) => hexDistance(world.subByKey.get(key)!.hex, target.center) === 1,
    )!;
    state = step(state, { type: 'moveCommander', armyId: foe.id, dest: foeDestination });
    expect(state.hexes[target.key]!.owner).toBe('B');
    expect(state.ownershipKnowledge!.A[target.key]).toBeNull();
    expect(state.ownershipKnowledge!.B[target.key]).toBe('B');
    const saved = deserializeSave(serializeSave(state));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.save.state).toEqual(state);
    state = step(saved.save.state, { type: 'endTurn' });
    state = step(state, { type: 'moveCommander', armyId: eye.id, dest: edge });
    expect(state.ownershipKnowledge!.A[target.key]).toBe('B');
    // Ownership discovery does not create persistent discovery of the commander.
    state = step(state, { type: 'moveCommander', armyId: eye.id, dest: back });
    expect(visibleArmies(state, 'A').some((holder) => holder.team === 'B')).toBe(false);
  });

  it('keeps unknown distinct from observed neutral, and initializes old saves from current visibility only', () => {
    const state = fixture();
    const { world } = worldOf(state);
    const hidden = world.mains.find((main) => main.col === 6 && main.row === 2)!;
    state.hexes[hidden.key]!.owner = 'B';
    delete state.ownershipKnowledge;
    const before = structuredClone(state);
    const envelope = JSON.parse(serializeSave(state));
    envelope.schema = 4;
    const restored = deserializeSave(JSON.stringify(envelope));
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.save.schema).toBe(SAVE_SCHEMA);
    expect(Object.hasOwn(restored.save.state.ownershipKnowledge!.A, hidden.key)).toBe(false);
    expect(Object.values(restored.save.state.ownershipKnowledge!.A)).toContain(null);
    const unchanged = structuredClone(restored.save.state);
    delete unchanged.ownershipKnowledge;
    expect(unchanged).toEqual(before);
    expect(state).toEqual(before);
    expect(restored.migrated.join(' ')).toMatch(/unseen ownership remains unknown/);
  });

  it('does not mutate knowledge for pure queries, rejected orders, or pending battle cancellation', () => {
    const state = fixture();
    const [attacker, defender] = state.armies;
    state.phase = 'battle-pending';
    state.pending = {
      attackerArmyId: attacker!.id,
      defenderArmyId: defender!.id,
      origin: attacker!.at,
      target: defender!.at,
    };
    const before = structuredClone(state);
    strategicVisibleCells(state, 'A');
    strategicVisibleMains(state, 'B');
    const refused = apply(state, {
      type: 'moveCommander',
      armyId: attacker!.id,
      dest: defender!.pos,
    });
    expect(refused.error).not.toBeNull();
    expect(refused.state).toBe(state);
    const cancelled = step(state, { type: 'cancelBattle' });
    expect(cancelled.ownershipKnowledge).toEqual(state.ownershipKnowledge);
    expect(state).toEqual(before);
  });

  it('casts no LOS rays when a commit changes no strategic sight or ownership inputs', () => {
    const state = fixture();
    refreshOwnershipKnowledge(state);
    const next = structuredClone(state);
    next.cp.A += 1;
    next.active = 'B';
    const spy = vi.spyOn(los, 'lineOfSight');
    try {
      refreshOwnershipKnowledge(next, state);
      expect(spy).not.toHaveBeenCalled();
      expect(next.ownershipKnowledge).toEqual(state.ownershipKnowledge);
      next.hexes[next.hq.B]!.owner = 'B';
      refreshOwnershipKnowledge(next, state);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { A: {}, B: {}, C: {} },
    { A: {} },
    { A: { '999,999': 'A' }, B: {} },
    { A: { '0,0': 'UNKNOWN' }, B: {} },
    { A: [], B: {} },
  ])('rejects malformed ownership knowledge without repairing it: %j', (knowledge) => {
    const state = fixture();
    const raw = { ...state, ownershipKnowledge: knowledge };
    expect(validateGameState(raw).some((error) => error.startsWith('ownershipKnowledge'))).toBe(
      true,
    );
    expect(
      deserializeSave(
        JSON.stringify({ format: 'iron-ridge-save', schema: SAVE_SCHEMA, state: raw }),
      ).ok,
    ).toBe(false);
  });
});

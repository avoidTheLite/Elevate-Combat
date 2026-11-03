import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from '@iron-ridge/engine';
import {
  commanderReach,
  apply,
  constructCampaignNodeRequest,
  createGame,
  hexDistance,
  refreshCampaignNodeSnapshot,
  setHolderPos,
  validateGameState,
  worldOf,
} from '@iron-ridge/engine';
import type { UiState } from '../stores/useGameStore.ts';
import { useGameStore } from '../stores/useGameStore.ts';
import { strategicClick } from './strategicClick.ts';
import { alphaGarrison, bravoInRange, commanderOf, strategicGame } from './testGames.ts';
import { regularPlaytestSettings } from './campaignScenarios.ts';
import { holderForClick } from './holders.ts';
import { buildStrategicScene, REACH_COLOR } from '../render/buildScene.ts';

function load(game: GameState): void {
  useGameStore.getState().quit();
  useGameStore.setState({ game });
}

const ui = (): UiState => useGameStore.getState().ui;
const game = (): GameState => useGameStore.getState().game!;

beforeEach(() => localStorage.clear());

/** A valid owned node whose persistent garrison was emptied after recruitment. */
function emptyNodeGarrison(withGarrison = true): GameState {
  let g = createGame({
    ...regularPlaytestSettings(),
    controllers: { A: 'human', B: 'human' },
    fog: false,
  });
  const site = g.infrastructure!.sites.find(
    (candidate) => candidate.homeTeam === null && !g.armies.some((a) => a.at === candidate.mainHex),
  )!;
  const commander = commanderOf(g, 'A');
  setHolderPos(worldOf(g).world, commander, site.annexSubHexes[0]!);
  refreshCampaignNodeSnapshot(g);
  const activated = apply(g, {
    type: 'nodeWork',
    request: constructCampaignNodeRequest(g, {
      kind: 'activate',
      nodeId: site.nodeId,
      commanderId: commander.id,
      centerDefinitionId: 'generic',
    }),
  });
  expect(activated.error).toBeNull();
  g = activated.state;
  if (withGarrison)
    g.armies.push({
      id: 'empty-node-garrison',
      kind: 'garrison',
      building: 'node',
      nodeId: site.nodeId,
      team: 'A',
      at: site.mainHex,
      pos: site.centerSubHex,
      movesLeft: 0,
      units: [],
    });
  refreshCampaignNodeSnapshot(g);
  expect(validateGameState(g)).toEqual([]);
  return g;
}

describe('strategic map clicks', () => {
  it('an owned node center without a garrison inspects the node without moving or spending steps', () => {
    load(emptyNodeGarrison(false));
    const start = commanderOf(game(), 'A');
    const node = game().infrastructure!.capture.nodes.find(
      (n) => n.owner === 'A' && n.mainHex === start.at,
    )!;
    const before = game();
    strategicClick(start.pos);
    const scene = buildStrategicScene(game(), { ...ui(), hoverCell: node.centerSubHex }, null);
    expect(scene.path).toEqual([]);
    expect(scene.overlays.filter((o) => o.color === REACH_COLOR).map((o) => o.key)).not.toContain(
      node.centerSubHex,
    );
    strategicClick(node.centerSubHex);
    expect(ui().selectedArmy).toBeNull();
    expect(ui().selectedMain).toBe(node.mainHex);
    expect(game()).toBe(before);
  });

  it('an empty friendly node center selects its garrison and previews no move', () => {
    load(emptyNodeGarrison());
    const node = game().armies.find((a) => a.id === 'empty-node-garrison')!;
    const before = game();
    strategicClick(commanderOf(game(), 'A').pos);
    const scene = buildStrategicScene(game(), { ...ui(), hoverCell: node.pos }, null);
    expect(scene.path).toEqual([]);
    expect(scene.overlays.filter((o) => o.color === REACH_COLOR).map((o) => o.key)).not.toContain(
      node.pos,
    );
    strategicClick(node.pos);
    expect(ui().selectedArmy).toBe(node.id);
    expect(game()).toBe(before);
  });

  it('a commander on an empty friendly node center takes selection priority over the garrison', () => {
    load(emptyNodeGarrison());
    const node = game().armies.find((a) => a.id === 'empty-node-garrison')!;
    const commander = commanderOf(game(), 'A');
    setHolderPos(worldOf(game()).world, commander, node.pos);
    refreshCampaignNodeSnapshot(game());
    expect(validateGameState(game())).toEqual([]);
    expect(holderForClick(game(), null, node.pos)?.id).toBe(commander.id);
    strategicClick(node.pos);
    expect(ui().selectedArmy).toBe(commander.id);
  });

  it('an empty enemy node center remains a movement destination and permits Capture Node', () => {
    load(emptyNodeGarrison());
    const node = game().armies.find((a) => a.id === 'empty-node-garrison')!;
    const site = game().infrastructure!.sites.find((s) => s.nodeId === node.nodeId)!;
    // Clear the defender from the node before the other human side approaches it.
    setHolderPos(worldOf(game()).world, commanderOf(game(), 'A'), alphaGarrison(game()).pos);
    refreshCampaignNodeSnapshot(game());
    expect(useGameStore.getState().dispatch({ type: 'endTurn' })).toBe(true);
    const commander = commanderOf(game(), 'B');
    setHolderPos(worldOf(game()).world, commander, site.annexSubHexes[0]!);
    refreshCampaignNodeSnapshot(game());
    expect(validateGameState(game())).toEqual([]);
    const startMoves = commander.movesLeft;
    const startCp = game().cp.B;
    expect(
      hexDistance(
        worldOf(game()).world.subByKey.get(commander.pos)!.hex,
        worldOf(game()).world.subByKey.get(node.pos)!.hex,
      ),
    ).toBe(1);
    expect(holderForClick(game(), null, node.pos)).toBeUndefined();
    strategicClick(commander.pos);
    strategicClick(node.pos);
    expect(commanderOf(game(), 'B')).toMatchObject({ pos: node.pos, movesLeft: startMoves - 1 });
    expect(game().cp.B).toBe(startCp);
    expect(game().infrastructure!.capture.pending?.event.kind).toBe('strategic-movement');
    expect(
      useGameStore.getState().dispatch({
        type: 'captureChoice',
        nodeId: site.nodeId,
        outcome: 'capture',
      }),
    ).toBe(true);
    expect(useGameStore.getState().dispatch({ type: 'captureCommit' })).toBe(true);
    expect(game().infrastructure!.capture.nodes.find((n) => n.id === site.nodeId)?.owner).toBe('B');
    expect(game().cp.B).toBe(startCp - 5);
    expect(validateGameState(game())).toEqual([]);
  });

  it('an unowned node center remains a movement destination', () => {
    load(createGame(regularPlaytestSettings()));
    const site = game().infrastructure!.sites.find((s) => s.homeTeam === null)!;
    const commander = commanderOf(game(), 'A');
    setHolderPos(worldOf(game()).world, commander, site.annexSubHexes[0]!);
    refreshCampaignNodeSnapshot(game());
    expect(validateGameState(game())).toEqual([]);
    const beforeMoves = commander.movesLeft;
    const beforeCp = game().cp.A;
    strategicClick(commander.pos);
    strategicClick(site.centerSubHex);
    expect(commanderOf(game(), 'A')).toMatchObject({
      pos: site.centerSubHex,
      movesLeft: beforeMoves - 1,
    });
    expect(game().cp.A).toBe(beforeCp);
  });

  it.each(['classic', 'ready'] as const)(
    '%s: commander → HQ → original cell selects holders without moving or spending steps',
    (preset) => {
      load(preset === 'ready' ? createGame(regularPlaytestSettings()) : strategicGame(true));
      const start = structuredClone(commanderOf(game(), 'A'));
      const hq = alphaGarrison(game());
      strategicClick(start.pos);
      strategicClick(hq.pos);
      expect({
        selected: ui().selectedArmy,
        pos: commanderOf(game(), 'A').pos,
        moves: commanderOf(game(), 'A').movesLeft,
      }).toEqual({
        selected: hq.id,
        pos: start.pos,
        moves: start.movesLeft,
      });
      strategicClick(start.pos);
      expect({
        selected: ui().selectedArmy,
        pos: commanderOf(game(), 'A').pos,
        moves: commanderOf(game(), 'A').movesLeft,
      }).toEqual({
        selected: start.id,
        pos: start.pos,
        moves: start.movesLeft,
      });
    },
  );

  it('a reachable HQ building ring selects its garrison without moving the selected commander', () => {
    load(strategicGame(true));
    const start = structuredClone(commanderOf(game(), 'A'));
    const hq = alphaGarrison(game());
    const { world } = worldOf(game());
    const center = world.subByKey.get(hq.pos)!;
    const ring = [...commanderReach(game(), start).keys()].find(
      (key) => key !== start.pos && hexDistance(world.subByKey.get(key)!.hex, center.hex) === 1,
    )!;
    expect(ring).toBeDefined();
    strategicClick(start.pos);
    strategicClick(ring);
    expect(ui().selectedArmy).toBe(hq.id);
    expect(commanderOf(game(), 'A')).toEqual(start);
  });

  it('clicking a commander selects it; clicking a reachable cell moves it there', () => {
    load(strategicGame(true));
    const a = commanderOf(game(), 'A');
    strategicClick(a.pos);
    expect(ui().selectedArmy).toBe(a.id);
    const dest = [...commanderReach(game(), a).entries()].find(([, n]) => n === 2)![0];
    strategicClick(dest);
    const moved = commanderOf(game(), 'A');
    expect(moved.pos).toBe(dest);
    expect(moved.movesLeft).toBe(a.movesLeft - 2);
    expect(ui().selectedArmy).toBe(a.id); // still selected: steps remain
  });

  it('after a confirmed move across main hexes, the selected main follows the authoritative position', () => {
    load(strategicGame(true));
    const start = structuredClone(commanderOf(game(), 'A'));
    const dest = [...commanderReach(game(), start).keys()].find(
      (key) =>
        worldOf(game()).world.subByKey.get(key)!.main !== start.at &&
        !holderForClick(game(), 'A', key),
    )!;
    expect(dest).toBeDefined();
    strategicClick(start.pos);
    strategicClick(dest);
    const moved = commanderOf(game(), 'A');
    expect(moved.pos).toBe(dest);
    expect(ui().selectedMain).toBe(moved.at);
    expect(ui().selectedMain).not.toBe(start.at);
  });

  it('rapid switching between commanders and HQs never moves either holder', () => {
    load(createGame(regularPlaytestSettings()));
    const first = commanderOf(game(), 'A');
    const { world } = worldOf(game());
    const cell = world.subs.find(
      (candidate) =>
        candidate.main !== first.at &&
        !game().armies.some((holder) => holder.pos === candidate.key),
    )!;
    const second = structuredClone(first);
    second.id = 'A-extra';
    second.units = [first.units.pop()!];
    setHolderPos(world, second, cell.key);
    game().armies.push(second);
    const before = structuredClone(game());
    const hq = alphaGarrison(game());
    for (let i = 0; i < 10; i++) {
      for (const holder of [first, hq, second, hq, first]) {
        strategicClick(holder.pos);
        expect(ui().selectedArmy).toBe(holder.id);
        expect(ui().selectedMain).toBe(holder.at);
        expect(game()).toEqual(before);
      }
    }
    expect(validateGameState(game())).toEqual([]);
  });

  it('rejected moves and invalid clicks preserve authoritative position and the movement budget', () => {
    load(strategicGame(true));
    const start = structuredClone(commanderOf(game(), 'A'));
    strategicClick(start.pos);
    strategicClick('999,999');
    expect(ui().selectedArmy).toBe(start.id);
    for (const dest of [start.pos, '999,999', alphaGarrison(game()).pos]) {
      expect(
        useGameStore.getState().dispatch({ type: 'moveCommander', armyId: start.id, dest }),
      ).toBe(false);
      expect(commanderOf(game(), 'A')).toEqual(start);
    }
    const far = commanderOf(game(), 'B').pos;
    expect(
      useGameStore.getState().dispatch({ type: 'moveCommander', armyId: start.id, dest: far }),
    ).toBe(false);
    expect(commanderOf(game(), 'A')).toEqual(start);
  });

  it('confirmed out-and-back movement pays both route costs from the current position', () => {
    load(strategicGame(true));
    const { world } = worldOf(game());
    const away = world.mains.find((main) => main.key !== game().hq.A && main.key !== game().hq.B)!;
    setHolderPos(
      world,
      commanderOf(game(), 'A'),
      world.subs.find((cell) => cell.main === away.key && !holderForClick(game(), 'A', cell.key))!
        .key,
    );
    const start = structuredClone(commanderOf(game(), 'A'));
    const dest = [...commanderReach(game(), start).entries()].find(
      ([key, steps]) => steps === 2 && !holderForClick(game(), 'A', key),
    )![0];
    strategicClick(start.pos);
    strategicClick(dest);
    expect(commanderOf(game(), 'A')).toMatchObject({ pos: dest, movesLeft: start.movesLeft - 2 });
    strategicClick(start.pos);
    expect(commanderOf(game(), 'A')).toMatchObject({
      pos: start.pos,
      at: start.at,
      movesLeft: start.movesLeft - 4,
    });
  });

  it('turn changes clear selection; delayed clicks do not move the previous side', () => {
    const initial = strategicGame(false);
    initial.settings.controllers.B = 'human';
    load(initial);
    const start = structuredClone(commanderOf(game(), 'A'));
    const dest = [...commanderReach(game(), start).keys()].find(
      (key) => key !== start.pos && !holderForClick(game(), null, key),
    )!;
    strategicClick(start.pos);
    expect(useGameStore.getState().dispatch({ type: 'endTurn' })).toBe(true);
    expect(ui().selectedArmy).toBeNull();
    const afterTurn = structuredClone(game());
    strategicClick(dest);
    expect(game()).toEqual(afterTurn);
    expect(commanderOf(game(), 'A')).toEqual(start);
  });

  it('save/load and quit clear the selection without committing a hovered destination', () => {
    load(strategicGame(true));
    const start = structuredClone(commanderOf(game(), 'A'));
    const dest = [...commanderReach(game(), start).keys()].find(
      (key) => key !== start.pos && !holderForClick(game(), 'A', key),
    )!;
    strategicClick(start.pos);
    useGameStore.getState().setUi({ hoverCell: dest });
    expect(useGameStore.getState().saveToSlot('slot1')).toBe(true);
    strategicClick(dest);
    expect(commanderOf(game(), 'A').pos).toBe(dest);
    expect(useGameStore.getState().loadSlot('slot1')).toBe(true);
    expect(ui().selectedArmy).toBeNull();
    expect(ui().hoverCell).toBeNull();
    strategicClick(dest);
    expect(commanderOf(game(), 'A')).toEqual(start);
    useGameStore.getState().quit();
    strategicClick(dest);
    expect(useGameStore.getState().game).toBeNull();
  });

  it('clicking an engageable enemy opens the battle-pending flow', () => {
    load(bravoInRange(strategicGame(false)));
    const a = commanderOf(game(), 'A');
    const b = commanderOf(game(), 'B');
    strategicClick(a.pos);
    strategicClick(b.pos);
    expect(game().phase).toBe('battle-pending');
    expect(game().pending).toMatchObject({ attackerArmyId: a.id, defenderArmyId: b.id });
  });

  it('clicking the HQ building selects the garrison; elsewhere selects just the hex', () => {
    load(strategicGame(true));
    const g = alphaGarrison(game());
    strategicClick(g.pos);
    expect(ui().selectedArmy).toBe(g.id);
    expect(ui().selectedMain).toBe(g.at);
    const { world } = worldOf(game());
    const far = world.mains.find((m) => m.key !== game().hq.A && m.key !== game().hq.B)!;
    strategicClick(far.subKeys[0]!);
    expect(ui().selectedMain).toBe(far.key);
    expect(ui().selectedArmy).toBeNull();
  });

  it('under fog an unseen enemy cannot be selected', () => {
    load(strategicGame(true));
    const b = commanderOf(game(), 'B');
    strategicClick(b.pos);
    expect(ui().selectedArmy).toBeNull();
    expect(ui().selectedMain).toBe(b.at);
  });
});

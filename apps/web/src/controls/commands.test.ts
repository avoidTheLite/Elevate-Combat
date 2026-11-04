import { beforeEach, describe, expect, it } from 'vitest';
import type { BattleUnit, GameState } from '@iron-ridge/engine';
import type { UiState } from '../stores/useGameStore.ts';
import {
  apply,
  constructCampaignNodeRequest,
  contextFor,
  createGame,
  reachable,
  refreshCampaignNodeSnapshot,
  setHolderPos,
  validateGameState,
  worldOf,
} from '@iron-ridge/engine';
import { actorActions, commandAt, pendingValid, selectableAt } from './commands.ts';
import { createMovementDemo, movementDemoFocus, isMovementDemo } from './demoScenario.ts';
import { useGameStore } from '../stores/useGameStore.ts';
import { commanderOf } from '../lib/testGames.ts';
import { regularPlaytestSettings } from '../lib/campaignScenarios.ts';
import {
  CONTROL_PREFERENCES_KEY,
  DEFAULT_CONTROL_PREFERENCES,
  readControlPreferences,
} from './preferences.ts';

beforeEach(() => {
  localStorage.clear();
  useGameStore.getState().quit();
});

function fixture(): { game: GameState; ui: UiState; rifle: BattleUnit } {
  const game = createMovementDemo();
  const ui = { ...useGameStore.getState().ui, ...movementDemoFocus(game) };
  const rifle = game.battle!.units.find((u) => u.id === ui.selectedUnit)!;
  return { game, ui, rifle };
}

describe('movement command previews use actual engine legality', () => {
  it('prepares a valid, ongoing engine-initialized battle with real move, attack, Dig In, Set Up and Pack Up', () => {
    const { game, ui, rifle } = fixture();
    expect(validateGameState(game)).toEqual([]);
    expect(isMovementDemo(game)).toBe(true);
    expect(game.battle!.winner).toBeNull();
    expect(game.battle!.round).toBe(1);
    const original = structuredClone(game);
    const moveKey = [...reachable(contextFor(game), rifle).keys()].find(
      (key) => key !== rifle.pos,
    )!;
    const move = commandAt(game, ui, moveKey)!;
    expect(move.kind).toBe('move');
    expect(move.path[0]).toBe(rifle.pos);
    expect(move.path.at(-1)).toBe(moveKey);
    const target = game.battle!.units.find(
      (u) => u.team === 'B' && u.typeId === 'ww2_rifle_infantry',
    )!;
    expect(commandAt(game, ui, target.pos!)?.kind).toBe('attack');
    expect(commandAt(game, ui, target.pos!)?.details.join(' ')).toContain('Expected damage');
    const engineer = game.battle!.units.find((u) => u.team === 'A' && u.typeId === 'ww2_engineer')!;
    const dig = actorActions(game, { ...ui, selectedUnit: engineer.id }).find(
      (a) => a.label === 'DIG IN',
    )!;
    const dug = apply(game, dig.action);
    expect(dug.error).toBeNull();
    expect(dug.state.battle!.forts[engineer.pos!]).toBe(1);
    const mg = game.battle!.units.find((u) => u.team === 'A' && u.typeId === 'ww2_machine_gun')!;
    const setup = actorActions(game, { ...ui, selectedUnit: mg.id }).find(
      (a) => a.label === 'SET UP',
    )!;
    const set = apply(game, setup.action);
    expect(set.error).toBeNull();
    const pack = actorActions(set.state, { ...ui, selectedUnit: mg.id }).find(
      (a) => a.label === 'PACK UP',
    )!;
    expect(
      apply(set.state, pack.action).state.battle!.units.find((u) => u.id === mg.id)!.acted,
    ).toBe(true);
    expect(game).toEqual(original);
  });

  it('friendly tile bodies select actual occupants and never allow a forbidden MOVE', () => {
    const { game, ui, rifle } = fixture();
    const friendly = game.battle!.units.find((u) => u.team === 'A' && u.id !== rifle.id)!;
    expect(selectableAt(game, friendly.pos!)).toContainEqual({
      id: friendly.id,
      label: friendly.label,
    });
    expect(commandAt(game, ui, friendly.pos!, 'move')).toBeNull();
  });

  it('offers both real strategic holders on an empty friendly node tile without inventing a unit stack', () => {
    let game = createGame({
      ...regularPlaytestSettings(),
      controllers: { A: 'human', B: 'human' },
      fog: false,
    });
    const holder = commanderOf(game, 'A');
    const site = game.infrastructure!.sites.find((s) => s.homeTeam === null)!;
    setHolderPos(worldOf(game).world, holder, site.annexSubHexes[0]!);
    refreshCampaignNodeSnapshot(game);
    game = apply(game, {
      type: 'nodeWork',
      request: constructCampaignNodeRequest(game, {
        kind: 'activate',
        nodeId: site.nodeId,
        commanderId: holder.id,
        centerDefinitionId: 'generic',
      }),
    }).state;
    const garrison = {
      id: 'empty-node-garrison',
      kind: 'garrison' as const,
      building: 'node' as const,
      nodeId: site.nodeId,
      team: 'A' as const,
      at: site.mainHex,
      pos: site.centerSubHex,
      movesLeft: 0,
      units: [],
    };
    game.armies.push(garrison);
    setHolderPos(worldOf(game).world, commanderOf(game, 'A'), garrison.pos);
    refreshCampaignNodeSnapshot(game);
    expect(validateGameState(game)).toEqual([]);
    expect(selectableAt(game, garrison.pos).map((a) => a.id)).toEqual(
      expect.arrayContaining([holder.id, garrison.id]),
    );
  });

  it('rejects a pending record after selection, source, game revision, phase or session changes', () => {
    const { game, ui, rifle } = fixture();
    const key = [...reachable(contextFor(game), rifle).keys()].find((k) => k !== rifle.pos)!;
    const command = commandAt(game, ui, key)!;
    const pending = { game, command, dragging: false };
    expect(pendingValid(pending, game, ui)).toBe(true);
    expect(pendingValid(pending, game, { ...ui, selectedUnit: null })).toBe(false);
    expect(pendingValid(pending, structuredClone(game), ui)).toBe(false);
    const changed = apply(game, { type: 'endBattleTurn' });
    expect(pendingValid(pending, changed.state, ui)).toBe(false);
  });
});

describe('proposed browser preferences', () => {
  it('defaults to explicit move/attack preview and tolerates malformed storage', () => {
    expect(readControlPreferences()).toEqual(DEFAULT_CONTROL_PREFERENCES);
    localStorage.setItem(CONTROL_PREFERENCES_KEY, '{broken');
    expect(readControlPreferences()).toEqual(DEFAULT_CONTROL_PREFERENCES);
    localStorage.setItem(
      CONTROL_PREFERENCES_KEY,
      JSON.stringify({ quickMove: true, quickAttack: 'yes', dwellMs: -5, overlap: 500 }),
    );
    expect(readControlPreferences()).toMatchObject({
      quickMove: true,
      quickAttack: false,
      dwellMs: 0,
      overlap: 75,
    });
  });
});

// GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002; GAMES-ELEVATE-SESSION-UC-001.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createGame,
  commanderReach,
  deserializeSave,
  hexKey,
  PLAYTEST_BALANCE_RULES,
  serializeSave,
  validateGameState,
  worldOf,
} from '@iron-ridge/engine';
import App from './App.tsx';
import { useBalanceStore } from './balance/store.ts';
import {
  regularPlaytestDocument,
  regularPlaytestSettings,
  parseCampaignConfiguration,
} from './lib/campaignScenarios.ts';
import { useGameStore } from './stores/useGameStore.ts';
import sharedRecipe from '../public/scenarios/strategic-objectives-playtest.json';

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useGameStore.getState().quit();
    useBalanceStore.setState({
      view: 'setup',
      setupSelection: null,
      active: undefined,
      draft: {},
      dirtyCards: {},
    });
  });
});

describe('ready regular strategic-objectives playtest', () => {
  it('uses generated central high ground and equally reachable near objectives, with only five centered sites', () => {
    const settings = regularPlaytestSettings();
    const game = createGame(settings);
    expect(game.infrastructure!.sites).toHaveLength(5);
    expect(
      game
        .infrastructure!.sites.filter((site) => site.homeTeam === null)
        .map((site) => site.mainHex),
    ).toEqual(['0,2', '2,2', '4,2']);
    const { world, terrain } = worldOf(game);
    const center = world.mainByKey.get('2,2')!;
    expect(center).toMatchObject({ col: 3, row: 2 });
    expect(terrain.heights[world.subByKey.get(hexKey(center.center))!.index]).toBe(7);
    for (const team of ['A', 'B'] as const) {
      const holder = game.armies.find((army) => army.team === team && army.kind === 'commander')!;
      // Probe the normal legal strategic BFS over several turns' movement, without moving a holder.
      const reach = commanderReach(game, { ...holder, movesLeft: world.subs.length });
      expect(reach.get(hexKey(center.center))).toBe(26);
      const near = world.mainByKey.get(team === 'A' ? '0,2' : '4,2')!;
      expect(reach.get(hexKey(near.center))).toBe(8);
    }
    for (const site of game.infrastructure!.sites)
      expect(site.centerSubHex).toBe(hexKey(world.mainByKey.get(site.mainHex)!.center));
    expect(validateGameState(game)).toEqual([]);
    expect(createGame(settings)).toEqual(game);
    const loaded = deserializeSave(serializeSave(game));
    expect(loaded.ok && loaded.save.state).toEqual(game);
    expect(parseCampaignConfiguration(JSON.stringify(regularPlaytestDocument()))).toEqual(settings);
    expect(sharedRecipe).toEqual(regularPlaytestDocument());
  });

  it.each([
    ['VS AI', { A: 'human', B: 'ai' }],
    ['HOTSEAT 2P', { A: 'human', B: 'human' }],
    ['AI vs AI', { A: 'ai', B: 'ai' }],
  ])(
    'loads an editable normal setup and starts %s with the same explicit trial rules',
    (opponent, controllers) => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'USE READY PLAYTEST SETUP' }));
      expect(screen.getByRole('button', { name: 'ADVANCED SEEDED NODES' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByLabelText('MAP SEED')).toHaveValue(20261101);
      expect(screen.getByLabelText('NODE PLACEMENT SEED')).toHaveValue(4277);
      expect(screen.getByLabelText('Commander training price (CP)')).toHaveValue(15);
      expect(screen.getByLabelText('Capture Node price (CP)')).toHaveValue(5);
      expect(screen.getByLabelText('Raze Node price (CP)')).toHaveValue(2);
      expect(useBalanceStore.getState().active).toEqual(PLAYTEST_BALANCE_RULES);
      fireEvent.click(screen.getByRole('button', { name: opponent as string }));
      fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
      const game = useGameStore.getState().game!;
      expect(game.settings.controllers).toEqual(controllers);
      expect(game.settings.rules).toEqual(PLAYTEST_BALANCE_RULES);
      expect(game.settings.engagement?.profile).toBe('multi-commander-v1');
      expect(game.infrastructure!.sites).toHaveLength(5);
      expect(game.settings.infrastructure!.nodes.placement).toEqual({
        mode: 'advanced',
        seed: 4277,
        additionalNodes: 3,
      });
      expect(game.turn).toBe(1);
      expect(game.armies.filter((army) => army.kind === 'commander')).toHaveLength(2);
    },
  );

  it('removes preset infrastructure when switching from Ready to Classic before starting', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'USE READY PLAYTEST SETUP' }));
    fireEvent.click(screen.getByRole('button', { name: 'CLASSIC', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
    const game = useGameStore.getState().game!;
    expect(game.settings.infrastructure).toBeUndefined();
    expect(game.infrastructure).toBeUndefined();
    expect(game.settings.rules).toEqual(PLAYTEST_BALANCE_RULES);
    expect(game.settings.commanderTrainingCp).toBe(15);
    expect(screen.getByText(/Classic campaign: recruit at HQ/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Node order')).not.toBeInTheDocument();
  });
});

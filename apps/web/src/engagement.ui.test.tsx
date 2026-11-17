// GAMES-ELEVATE-CAMPAIGN-UC-002 / TACTICAL-UC-001 / SESSION-UC-001.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Army, GameAction, GameState } from '@iron-ridge/engine';
import {
  EXPERIMENTAL_ENGAGEMENT_PROFILE,
  apply,
  buildContext,
  createGame,
  defaultSettings,
  deploymentZone,
  hexDistance,
  mainNeighbors,
  setHolderPos,
  worldOf,
} from '@iron-ridge/engine';
import App from './App.tsx';
import { useBalanceStore } from './balance/store.ts';
import { configurationDocument, parseCampaignConfiguration } from './lib/campaignScenarios.ts';
import { buildTacticalScene } from './render/buildScene.ts';
import { useGameStore } from './stores/useGameStore.ts';

// These tests exercise real rules/actions and React controls; rendering has its own suites/browser proof.
vi.mock('./components/game/SceneView.tsx', () => ({ SceneView: () => null }));

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useGameStore.getState().quit();
    useGameStore.setState({ handoff: null, error: null, aiSpeed: 999_999 });
    useBalanceStore.setState({
      view: 'setup',
      setupSelection: null,
      active: undefined,
      draft: {},
      dirtyCards: {},
      setup: defaultSettings(),
    });
  });
});

function pendingGame(): GameState {
  const game = createGame({
    ...defaultSettings(),
    grid: { mainCols: 5, mainRows: 3, subRadius: 3 },
    fog: false,
    commanderTrainingCp: 11,
    controllers: { A: 'human', B: 'human' },
    engagement: { ...EXPERIMENTAL_ENGAGEMENT_PROFILE },
  });
  const attacker = game.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
  const defender = game.armies.find((army) => army.team === 'B' && army.kind === 'commander')!;
  const { world } = worldOf(game);
  const initial = world.mains.find((main) => main.col === 2 && main.row === 1)!;
  const adjacent = new Set(mainNeighbors(world, initial.key).map((main) => main.key));
  const aCell = world.subs.find(
    (cell) =>
      cell.main === initial.key &&
      world.subs.some(
        (other) => adjacent.has(other.main) && hexDistance(cell.hex, other.hex) === 2,
      ),
  )!;
  const bCell = world.subs.find(
    (cell) => adjacent.has(cell.main) && hexDistance(cell.hex, aCell.hex) === 2,
  )!;
  setHolderPos(world, attacker, aCell.key);
  setHolderPos(world, defender, bCell.key);
  attacker.units = attacker.units.slice(0, 2);
  defender.units = defender.units.slice(0, 2);
  for (const [team, primary, id] of [
    ['A', attacker, 'A-extra'],
    ['B', defender, 'B-extra'],
  ] as const) {
    const cell = world.subs.find(
      (candidate) =>
        candidate.main === primary.at && !game.armies.some((army) => army.pos === candidate.key),
    )!;
    const holder: Army = {
      id,
      team,
      kind: 'commander',
      pos: cell.key,
      at: cell.main,
      movesLeft: 3,
      units: [{ ...primary.units[0]!, id: `${id}-unit`, label: `${id} rifle` }],
    };
    game.armies.push(holder);
  }
  game.cp = { A: 30, B: 30 };
  const opened = apply(game, { type: 'engage', armyId: attacker.id, targetId: defender.id });
  expect(opened.error).toBeNull();
  return opened.state;
}
function load(game: GameState): void {
  act(() => useGameStore.setState({ game, handoff: null }));
}
function dismissHandoff(team: 'ALPHA' | 'BRAVO'): void {
  fireEvent.click(screen.getByRole('button', { name: `I AM ${team} — CONTINUE` }));
}

describe('experimental engagement setup', () => {
  it('is opt-in and survives the validated Battle Lab round trip', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'CREATE CAMPAIGN' }));
    const experimental = screen.getByRole('checkbox', {
      name: 'Experimental multi-commander engagements',
    });
    expect(experimental).not.toBeChecked();
    fireEvent.click(experimental);
    fireEvent.click(screen.getByRole('button', { name: 'ADVANCED SEEDED NODES' }));
    // Blank-price gating remains explicit now that new games default to 15 CP.
    fireEvent.change(screen.getByLabelText('Commander training price (CP)'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: /balance lab/i }));
    expect(screen.getByRole('button', { name: /apply & new game/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /back to setup/i }));
    expect(
      screen.getByRole('checkbox', { name: 'Experimental multi-commander engagements' }),
    ).toBeChecked();
    expect(screen.getByRole('button', { name: 'ADVANCED SEEDED NODES' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.change(screen.getByLabelText('Commander training price (CP)'), {
      target: { value: '11' },
    });
    fireEvent.change(screen.getByLabelText('Capture Node price (CP)'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Raze Node price (CP)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /balance lab/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply & new game/i }));
    const game = useGameStore.getState().game!;
    expect(game.settings.engagement).toEqual(EXPERIMENTAL_ENGAGEMENT_PROFILE);
    expect(game.settings.infrastructure?.nodes.placement?.mode).toBe('advanced');
    expect(game.settings.commanderTrainingCp).toBe(11);
  });

  it('exports the code capability and preserves profile prices while rejecting bad profiles', () => {
    const settings = {
      ...defaultSettings(),
      commanderTrainingCp: 11,
      engagement: { ...EXPERIMENTAL_ENGAGEMENT_PROFILE },
    };
    const doc = configurationDocument(settings);
    expect(doc.requiredCodeCapabilities).toContain('multi-commander-engagement-v1');
    expect(parseCampaignConfiguration(JSON.stringify(doc))).toEqual(settings);
    expect(() =>
      parseCampaignConfiguration(
        JSON.stringify({
          ...doc,
          settings: {
            ...settings,
            engagement: { ...settings.engagement, additionalDefenderCp: -1 },
          },
        }),
      ),
    ).toThrow(/engagement/);
    expect(() =>
      parseCampaignConfiguration(
        JSON.stringify({ ...doc, requiredCodeCapabilities: ['multi-commander-engagement-v99'] }),
      ),
    ).toThrow(/matching feature branch/);
    expect(
      configurationDocument({ ...defaultSettings(), commanderTrainingCp: 11 })
        .requiredCodeCapabilities,
    ).not.toContain('multi-commander-engagement-v1');
  });
});

describe('private participant selection', () => {
  it('offers Engage for an eligible adjacent MainHex enemy without moving into its cell', () => {
    const pending = pendingGame();
    const attackerId = pending.pending!.attackerArmyId;
    const defenderId = pending.pending!.defenderArmyId;
    const game = apply(pending, { type: 'cancelBattle' }).state;
    const attacker = structuredClone(game.armies.find((army) => army.id === attackerId)!);
    const defender = game.armies.find((army) => army.id === defenderId)!;
    expect(
      mainNeighbors(worldOf(game).world, attacker.at).some((main) => main.key === defender.at),
    ).toBe(true);
    load(game);
    act(() =>
      useGameStore.getState().setUi({ selectedArmy: attackerId, selectedMain: attacker.at }),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`ENGAGE BRAVO COMMANDER ${defenderId}`) }),
    );
    expect(useGameStore.getState().game!.phase).toBe('battle-pending');
    expect(useGameStore.getState().game!.armies.find((army) => army.id === attackerId)).toEqual(
      attacker,
    );
    expect(screen.getByLabelText('ALPHA participant selection')).toBeInTheDocument();
  });
  it('quotes own choices, saves pending selection and aborts without spending or moving', () => {
    const game = pendingGame();
    const extra = structuredClone(game.armies.find((army) => army.id === 'A-extra')!);
    load(game);
    render(<App />);
    expect(screen.getByLabelText('ALPHA participant selection')).toBeInTheDocument();
    expect(screen.queryByLabelText('Include commander B-extra')).toBeNull();
    fireEvent.click(screen.getByLabelText('Include commander A-extra'));
    expect(screen.getByTestId('participation-total')).toHaveTextContent('7 CP / 30 available');
    expect(useGameStore.getState().game!.cp).toEqual({ A: 30, B: 30 });
    expect(useGameStore.getState().game!.armies.find((army) => army.id === extra.id)).toEqual(
      extra,
    );
    act(() => {
      useGameStore.getState().saveToSlot('slot1');
    });
    fireEvent.click(screen.getByRole('button', { name: /abort engagement/i }));
    expect(useGameStore.getState().game!.phase).toBe('strategic');
    expect(useGameStore.getState().game!.cp).toEqual({ A: 30, B: 30 });
    act(() => {
      expect(useGameStore.getState().loadSlot('slot1')).toBe(true);
    });
    dismissHandoff('ALPHA');
    expect(screen.getByLabelText('Include commander A-extra')).toBeChecked();
    expect(useGameStore.getState().game!.pending?.participation?.attackerIds).toContain(extra.id);
    expect(useGameStore.getState().game!.armies.find((army) => army.id === extra.id)).toEqual(
      extra,
    );
  });

  it('hands over even with fog off and commits both side totals only after locks', () => {
    load(pendingGame());
    render(<App />);
    fireEvent.click(screen.getByLabelText('Include commander A-extra'));
    fireEvent.click(screen.getByRole('button', { name: 'LOCK ALPHA COMMANDERS' }));
    expect(screen.queryByLabelText('Include commander B-extra')).toBeNull();
    dismissHandoff('BRAVO');
    expect(screen.queryByLabelText('Include commander A-extra')).toBeNull();
    fireEvent.click(screen.getByLabelText('Include commander B-extra'));
    expect(screen.getByTestId('participation-total')).toHaveTextContent('2 CP / 30 available');
    fireEvent.click(screen.getByRole('button', { name: 'LOCK BRAVO COMMANDERS' }));
    expect(useGameStore.getState().game!.cp).toEqual({ A: 30, B: 30 });
    dismissHandoff('ALPHA');
    fireEvent.click(screen.getByRole('button', { name: 'FIGHT TACTICAL BATTLE' }));
    expect(useGameStore.getState().game!.phase).toBe('battle');
    expect(useGameStore.getState().game!.cp).toEqual({ A: 23, B: 28 });
    expect(useGameStore.getState().game!.battle!.participants).toHaveLength(4);
  });

  it('lets a player reduce an infeasible ready roster without aborting or spending CP', () => {
    const game = pendingGame();
    const extra = game.armies.find((army) => army.id === 'A-extra')!;
    for (let i = 0; i < 60; i++)
      extra.units.push({ ...extra.units[0]!, id: `A-crowded-${i}`, label: `Crowded rifle ${i}` });
    const originalExtra = structuredClone(extra);
    load(game);
    render(<App />);
    fireEvent.click(screen.getByLabelText('Include commander A-extra'));
    fireEvent.click(screen.getByRole('button', { name: 'LOCK ALPHA COMMANDERS' }));
    dismissHandoff('BRAVO');
    fireEvent.click(screen.getByLabelText('Include commander B-extra'));
    fireEvent.click(screen.getByRole('button', { name: 'LOCK BRAVO COMMANDERS' }));
    dismissHandoff('ALPHA');
    fireEvent.click(screen.getByRole('button', { name: 'FIGHT TACTICAL BATTLE' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/do not fit/i);
    expect(useGameStore.getState().game!.cp).toEqual({ A: 30, B: 30 });
    expect(useGameStore.getState().game!.battle).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'EDIT ALPHA COMMANDERS' }));
    expect(screen.getByLabelText('ALPHA participant selection')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Include commander A-extra'));
    expect(screen.getByTestId('participation-total')).toHaveTextContent('5 CP / 30 available');
    fireEvent.click(screen.getByRole('button', { name: 'LOCK ALPHA COMMANDERS' }));
    expect(screen.queryByLabelText('Include commander B-extra')).toBeNull();
    dismissHandoff('BRAVO');
    expect(screen.getByLabelText('Include commander B-extra')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'LOCK BRAVO COMMANDERS' }));
    dismissHandoff('ALPHA');
    expect(useGameStore.getState().game!.cp).toEqual({ A: 30, B: 30 });
    fireEvent.click(screen.getByRole('button', { name: 'FIGHT TACTICAL BATTLE' }));
    expect(useGameStore.getState().game!.phase).toBe('battle');
    expect(useGameStore.getState().game!.cp).toEqual({ A: 25, B: 30 });
    expect(useGameStore.getState().game!.battle!.participants).toHaveLength(2);
    expect(useGameStore.getState().game!.armies.find((army) => army.id === extra.id)).toEqual(
      originalExtra,
    );
  });

  it('offers the human defender its own choice after an AI attacker locks', () => {
    const game = pendingGame();
    game.settings.controllers = { A: 'ai', B: 'human' };
    load(game);
    render(<App />);
    expect(screen.queryByLabelText('Include commander A-extra')).toBeNull();
    for (
      let i = 0;
      i < 4 && useGameStore.getState().game!.pending!.participation!.stage === 'attacker';
      i++
    )
      act(() => useGameStore.getState().aiTick());
    expect(screen.getByLabelText('BRAVO participant selection')).toBeInTheDocument();
    expect(screen.getByLabelText('Include commander B-extra')).toBeEnabled();
    expect(screen.queryByLabelText('Include commander A-extra')).toBeNull();
    expect(useGameStore.getState().game!.cp).toEqual({ A: 30, B: 30 });
    fireEvent.click(screen.getByRole('button', { name: 'LOCK BRAVO COMMANDERS' }));
    expect(screen.queryByRole('button', { name: 'EDIT ALPHA COMMANDERS' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'EDIT BRAVO COMMANDERS' }));
    expect(screen.getByLabelText('BRAVO participant selection')).toBeInTheDocument();
    expect(useGameStore.getState().game!.cp).toEqual({ A: 30, B: 30 });
  });

  it('uses the picked unit’s commander zone in the scene and accessible roster', () => {
    let game = pendingGame();
    const actions: GameAction[] = [
      { type: 'engagementSelect', team: 'A', armyIds: [game.pending!.attackerArmyId, 'A-extra'] },
      { type: 'engagementLock', team: 'A' },
      { type: 'engagementSelect', team: 'B', armyIds: [game.pending!.defenderArmyId, 'B-extra'] },
      { type: 'engagementLock', team: 'B' },
      { type: 'startBattle' },
    ];
    for (const action of actions) {
      const result = apply(game, action);
      expect(result.error).toBeNull();
      game = result.state;
    }
    load(game);
    render(<App />);
    const unit = game.battle!.units.find((candidate) => candidate.holderId === 'B-extra')!;
    const roster = screen.getByRole('list', { name: 'Deployment roster' });
    fireEvent.click(within(roster).getByRole('button', { name: new RegExp(unit.label) }));
    expect(screen.getByTestId('deployment-owner')).toHaveTextContent('B-extra');
    const { ui } = useGameStore.getState();
    const scene = buildTacticalScene(game, ui, null);
    const expected = deploymentZone(
      buildContext(game.settings, game.battle!),
      game.battle!,
      'B',
      'B-extra',
    );
    expect(
      scene.spec.overlays
        .filter((overlay) => overlay.color === 0x33ff88)
        .map((overlay) => overlay.key)
        .sort(),
    ).toEqual([...expected].sort());
    expect(game.armies.find((army) => army.id === 'B-extra')!.movesLeft).toBe(3);
  });
});

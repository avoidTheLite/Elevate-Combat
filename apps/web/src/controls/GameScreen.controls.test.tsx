import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Army, CampaignNodeSite, GameState } from '@iron-ridge/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apply,
  constructCampaignNodeRequest,
  commanderReach,
  contextFor,
  createGame,
  reachable,
  refreshCampaignNodeSnapshot,
  setHolderPos,
  unitType,
  validateGameState,
  worldOf,
} from '@iron-ridge/engine';
import { GameScreen } from '../components/screens/GameScreen.tsx';
import { useGameStore } from '../stores/useGameStore.ts';
import { createMovementDemo, movementDemoFocus } from './demoScenario.ts';
import type { SceneCommandControls } from './types.ts';
import type { SceneSpec } from '../render/spec.ts';
import { regularPlaytestSettings } from '../lib/campaignScenarios.ts';
import { commanderOf, strategicGame } from '../lib/testGames.ts';
import { holderForClick } from '../lib/holders.ts';
import { CONTROL_PREFERENCES_KEY } from './preferences.ts';

let scene: {
  spec: SceneSpec;
  commandControls: SceneCommandControls;
  onHover: (key: string | null) => void;
};
vi.mock('../components/game/SceneView.tsx', () => ({
  SceneView: (props: typeof scene & { children: ReactNode }) => {
    scene = props;
    return <div>{props.children}</div>;
  },
}));
const store = (): ReturnType<typeof useGameStore.getState> => useGameStore.getState();
beforeEach(() => {
  localStorage.clear();
  store().quit();
  const game = createMovementDemo();
  useGameStore.setState({ game, handoff: null });
  store().setUi(movementDemoFocus(game));
});
const click = (targetKey: string): void =>
  scene.commandControls.onInteraction({ source: 'click', originKey: null, targetKey, button: 0 });
function openUnitContext(): void {
  const game = store().game!;
  const unit = game.battle?.units.find((u) => u.id === store().ui.selectedUnit);
  const key = unit?.pos ?? game.armies.find((a) => a.id === store().ui.selectedArmy)!.pos;
  act(() =>
    scene.commandControls.onInteraction({
      source: 'context',
      originKey: key,
      targetKey: key,
      button: 0,
      pointerType: 'touch',
    }),
  );
}
function anchors(from: string, to: string): void {
  act(() =>
    scene.commandControls.onLayout([
      { key: from, x: 160, y: 160, radius: 25, width: 50, height: 40 },
      { key: to, x: 420, y: 220, radius: 25, width: 50, height: 40 },
    ]),
  );
}

describe('screen command artifacts', () => {
  it('selection shows no persistent popup; a requested tile context retains unit actions', () => {
    const mounted = render(<GameScreen />);
    const before = store().game;
    expect(store().ui.selectedUnit).not.toBeNull();
    expect(mounted.container.querySelector('.map-callout')).toBeNull();
    openUnitContext();
    expect(screen.getByLabelText('Contextual unit actions')).toBeInTheDocument();
    expect(mounted.container.querySelectorAll('.map-callout')).toHaveLength(1);
    expect(mounted.container.querySelector('[data-callout-kind="selected"]')).toBeNull();
    expect(store().game).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'DESELECT' }));
    expect(mounted.container.querySelector('.map-callout')).toBeNull();
    expect(store().game).toBe(before);
  });

  it('keeps preview explanations out of the default layout with accessible descriptions and optional help', () => {
    render(<GameScreen />);
    const before = store().game!;
    const rifle = before.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const target = [...reachable(contextFor(before), rifle).keys()].find(
      (key) => key !== rifle.pos,
    )!;
    act(() => click(target));
    const preview = screen.getByRole('dialog', { name: 'MOVE command preview' });
    const confirm = within(preview).getByRole('button', { name: 'CONFIRM MOVE' });
    expect(confirm).toHaveAccessibleDescription(/MP/);
    expect(confirm).toHaveAttribute('title', expect.stringContaining('MP'));
    const help = within(preview).getByText('? HELP');
    expect(help.closest('details')).not.toHaveAttribute('open');
    expect(
      within(preview)
        .getByText(/Movement preserves/, { selector: 'li' })
        .closest('details'),
    ).not.toHaveAttribute('open');
    fireEvent.click(help);
    expect(store().game).toBe(before);
  });

  it.each([false, true])(
    'a successful strategic move follows the selected holder into its destination MainHex (QuickMove=%s)',
    (quickMove) => {
      const game = strategicGame(false);
      const commander = commanderOf(game, 'A');
      const dest = [...commanderReach(game, commander).keys()].find(
        (key) =>
          worldOf(game).world.subByKey.get(key)?.main !== commander.at &&
          !holderForClick(game, null, key),
      )!;
      const main = worldOf(game).world.subByKey.get(dest)!.main;
      localStorage.setItem(CONTROL_PREFERENCES_KEY, JSON.stringify({ quickMove }));
      useGameStore.setState({ game, handoff: null });
      store().setUi({ selectedUnit: null, selectedArmy: commander.id, selectedMain: commander.at });
      render(<GameScreen />);
      act(() => click(dest));
      if (!quickMove) fireEvent.click(screen.getByRole('button', { name: 'CONFIRM MOVE' }));
      expect(commanderOf(store().game!, 'A').pos).toBe(dest);
      expect(store().ui.selectedArmy).toBe(commander.id);
      expect(store().ui.selectedMain).toBe(main);
    },
  );
  it('persists a real movement path and connector across pointer leave, then removes them on selection change', () => {
    const mounted = render(<GameScreen />);
    const game = store().game!;
    const rifle = game.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const key = [...reachable(contextFor(game), rifle).keys()].find((k) => k !== rifle.pos)!;
    act(() => click(key));
    anchors(rifle.pos!, key);
    expect(screen.getByRole('dialog', { name: 'MOVE command preview' })).toBeInTheDocument();
    expect(scene.spec.path.at(-1)).toBe(key);
    expect(mounted.container.querySelector('.map-command-connector line')).toBeInTheDocument();
    act(() => scene.onHover(null));
    expect(scene.spec.path.at(-1)).toBe(key);
    const other = game.battle!.units.find((u) => u.team === 'A' && u.id !== rifle.id)!;
    act(() => click(other.pos!));
    expect(store().ui.hoverCell).toBeNull();
    expect(scene.spec.path).toEqual([]);
    expect(scene.spec.trajectory).toBeNull();
    expect(scene.spec.fireView).toBeNull();
    expect(screen.queryByTestId('map-command-preview')).not.toBeInTheDocument();
    expect(mounted.container.querySelector('.map-command-connector')).not.toBeInTheDocument();
  });

  it('removes attack trajectory, firing target and preview on deselect, then ignores stale hover', () => {
    const mounted = render(<GameScreen />);
    const game = store().game!;
    const rifle = game.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const target = game.battle!.units.find(
      (u) => u.team === 'B' && u.typeId === 'ww2_rifle_infantry',
    )!;
    const staleHover = scene.onHover;
    act(() => click(target.pos!));
    anchors(rifle.pos!, target.pos!);
    expect(scene.spec.trajectory?.to).toBe(target.pos);
    expect(screen.getByRole('dialog', { name: 'ATTACK command preview' })).toBeInTheDocument();
    act(() => click(rifle.pos!));
    act(() => staleHover(target.pos));
    expect(store().ui.selectedUnit).toBeNull();
    expect(store().ui.hoverCell).toBeNull();
    expect(scene.spec.path).toEqual([]);
    expect(scene.spec.trajectory).toBeNull();
    expect(scene.spec.fireView).toBeNull();
    expect(mounted.container.querySelector('.map-command-connector')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Selected unit actions')).not.toBeInTheDocument();
  });

  it('exposes proposed browser preferences as keyboard-focusable controls', () => {
    render(<GameScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'DEMO CONTROLS' }));
    expect(
      screen.getByRole('dialog', { name: 'Proposed map control preferences' }),
    ).toBeInTheDocument();
    const quick = screen.getByRole('checkbox', { name: /QuickMove/ });
    expect(quick).not.toBeChecked();
    fireEvent.click(quick);
    expect(quick).toBeChecked();
    fireEvent.change(screen.getByRole('combobox', { name: 'Animation easing' }), {
      target: { value: 'linear' },
    });
    expect(JSON.parse(localStorage.getItem(CONTROL_PREFERENCES_KEY)!).easing).toBe('linear');
  });

  it('explicit ATTACK on an empty destination and MOVE on an enemy never fall through to another command', () => {
    render(<GameScreen />);
    const before = store().game!;
    const rifle = before.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const moveKey = [...reachable(contextFor(before), rifle).keys()].find(
      (key) => key !== rifle.pos,
    )!;
    const target = before.battle!.units.find(
      (u) => u.team === 'B' && u.typeId === 'ww2_rifle_infantry',
    )!;
    openUnitContext();
    fireEvent.click(
      within(screen.getByLabelText('Contextual unit actions')).getByRole('button', {
        name: 'ATTACK',
      }),
    );
    act(() => click(moveKey));
    expect(store().game).toBe(before);
    expect(screen.queryByTestId('map-command-preview')).not.toBeInTheDocument();
    openUnitContext();
    fireEvent.click(
      within(screen.getByLabelText('Contextual unit actions')).getByRole('button', {
        name: 'MOVE',
      }),
    );
    act(() => click(target.pos!));
    expect(store().game).toBe(before);
    expect(screen.queryByTestId('map-command-preview')).not.toBeInTheDocument();
  });

  it('an indirect MOVE preview shows the real path without an attack trajectory or firing view', () => {
    const game = store().game!;
    const unit = game.battle!.units.find((u) => u.team === 'A' && u.typeId === 'ww2_at_infantry')!;
    const source = game.armies
      .find((army) => army.id === unit.holderId)!
      .units.find((u) => u.id === unit.id)!;
    unit.typeId = source.typeId = 'ww2_mortar';
    unit.hp = source.hp = unit.maxHp = unitType('ww2_mortar').hp;
    unit.mp = unitType('ww2_mortar').move;
    expect(validateGameState(game)).toEqual([]);
    store().setUi({ selectedUnit: unit.id });
    render(<GameScreen />);
    const key = [...reachable(contextFor(game), unit).keys()].find((k) => k !== unit.pos)!;
    openUnitContext();
    fireEvent.click(
      within(screen.getByLabelText('Contextual unit actions')).getByRole('button', {
        name: 'MOVE',
      }),
    );
    act(() => click(key));
    expect(scene.spec.path.at(-1)).toBe(key);
    expect(scene.spec.trajectory).toBeNull();
    expect(scene.spec.fireView).toBeNull();
  });

  it('QuickMove body-click inspects an owned empty node, while a neutral center remains a real move', () => {
    const make = (owned: boolean): { game: GameState; site: CampaignNodeSite; commander: Army } => {
      let game = createGame({
        ...regularPlaytestSettings(),
        controllers: { A: 'human', B: 'human' },
        fog: false,
      });
      const site = game.infrastructure!.sites.find(
        (s) => s.homeTeam === null && !game.armies.some((a) => a.at === s.mainHex),
      )!;
      const commander = commanderOf(game, 'A');
      setHolderPos(worldOf(game).world, commander, site.annexSubHexes[0]!);
      refreshCampaignNodeSnapshot(game);
      if (owned) {
        const activated = apply(game, {
          type: 'nodeWork',
          request: constructCampaignNodeRequest(game, {
            kind: 'activate',
            nodeId: site.nodeId,
            commanderId: commander.id,
            centerDefinitionId: 'generic',
          }),
        });
        expect(activated.error).toBeNull();
        game = activated.state;
      }
      expect(validateGameState(game)).toEqual([]);
      useGameStore.setState({ game, handoff: null });
      store().setUi({ selectedUnit: null, selectedArmy: commander.id, selectedMain: site.mainHex });
      return { game, site, commander };
    };
    localStorage.setItem(CONTROL_PREFERENCES_KEY, JSON.stringify({ quickMove: true }));
    const own = make(true);
    const mounted = render(<GameScreen />);
    act(() => click(own.site.centerSubHex));
    expect(store().game).toBe(own.game);
    expect(commanderOf(store().game!, 'A').pos).toBe(own.commander.pos);
    expect(store().ui.selectedMain).toBe(own.site.mainHex);
    expect(screen.queryByTestId('map-command-preview')).not.toBeInTheDocument();
    mounted.unmount();
    const neutral = make(false);
    render(<GameScreen />);
    act(() => click(neutral.site.centerSubHex));
    expect(commanderOf(store().game!, 'A').pos).toBe(neutral.site.centerSubHex);
  });
});

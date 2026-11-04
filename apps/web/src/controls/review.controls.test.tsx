import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode, ReactElement } from 'react';
import * as engine from '@iron-ridge/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameScreen } from '../components/screens/GameScreen.tsx';
import { TacticalSidebar } from '../components/game/TacticalSidebar.tsx';
import { useGameStore } from '../stores/useGameStore.ts';
import { commandAt } from './commands.ts';
import { useMapControls } from './useMapControls.ts';
import { blindFireFixture } from './reviewFixtures.ts';
import { createMovementDemo, movementDemoFocus } from './demoScenario.ts';
import type { SceneCommandControls } from './types.ts';

let scene: { commandControls: SceneCommandControls; onHover: (key: string | null) => void };
vi.mock('../components/game/SceneView.tsx', () => ({
  SceneView: (props: typeof scene & { children: ReactNode }): ReactElement => {
    scene = props;
    return <div>{props.children}</div>;
  },
}));
const store = (): ReturnType<typeof useGameStore.getState> => useGameStore.getState();
beforeEach(() => {
  localStorage.clear();
  store().quit();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function mountGame(): engine.GameState {
  const game = createMovementDemo();
  useGameStore.setState({ game, handoff: null });
  store().setUi(movementDemoFocus(game));
  return game;
}
function hoverCard(key: string): Element {
  act(() => scene.onHover(key));
  act(() => vi.advanceTimersByTime(500));
  return document.querySelector('.map-callout')!;
}

describe('PR18 review information and interaction regressions', () => {
  it('blind attack details cannot distinguish an unobserved defender from empty ground', () => {
    const f = blindFireFixture();
    const empty = commandAt(f.game, f.ui, f.target, 'attack')!;
    expect(empty.kind).toBe('attack');
    const hidden = f.battle.units.find((u) => u.team === 'B')!;
    hidden.pos = f.target;
    const source = f.game.armies
      .find((a) => a.id === hidden.holderId)!
      .units.find((u) => u.id === hidden.id)!;
    hidden.typeId = source.typeId = 'ww2_tank';
    hidden.hp = source.hp = hidden.maxHp = engine.unitType('ww2_tank').hp;
    const occupied = commandAt(f.game, f.ui, f.target, 'attack')!;
    expect(occupied.details).toEqual(empty.details);
    expect(occupied.details.join(' ')).toContain('Blind fire');
    expect(occupied.details.join(' ')).not.toMatch(
      /TN |direct hit|splash|Expected damage|armor|Side|Front/,
    );
    f.game.settings.fog = false;
    expect(commandAt(f.game, f.ui, f.target, 'attack')!.details.join(' ')).toContain(
      'Expected damage',
    );
  });
  it('blind sidebar hides target-dependent statistics but fog-off remains omniscient', () => {
    const f = blindFireFixture();
    const hidden = f.battle.units.find((u) => u.team === 'B')!;
    hidden.pos = f.target;
    useGameStore.setState({ game: f.game, handoff: null });
    store().setUi({ ...f.ui, hoverCell: f.target });
    const ctx = engine.buildContext(f.game.settings, f.battle);
    const mounted = render(
      <TacticalSidebar game={f.game} ctx={ctx} view="A" canAct seenIds={new Set([f.shooter.id])} />,
    );
    const detail = screen.getByTestId('target-detail');
    expect(detail).toHaveTextContent('Defender statistics are unknown');
    expect(detail.textContent).not.toMatch(/TN |Base \(|Hit|Splash|Exp dmg/);
    mounted.rerender(<TacticalSidebar game={f.game} ctx={ctx} view={null} canAct seenIds={null} />);
    expect(screen.getByTestId('target-detail')).toHaveTextContent('TN');
  });
  it('blind Help, hover titles and accessibility descriptions expose the same safe details', () => {
    const f = blindFireFixture();
    const hidden = f.battle.units.find((u) => u.team === 'B')!;
    hidden.pos = f.target;
    useGameStore.setState({ game: f.game, handoff: null });
    store().setUi(f.ui);
    render(<GameScreen />);
    act(() =>
      scene.commandControls.onInteraction({
        source: 'context',
        originKey: f.shooter.pos,
        targetKey: f.shooter.pos,
        button: 0,
      }),
    );
    fireEvent.click(
      within(screen.getByLabelText('Contextual unit actions')).getByRole('button', {
        name: 'ATTACK',
      }),
    );
    act(() =>
      scene.commandControls.onInteraction({
        source: 'click',
        originKey: null,
        targetKey: f.target,
        button: 0,
      }),
    );
    const preview = screen.getByRole('dialog', { name: 'ATTACK command preview' });
    expect(preview).toHaveAccessibleDescription(/Defender statistics are unknown/);
    const confirm = within(preview).getByRole('button', { name: 'CONFIRM ATTACK' });
    expect(confirm.title).not.toMatch(/TN |direct hit|Expected damage|armor/);
    expect(preview.textContent).not.toMatch(/TN |direct hit|Expected damage/);
  });
  it('a hovered action survives pointer leave while keyboard focus remains inside', () => {
    vi.useFakeTimers();
    const game = mountGame();
    render(<GameScreen />);
    const actor = game.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const card = hoverCard(actor.pos!);
    const move = within(card as HTMLElement).getByRole('button', { name: 'MOVE' });
    fireEvent.pointerEnter(card);
    fireEvent.focus(move);
    fireEvent.pointerLeave(card);
    act(() => vi.advanceTimersByTime(1000));
    expect(move).toBeInTheDocument();
    expect(store().game).toBe(game);
    fireEvent.blur(move, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(620));
    expect(card).not.toBeInTheDocument();
  });
  it('a hovered action survives focus leaving until the pointer leaves as well', () => {
    vi.useFakeTimers();
    const game = mountGame();
    render(<GameScreen />);
    const actor = game.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const card = hoverCard(actor.pos!);
    const move = within(card as HTMLElement).getByRole('button', { name: 'MOVE' });
    fireEvent.pointerEnter(card);
    fireEvent.focus(move);
    fireEvent.blur(move, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(1000));
    expect(move).toBeInTheDocument();
    fireEvent.pointerLeave(card);
    act(() => vi.advanceTimersByTime(620));
    expect(card).not.toBeInTheDocument();
    expect(store().game).toBe(game);
  });
  it('camera anchors do not rebuild command contexts, reachability or cloned actions', () => {
    const game = mountGame();
    const ctx = engine.buildContext(game.settings, game.battle!);
    const actor = game.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const key = [...engine.reachable(ctx, actor).keys()].find((k) => k !== actor.pos)!;
    const contextSpy = vi.spyOn(engine, 'buildContext');
    const reachSpy = vi.spyOn(engine, 'reachable');
    const legalSpy = vi.spyOn(engine, 'apply');
    const { result } = renderHook(() =>
      useMapControls(
        useGameStore((s) => s.game)!,
        useGameStore((s) => s.ui),
        false,
      ),
    );
    act(() =>
      result.current.interact({ source: 'click', originKey: null, targetKey: key, button: 0 }),
    );
    const counts = [
      contextSpy.mock.calls.length,
      reachSpy.mock.calls.length,
      legalSpy.mock.calls.length,
    ];
    expect(counts[0]).toBe(1);
    expect(counts[1]).toBe(1);
    for (let x = 0; x < 8; x++)
      act(() =>
        result.current.setAnchors([
          { key: actor.pos!, x: 100 + x, y: 100, radius: 20, width: 40, height: 30 },
        ]),
      );
    expect([
      contextSpy.mock.calls.length,
      reachSpy.mock.calls.length,
      legalSpy.mock.calls.length,
    ]).toEqual(counts);
    expect(result.current.pending?.command.target).toBe(key);
    expect(store().game).toBe(game);
    act(() => store().dispatch({ type: 'rotate', unitId: actor.id, dir: actor.facing + 1 }));
    expect(result.current.pending).toBeNull();
    expect(store().game).not.toBe(game);
    act(() =>
      result.current.interact({ source: 'click', originKey: null, targetKey: key, button: 0 }),
    );
    expect(contextSpy.mock.calls.length).toBeGreaterThan(counts[0]!);
  });
});

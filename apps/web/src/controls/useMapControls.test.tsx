import { act, renderHook } from '@testing-library/react';
import type { RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextFor, reachable } from '@iron-ridge/engine';
import { useGameStore } from '../stores/useGameStore.ts';
import { useMapControls } from './useMapControls.ts';
import type { MapControls } from './useMapControls.ts';
import type { SceneInteraction } from './types.ts';
import { commandAt } from './commands.ts';
import { createMovementDemo, movementDemoFocus } from './demoScenario.ts';
import { CONTROL_PREFERENCES_KEY } from './preferences.ts';

const store = (): ReturnType<typeof useGameStore.getState> => useGameStore.getState();
beforeEach(() => {
  localStorage.clear();
  store().quit();
  const game = createMovementDemo();
  useGameStore.setState({ game, handoff: null });
  store().setUi(movementDemoFocus(game));
});
afterEach(() => vi.useRealTimers());
function mount(): RenderHookResult<MapControls, unknown> {
  return renderHook(() =>
    useMapControls(
      useGameStore((s) => s.game)!,
      useGameStore((s) => s.ui),
      !!useGameStore((s) => s.handoff),
    ),
  );
}
function moveKey(): string {
  const game = store().game!;
  const rifle = game.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
  return [...reachable(contextFor(game), rifle).keys()].find((key) => key !== rifle.pos)!;
}
function click(key: string): SceneInteraction {
  return { source: 'click' as const, originKey: null, targetKey: key, button: 0 };
}

describe('map command interaction lifecycle', () => {
  it('native context selects and exposes a previously unselected unit without an automatic persistent card', () => {
    const { result } = mount();
    const before = store().game;
    const unit = before!.battle!.units.find(
      (u) => u.team === 'A' && u.id !== store().ui.selectedUnit,
    )!;
    expect(result.current.targetKey).toBeNull();
    act(() =>
      result.current.interact({ ...click(unit.pos!), source: 'context', pointerType: 'touch' }),
    );
    expect(store().ui.selectedUnit).toBe(unit.id);
    expect(result.current.targetKey).toBe(unit.pos);
    expect(store().game).toBe(before);
    act(() => result.current.cancel());
    expect(result.current.actor!.id).toBe(unit.id);
    expect(result.current.targetKey).toBeNull();
  });

  it('keeps a full preview on pointer leave and native context, then explicitly confirms once', () => {
    const { result } = mount();
    const key = moveKey();
    const before = store().game;
    act(() => {
      result.current.interact(click(key));
    });
    expect(result.current.pending?.command.target).toBe(key);
    expect(store().game).toBe(before);
    act(() => result.current.onHover(null));
    expect(result.current.previewKey).toBe(key);
    act(() => result.current.interact({ ...click(key), source: 'context', pointerType: 'touch' }));
    expect(result.current.pending?.command.target).toBe(key);
    act(() => result.current.confirm());
    expect(
      store().game!.battle!.units.find(
        (u) => u.id === before!.battle!.units.find((u) => u.id === store().ui.selectedUnit)?.id,
      )?.pos,
    ).toBe(key);
    expect(result.current.pending).toBeNull();
  });

  it('uses independent click preferences; even QuickMove drag release only stages confirmation', () => {
    const { result } = mount();
    act(() => result.current.setPreference({ quickMove: true }));
    expect(JSON.parse(localStorage.getItem(CONTROL_PREFERENCES_KEY)!)).toMatchObject({
      quickMove: true,
      quickAttack: false,
    });
    const key = moveKey();
    const before = store().game;
    const origin = result.current.actor!.pos;
    act(() =>
      result.current.interact({
        source: 'drag',
        stage: 'move',
        originKey: origin,
        targetKey: key,
        button: 0,
      }),
    );
    expect(result.current.pending?.dragging).toBe(true);
    act(() =>
      result.current.interact({
        source: 'drag',
        stage: 'end',
        originKey: origin,
        targetKey: key,
        button: 0,
      }),
    );
    expect(result.current.pending?.dragging).toBe(false);
    expect(store().game).toBe(before);
    act(() => result.current.cancel());
    act(() => result.current.interact(click(key)));
    expect(store().game).not.toBe(before);
    expect(result.current.pending).toBeNull();
  });

  it('QuickAttack stages attacks by default and executes when enabled', () => {
    const { result } = mount();
    const target = store().game!.battle!.units.find(
      (u) => u.team === 'B' && u.typeId === 'ww2_rifle_infantry',
    )!.pos!;
    const before = store().game;
    act(() => result.current.interact(click(target)));
    expect(result.current.pending?.command.kind).toBe('attack');
    expect(store().game).toBe(before);
    act(() => {
      result.current.cancel();
      result.current.setPreference({ quickAttack: true });
    });
    act(() => result.current.interact(click(target)));
    expect(store().game).not.toBe(before);
    expect(result.current.pending).toBeNull();
  });

  it('selection and deselection clear every pending and hover artifact until new intent', () => {
    const { result } = mount();
    const key = moveKey();
    const oldHover = result.current.onHover;
    act(() => result.current.interact(click(key)));
    const other = store().game!.battle!.units.find(
      (u) => u.team === 'A' && u.id !== store().ui.selectedUnit,
    )!;
    act(() => result.current.interact(click(other.pos!)));
    expect(store().ui.selectedUnit).toBe(other.id);
    expect(result.current.previewKey).toBeNull();
    expect(result.current.pending).toBeNull();
    act(() => oldHover(key));
    expect(result.current.previewKey).toBeNull();
    act(() => result.current.interact(click(other.pos!)));
    expect(store().ui.selectedUnit).toBeNull();
    expect(result.current.actions).toEqual([]);
  });

  it('cancel, phase changes, handover and stale callbacks never dispatch a stored command', () => {
    const { result } = mount();
    const key = moveKey();
    act(() => result.current.interact(click(key)));
    const confirm = result.current.confirm;
    const retained = result.current.interact;
    act(() => {
      expect(store().dispatch({ type: 'endBattleTurn' })).toBe(true);
    });
    const after = store().game;
    act(() => {
      confirm();
      retained(click(key));
    });
    expect(store().game).toBe(after);
    expect(result.current.pending).toBeNull();
    act(() => useGameStore.setState({ handoff: 'B' }));
    expect(result.current.enabled).toBe(false);
  });

  it('uses delayed hover enter and exit, with callout focus/pointer bridging', () => {
    vi.useFakeTimers();
    const { result } = mount();
    const key = moveKey();
    act(() => result.current.onHover(key));
    expect(result.current.targetKey).toBeNull();
    act(() => vi.advanceTimersByTime(499));
    expect(result.current.targetKey).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.targetKey).toBe(key);
    act(() => {
      result.current.onHover(null);
      result.current.calloutEnter();
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.targetKey).toBe(key);
    expect(result.current.previewKey).toBe(key);
    act(() => result.current.calloutLeave());
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.exiting).toBe(true);
    act(() => vi.advanceTimersByTime(120));
    expect(result.current.targetKey).toBeNull();
    expect(result.current.previewKey).toBeNull();
  });

  it('runs real engineer and fixed-weapon actions immediately without confirmation', () => {
    const { result } = mount();
    const engineer = store().game!.battle!.units.find(
      (u) => u.team === 'A' && u.typeId === 'ww2_engineer',
    )!;
    act(() => result.current.select(engineer.id, engineer.pos!));
    const before = store().game;
    const dig = result.current.actions.find((command) => command.label === 'DIG IN')!;
    expect(commandAt(before!, store().ui, engineer.pos!)).toBeNull();
    act(() => result.current.issue(dig));
    expect(store().game!.battle!.forts[engineer.pos!]).toBe(1);
    expect(result.current.pending).toBeNull();
  });

  it('native context on the selected unit preserves selection; changing preferences never executes a pending order', () => {
    const { result } = mount();
    const selected = result.current.actor!;
    act(() =>
      result.current.interact({
        source: 'context',
        originKey: selected.pos,
        targetKey: selected.pos,
        button: 0,
        pointerType: 'touch',
      }),
    );
    expect(store().ui.selectedUnit).toBe(selected.id);
    act(() => result.current.interact(click(moveKey())));
    const before = store().game;
    const confirm = result.current.confirm;
    act(() => result.current.setPreference({ quickMove: true, quickAttack: true }));
    expect(store().game).toBe(before);
    act(() => {
      confirm();
      confirm();
    });
    expect(store().game!.battle!.units.find((u) => u.id === selected.id)!.pos).not.toBe(
      selected.pos,
    );
    expect(result.current.pending).toBeNull();
  });

  it('a retained confirm reads a newly opened quit modal before the next render', () => {
    const { result } = mount();
    act(() => result.current.interact(click(moveKey())));
    const before = store().game;
    const confirm = result.current.confirm;
    act(() => {
      store().requestQuit();
      confirm();
    });
    expect(store().game).toBe(before);
    expect(result.current.pending).toBeNull();
  });

  it('cancelled and replaced records cannot execute through retained confirm callbacks', () => {
    const { result } = mount();
    const game = store().game!;
    const rifle = game.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const destinations = [...reachable(contextFor(game), rifle).keys()].filter(
      (k) => k !== rifle.pos,
    );
    act(() => result.current.interact(click(destinations[0]!)));
    const cancelledConfirm = result.current.confirm;
    act(() => result.current.cancel());
    act(() => cancelledConfirm());
    expect(store().game).toBe(game);
    act(() => result.current.interact(click(destinations[0]!)));
    const replacedConfirm = result.current.confirm;
    act(() => result.current.interact(click(destinations[1]!)));
    act(() => replacedConfirm());
    expect(store().game).toBe(game);
    expect(result.current.pending?.command.target).toBe(destinations[1]);
  });
});

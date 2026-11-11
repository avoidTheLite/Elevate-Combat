import { act, renderHook } from '@testing-library/react';
import type { RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextFor, reachable } from '@iron-ridge/engine';
import { inspectTile, visibleTileEntities } from '../lib/selection.ts';
import { useGameStore } from '../stores/useGameStore.ts';
import { createMovementDemo, movementDemoFocus } from './demoScenario.ts';
import { garrisonContextFixture } from './reviewFixtures.ts';
import type { SceneInteraction } from './types.ts';
import { useMapControls } from './useMapControls.ts';
import type { MapControls } from './useMapControls.ts';

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
      useGameStore((state) => state.game)!,
      useGameStore((state) => state.ui),
      !!useGameStore((state) => state.handoff),
    ),
  );
}

function moveKey(): string {
  const game = store().game!;
  const actor = game.battle!.units.find((unit) => unit.id === store().ui.selectedUnit)!;
  return [...reachable(contextFor(game), actor).keys()].find((key) => key !== actor.pos)!;
}

function click(key: string): SceneInteraction {
  return { source: 'click', originKey: null, targetKey: key, button: 0 };
}

const contextCases = (['hq', 'node'] as const).flatMap((kind) =>
  [false, true].flatMap((temporary) =>
    [false, true].map((priorActor) => ({ kind, temporary, priorActor })),
  ),
);

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: context and session lifecycle', () => {
  it.each(contextCases)(
    '$kind: touch context stays pinned (temporary=$temporary, prior actor=$priorActor)',
    ({ kind, temporary, priorActor }) => {
      vi.useFakeTimers();
      const { game, center } = garrisonContextFixture(kind, temporary);
      const commander = game.armies.find(
        (holder) => holder.team === 'A' && holder.kind === 'commander',
      )!;
      const entities = visibleTileEntities(game, center);
      const node = entities.find((entity) => entity.kind === 'node')!;
      expect(entities.map((entity) => entity.kind)).toEqual(
        temporary ? ['holder', 'node'] : ['node'],
      );
      useGameStore.setState({ game, handoff: null });
      store().setUi({
        selectedArmy: priorActor ? commander.id : null,
        selectedUnit: null,
        selectedEntity: null,
        inspectedCell: null,
      });
      const { result } = mount();
      expect(result.current.actor?.id ?? null).toBe(priorActor ? commander.id : null);

      act(() =>
        result.current.interact({
          ...click(center),
          source: 'context',
          pointerType: 'touch',
        }),
      );

      expect(store().ui.inspectedCell).toBe(center);
      expect(store().ui.selectedEntity).toBe(temporary ? null : node.id);
      expect(store().ui.selectedArmy).toBeNull();
      expect(store().ui.selectedUnit).toBeNull();
      expect(result.current.actor).toBeNull();
      expect(result.current.inspectionEntities).toEqual(entities);
      expect(result.current.targetKey).toBe(center);
      expect(result.current.pending).toBeNull();
      expect(store().game).toBe(game);

      act(() => {
        result.current.calloutLeave();
        result.current.onHover(null);
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.targetKey).toBe(center);
      expect(store().game).toBe(game);

      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(result.current.targetKey).toBeNull();
      expect(store().ui.selectedEntity).toBe(temporary ? null : node.id);
      expect(store().game).toBe(game);
    },
  );

  it.each(['helper', 'retained hook'] as const)(
    'stale %s inspection preserves a replacement session and its staged move',
    (source) => {
      const { result } = mount();
      const previous = store().game!;
      const oldKey = previous.battle!.units.find(
        (unit) => unit.team === 'A' && unit.id !== store().ui.selectedUnit,
      )!.pos!;
      const inspect =
        source === 'helper' ? () => inspectTile(previous, oldKey) : result.current.inspect;
      const fresh = createMovementDemo();
      act(() => {
        useGameStore.setState({ game: fresh, handoff: null });
        store().setUi(movementDemoFocus(fresh));
      });
      act(() => result.current.interact(click(moveKey())));
      const ui = { ...store().ui };
      const pending = result.current.pending;
      expect(pending).not.toBeNull();

      act(() => inspect(oldKey));

      expect(store().game).toBe(fresh);
      expect(store().ui).toEqual(ui);
      expect(result.current.pending).toBe(pending);
    },
  );

  it('a retained confirmation cannot spend a pending move in a replacement game with identical actor IDs', () => {
    const { result } = mount();
    act(() => result.current.interact(click(moveKey())));
    expect(result.current.pending).not.toBeNull();
    const confirm = result.current.confirm;
    const previousActor = result.current.actor!.id;
    const fresh = createMovementDemo();
    expect(movementDemoFocus(fresh).selectedUnit).toBe(previousActor);

    act(() => {
      useGameStore.setState({ game: fresh, handoff: null });
      store().setUi(movementDemoFocus(fresh));
      confirm();
    });

    expect(store().game).toBe(fresh);
    expect(result.current.pending).toBeNull();
  });

  it('replacement with the same actor IDs cancels the earlier hover dwell timer', () => {
    vi.useFakeTimers();
    const { result } = mount();
    act(() => result.current.onHover(moveKey()));
    const previousActor = result.current.actor!.id;
    const fresh = createMovementDemo();
    expect(movementDemoFocus(fresh).selectedUnit).toBe(previousActor);
    act(() => {
      useGameStore.setState({ game: fresh, handoff: null });
      store().setUi(movementDemoFocus(fresh));
    });

    act(() => vi.advanceTimersByTime(2000));

    expect(result.current.targetKey).toBeNull();
    expect(result.current.previewKey).toBeNull();
    expect(store().ui.hoverCell).toBeNull();
    expect(store().game).toBe(fresh);
  });
});

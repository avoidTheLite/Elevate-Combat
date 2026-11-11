import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apply, contextFor, reachable, validateGameState } from '@iron-ridge/engine';
import * as los from '../../../../packages/engine/src/los.ts';
import { createMovementDemo, movementDemoFocus } from './demoScenario.ts';
import { useGameStore } from '../stores/useGameStore.ts';
import { useMapControls } from './useMapControls.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('GAMES-ELEVATE-CAMPAIGN-UC-002: fog inspection reuses visibility during camera layouts and refreshes after a real move', () => {
  localStorage.clear();
  useGameStore.getState().quit();
  const game = createMovementDemo();
  game.settings.fog = true;
  const focus = movementDemoFocus(game),
    actor = game.battle!.units.find((u) => u.id === focus.selectedUnit)!;
  const key = actor.pos!;
  useGameStore.setState({ game, handoff: null });
  useGameStore.getState().setUi({ ...focus, inspectedCell: key });
  const sight = vi.spyOn(los, 'lineOfSight');
  const { result } = renderHook(() =>
    useMapControls(
      useGameStore((s) => s.game)!,
      useGameStore((s) => s.ui),
      false,
    ),
  );
  const entities = result.current.inspectionEntities;
  expect(entities.some((e) => e.id === actor.id)).toBe(true);
  sight.mockClear();
  for (let x = 0; x < 60; x++)
    act(() => result.current.setAnchors([{ key, x, y: 100, width: 40, height: 30, radius: 20 }]));
  expect(sight).not.toHaveBeenCalled();
  expect(result.current.inspectionEntities).toBe(entities);
  expect(useGameStore.getState().game).toBe(game);
  const dest = [...reachable(contextFor(game), actor).keys()].find((k) => k !== key)!;
  const moved = apply(game, { type: 'move', unitId: actor.id, cell: dest });
  expect(moved.error).toBeNull();
  expect(validateGameState(moved.state)).toEqual([]);
  sight.mockClear();
  act(() => useGameStore.setState({ game: moved.state }));
  expect(sight).toHaveBeenCalled();
  expect(result.current.inspectionEntities.some((e) => e.id === actor.id)).toBe(false);
  expect(result.current.inspectionEntities).not.toBe(entities);
  const next = result.current.inspectionEntities;
  sight.mockClear();
  act(() =>
    result.current.setAnchors([{ key, x: 200, y: 120, width: 60, height: 40, radius: 30 }]),
  );
  expect(sight).not.toHaveBeenCalled();
  expect(result.current.inspectionEntities).toBe(next);
});

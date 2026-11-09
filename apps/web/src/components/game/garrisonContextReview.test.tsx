import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { deserializeSave, serializeSave, validateGameState } from '@iron-ridge/engine';
import { garrisonContextFixture } from '../../controls/reviewFixtures.ts';
import { useGameStore } from '../../stores/useGameStore.ts';
import { chooseTileEntity, inspectTile, visibleTileEntities } from '../../lib/selection.ts';
import { selectableAt } from '../../controls/commands.ts';
import { useMapControls } from '../../controls/useMapControls.ts';
import { MapCallouts } from '../../controls/MapCallouts.tsx';
import { StrategicSidebar } from './StrategicSidebar.tsx';

beforeEach(() => {
  localStorage.clear();
  useGameStore.getState().quit();
});
describe('GAMES-ELEVATE-CAMPAIGN-UC-002: reviewed garrison context', () => {
  it.each(['hq', 'node'] as const)(
    '%s: a permanent holder ID selects its same-tile combined node card',
    (kind) => {
      const { game, center, permanentId } = garrisonContextFixture(kind);
      useGameStore.setState({ game, handoff: null });
      const node = visibleTileEntities(game, center).find((e) => e.kind === 'node')!;
      expect(node).toBeDefined();
      expect(useGameStore.getState().ui.selectedEntity).toBeNull();
      act(() => chooseTileEntity(game, center, permanentId));
      expect(useGameStore.getState().ui.selectedEntity).toBe(node.id);
      expect(useGameStore.getState().ui.inspectedCell).toBe(center);
      expect(useGameStore.getState().ui.selectedArmy).toBeNull();
      expect(useGameStore.getState().game).toBe(game);
    },
  );
  it.each(['hq', 'node'] as const)(
    '%s: legally stationed center guard remains separate from the empty permanent node roster',
    (kind) => {
      const f = garrisonContextFixture(kind, true),
        { game } = f;
      expect(validateGameState(game)).toEqual([]);
      expect(
        deserializeSave(serializeSave(game, 'Center guard', '2026-11-09T00:00:00.000Z')).ok,
      ).toBe(true);
      expect(game.armies.find((h) => h.id === f.permanentId)!.units).toEqual([]);
      const guard = game.armies.find((h) => h.id === f.temporaryId)!;
      expect(guard).toMatchObject({
        kind: 'garrison',
        building: 'temporary',
        pos: f.center,
        movesLeft: 0,
      });
      expect(guard.units).toHaveLength(1);
      expect(game.forts[f.center]).toBe(1);
      expect(visibleTileEntities(game, f.center).map((e) => e.kind)).toEqual(['holder', 'node']);
      useGameStore.setState({ game, handoff: null });
      act(() => inspectTile(game, f.center));
      expect(useGameStore.getState().ui.selectedArmy).toBeNull();
      const mounted = render(<StrategicSidebar game={game} view="A" canAct />);
      expect(screen.getAllByTestId('entity-context-body')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'Select TILE GARRISON' }));
      expect(useGameStore.getState().ui.selectedArmy).toBe(f.temporaryId);
      expect(screen.getAllByTestId('entity-context-body')).toHaveLength(1);
      mounted.unmount();
    },
  );

  it.each(['hq', 'node'] as const)(
    '%s: permanent and temporary callout IDs choose their distinct visible contexts',
    (kind) => {
      const f = garrisonContextFixture(kind, true),
        { game } = f;
      useGameStore.setState({ game, handoff: null });
      const { result } = renderHook(() =>
        useMapControls(
          useGameStore((s) => s.game)!,
          useGameStore((s) => s.ui),
          false,
        ),
      );
      act(() =>
        result.current.interact({
          source: 'context',
          originKey: null,
          targetKey: f.center,
          button: 0,
        }),
      );
      expect(selectableAt(game, f.center).map((h) => h.id)).toContain(f.permanentId);
      render(<MapCallouts controls={result.current} />);
      fireEvent.click(
        screen.getByRole('button', {
          name: kind === 'hq' ? 'SELECT HQ GARRISON' : 'SELECT NODE GARRISON',
        }),
      );
      expect(useGameStore.getState().ui.selectedEntity).toBe(
        visibleTileEntities(game, f.center).find((e) => e.kind === 'node')!.id,
      );
      expect(useGameStore.getState().ui.selectedArmy).toBeNull();
      act(() => chooseTileEntity(game, f.center, f.temporaryId!));
      expect(useGameStore.getState().ui.selectedEntity).toBe(f.temporaryId);
      expect(useGameStore.getState().ui.selectedArmy).toBe(f.temporaryId);
      expect(useGameStore.getState().game).toBe(game);
    },
  );

  it('rejects stale snapshots, off-tile and hidden permanent IDs while retaining the earlier HQ ring semantics', () => {
    const f = garrisonContextFixture('hq');
    f.game.settings.fog = true;
    f.game.settings.controllers.B = 'ai';
    useGameStore.setState({ game: f.game, handoff: null });
    const other = f.game.armies.find((a) => a.team === 'B' && a.building === 'hq')!;
    const before = { ...useGameStore.getState().ui };
    act(() => chooseTileEntity(f.game, other.pos, other.id));
    expect(useGameStore.getState().ui).toEqual(before);
    act(() => chooseTileEntity(f.game, other.pos, f.permanentId));
    expect(useGameStore.getState().ui).toEqual(before);
    const next = structuredClone(f.game);
    useGameStore.setState({ game: next });
    act(() => chooseTileEntity(f.game, f.center, f.permanentId));
    expect(useGameStore.getState().ui).toEqual(before);
    const staleVisibleId = visibleTileEntities(f.game, f.center)[0]!.id;
    act(() => chooseTileEntity(f.game, f.center, staleVisibleId));
    expect(useGameStore.getState().ui).toEqual(before);
    act(() => chooseTileEntity(next, f.center, 'missing-holder'));
    expect(useGameStore.getState().ui).toEqual(before);
    expect(useGameStore.getState().game).toBe(next);
  });
});

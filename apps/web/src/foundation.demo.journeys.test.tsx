import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  campaignBuildingData,
  campaignNodeViews,
  deserializeSave,
  serializeSave,
  validateGameState,
} from '@iron-ridge/engine';
import App from './App.tsx';
import { useGameStore } from './stores/useGameStore.ts';

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
});

function start(label: string, capture = '7', raze = '3'): void {
  fireEvent.click(screen.getByRole('button', { name: 'INFRASTRUCTURE PLAYTEST' }));
  fireEvent.click(screen.getByRole('button', { name: label }));
  expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeDisabled();
  expect(screen.getByLabelText('Capture Node price (CP)')).toHaveValue(null);
  expect(screen.getByLabelText('Raze Node price (CP)')).toHaveValue(null);
  fireEvent.change(screen.getByLabelText('Capture Node price (CP)'), {
    target: { value: capture },
  });
  fireEvent.change(screen.getByLabelText('Raze Node price (CP)'), { target: { value: raze } });
  fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
  expect(screen.queryByRole('button', { name: 'START NEW GAME' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Prepared demo guide' })).toBeInTheDocument();
  expect(validateGameState(useGameStore.getState().game)).toEqual([]);
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002: prepared scenarios in normal setup', () => {
  it('opens three independent after-income choices, preserving entered unaffordable prices and a free way to continue', () => {
    render(<App />);
    start('TURN-START CAPTURE', '10000', '9999');
    const state = useGameStore.getState().game!;
    expect(state.settings).toMatchObject({
      grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
      seed: 1,
      fog: false,
      controllers: { A: 'human', B: 'human' },
    });
    expect(state.infrastructure!.capture.pending).toMatchObject({
      event: { kind: 'turn-start-after-income' },
      costs: { capture: 10000, raze: 9999 },
    });
    expect(state.infrastructure!.capture.pending!.candidates).toHaveLength(3);
    // Starting 20 plus five normal 5-CP Home-HQ payments; no demo resource grant.
    expect(state.cp.A).toBe(45);
    const owners = state.infrastructure!.capture.nodes.map((node) => node.owner);
    for (const button of screen.getAllByRole('button', { name: /Do nothing .* \(0 CP\)/ }))
      fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all choices' }));
    const next = useGameStore.getState().game!;
    expect(next.cp.A).toBe(45);
    expect(next.infrastructure!.capture.pending).toBeNull();
    expect(next.infrastructure!.capture.nodes.map((node) => node.owner)).toEqual(owners);
    expect(next.phase).toBe('strategic');
    const loaded = deserializeSave(serializeSave(next));
    expect(loaded.ok && loaded.save.state).toEqual(next);
  });

  it('uses the real move control to acquire a node after movement with a closed building window', () => {
    render(<App />);
    start('CAPTURE AFTER MOVEMENT');
    const before = useGameStore.getState().game!;
    const cp = before.cp.A;
    const paid = before.infrastructure!.clock!.paidIncomeEvents;
    fireEvent.click(screen.getByRole('button', { name: 'MOVE TO NODE CENTER' }));
    expect(useGameStore.getState().game!.infrastructure!.capture.pending!.event.kind).toBe(
      'strategic-movement',
    );
    const nodeId =
      useGameStore.getState().game!.infrastructure!.capture.pending!.candidates[0].node.id;
    fireEvent.click(screen.getByRole('button', { name: /Capture Node .* \(7 CP\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all choices' }));
    const after = useGameStore.getState().game!;
    expect(after.cp.A).toBe(cp - 7);
    expect(after.infrastructure!.clock!.paidIncomeEvents).toEqual(paid);
    expect(campaignNodeViews(after).find((node) => node.nodeId === nodeId)).toMatchObject({
      owner: 'A',
      work: { buildingWindow: 'closed', operationsRemaining: 0 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'INSPECT DEMO NODE' }));
    expect(screen.getByRole('region', { name: 'Infrastructure node' })).toHaveTextContent(
      'Captured after the building window',
    );
  });

  it('starts an actual tactical annex raid and carries its ruin through save, manual victory and campaign resolution', () => {
    render(<App />);
    start('ANNEX RAID');
    const before = useGameStore.getState().game!;
    const cp = { ...before.cp };
    const actorId = useGameStore.getState().ui.selectedUnit!;
    const workshop = before
      .infrastructure!.capture.nodes.flatMap((node) => node.buildings)
      .find((building) => campaignBuildingData(building).definitionId === 'workshop')!;
    expect(before.battle!.phase).toBe('combat');
    fireEvent.click(screen.getByRole('button', { name: 'Raze Tile (1 ACT · 0 CP)' }));
    const damaged = useGameStore.getState().game!;
    expect(damaged.cp).toEqual(cp);
    expect(damaged.battle!.units.find((unit) => unit.id === actorId)).toMatchObject({
      acted: true,
      mp: 0,
    });
    expect(damaged.battle!.ruinedInfrastructureBuildingIds).toEqual([workshop.id]);
    const saved = useGameStore.getState().exportSave()!;
    act(() => {
      useGameStore.getState().quit();
      expect(useGameStore.getState().importSave(saved.text)).toBe(true);
    });
    expect(useGameStore.getState().game).toEqual(damaged);
    fireEvent.click(screen.getByRole('button', { name: 'SECURE' }));
    fireEvent.click(screen.getByRole('button', { name: 'RETURN TO CAMPAIGN' }));
    expect(useGameStore.getState().game!.infrastructure!.capture.pending!.event.kind).toBe(
      'manual-battle-end',
    );
    fireEvent.click(screen.getByRole('button', { name: /Do nothing .* \(0 CP\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all choices' }));
    if (screen.queryByRole('button', { name: 'Continue without stationing' }))
      fireEvent.click(screen.getByRole('button', { name: 'Continue without stationing' }));
    const committed = useGameStore.getState().game!;
    expect(committed.phase).toBe('strategic');
    expect(committed.battle).toBeNull();
    expect(
      committed
        .infrastructure!.capture.nodes.flatMap((node) => node.buildings)
        .find((building) => building.id === workshop.id),
    ).toMatchObject({ ruined: true, data: workshop.data });
    expect(validateGameState(committed)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'INSPECT DEMO NODE' }));
    expect(screen.getByRole('region', { name: 'Infrastructure node' })).toHaveTextContent('RUINED');
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  campaignRoadRepairOptions,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  hexDistance,
  worldOf,
} from '@iron-ridge/engine';
import type { GameState } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { RoadRepairPanel } from './RoadRepairPanel.tsx';

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
});

function damagedRoadGame(): GameState {
  const configuration = createFoundationPlaytestConfiguration(7, 3);
  const settings = {
    ...defaultSettings(),
    grid: { mainCols: 3, mainRows: 1, subRadius: 1 },
    controllers: { A: 'human' as const, B: 'human' as const },
    infrastructure: configuration,
  };
  const first = createGame(settings);
  const commander = first.armies.find(
    (holder) => holder.team === 'A' && holder.kind === 'commander',
  )!;
  const { world } = worldOf(first);
  const from = world.subByKey.get(commander.pos)!;
  const to = world.subs.find(
    (cell) => cell.main === commander.at && hexDistance(cell.hex, from.hex) === 1,
  )!;
  return createGame({
    ...settings,
    infrastructure: {
      ...configuration,
      roads: [{ id: 'home-road', mainHex: commander.at, path: [from.key, to.key], damaged: true }],
    },
  });
}

function Harness(): React.ReactElement {
  const game = useGameStore((state) => state.game)!;
  return <RoadRepairPanel game={game} mainHex={game.hq.A} canAct />;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: explicit map road repair', () => {
  it('repairs the quoted section through the real store, spending an engineer outside node work', () => {
    const game = damagedRoadGame();
    const quote = campaignRoadRepairOptions(game).find((option) => option.allowed)!;
    expect(quote.request).not.toBeNull();
    act(() => useGameStore.setState({ game }));
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Road repair order'), {
      target: { value: quote.request!.requestId },
    });
    fireEvent.click(screen.getByRole('button', { name: `Repair road (${quote.cpCost} CP)` }));
    const next = useGameStore.getState().game!;
    expect(
      next.infrastructure!.supply!.roads.find((section) => section.id === quote.roadId)?.damaged,
    ).toBe(false);
    expect(next.cp.A).toBe(game.cp.A - quote.cpCost!);
    expect(next.infrastructure!.capture.work.nodeSpending).toEqual(
      game.infrastructure!.capture.work.nodeSpending,
    );
    expect(next.infrastructure!.capture.work.engineerSpending).toContainEqual(
      expect.objectContaining({ unitId: quote.engineerUnitId }),
    );
    expect(screen.queryByLabelText('Road repair order')).not.toBeInTheDocument();
  });

  it('does not invent road targets on a map without explicit road sections', () => {
    const game = createGame({
      ...defaultSettings(),
      infrastructure: createFoundationPlaytestConfiguration(7, 3),
    });
    const { container } = render(<RoadRepairPanel game={game} mainHex={null} canAct />);
    expect(container).toBeEmptyDOMElement();
  });
});

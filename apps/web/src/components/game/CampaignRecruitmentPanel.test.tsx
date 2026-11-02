import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  apply,
  campaignNodeActionChoices,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  quoteCampaignRecruitment,
  setHolderPos,
  worldOf,
} from '@iron-ridge/engine';
import type { GameState } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { CampaignRecruitmentPanel } from './CampaignRecruitmentPanel.tsx';

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
});

function configuredGame(): GameState {
  const configuration = createFoundationPlaytestConfiguration(7, 3);
  return createGame({
    ...defaultSettings(),
    grid: { mainCols: 3, mainRows: 1, subRadius: 1 },
    controllers: { A: 'human', B: 'human' },
    fog: false,
    infrastructure: configuration,
  });
}

function Harness({ mainHex }: { mainHex: string }): React.ReactElement {
  const game = useGameStore((state) => state.game)!;
  return <CampaignRecruitmentPanel game={game} mainHex={mainHex} canAct />;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: recruitment through shared node budgets', () => {
  it('updates the real local/shared budgets and disables recruitment when local throughput is spent', () => {
    const game = configuredGame();
    const quote = quoteCampaignRecruitment(game, 'ww2_rifle_infantry');
    expect(quote.allowed).toBe(true);
    expect(quote.localRemaining).toBe(2); // Explicit playtest fixture: throughput1 × Home-connected2.
    act(() => useGameStore.setState({ game }));
    render(<Harness mainHex={game.hq.A} />);
    fireEvent.click(screen.getByRole('button', { name: /^Rifle Infantry/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Rifle Infantry/ }));
    const next = useGameStore.getState().game!;
    expect(next.cp.A).toBe(game.cp.A - quote.cost! * 2);
    const exhausted = quoteCampaignRecruitment(next, 'ww2_rifle_infantry');
    expect(exhausted.localRemaining).toBe(0);
    expect(exhausted.sharedRemaining).toBe(quote.sharedRemaining! - 2);
    expect(screen.getByRole('button', { name: /^Rifle Infantry/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Rifle Infantry/ })).toHaveAttribute(
      'title',
      exhausted.reason,
    );
    expect(
      next.armies.find((holder) => holder.team === 'A' && holder.building === 'hq')!.units,
    ).toHaveLength(2);
  });

  it('recruits into a selected connected non-HQ node rather than silently sending units to HQ', () => {
    let game = configuredGame();
    const f = game.infrastructure!;
    const site = f.sites.find(
      (candidate) => f.capture.nodes.find((node) => node.id === candidate.nodeId)!.owner === null,
    )!;
    const commander = game.armies.find(
      (holder) => holder.team === 'A' && holder.kind === 'commander',
    )!;
    const { world } = worldOf(game);
    setHolderPos(world, commander, site.centerSubHex);
    const activation = campaignNodeActionChoices(game, site.nodeId).find(
      (choice) =>
        choice.legal &&
        choice.request.kind === 'activate' &&
        choice.request.centerDefinitionId === 'generic',
    )!;
    expect(activation).toBeDefined();
    const activated = apply(game, { type: 'nodeWork', request: activation.request });
    if (activated.error) throw new Error(activated.error);
    game = activated.state;
    const moved = apply(game, {
      type: 'moveCommander',
      armyId: commander.id,
      dest: site.annexSubHexes[0],
    });
    if (moved.error) throw new Error(moved.error);
    game = moved.state;
    expect(quoteCampaignRecruitment(game, 'ww2_rifle_infantry', site.nodeId).allowed).toBe(true);
    act(() => useGameStore.setState({ game }));
    render(<Harness mainHex={site.mainHex} />);
    fireEvent.click(screen.getByRole('button', { name: /^Rifle Infantry/ }));
    const next = useGameStore.getState().game!;
    expect(
      next.armies.find((holder) => holder.building === 'node' && holder.nodeId === site.nodeId)
        ?.units,
    ).toHaveLength(1);
    expect(
      next.armies.find((holder) => holder.team === 'A' && holder.building === 'hq')?.units,
    ).toHaveLength(0);
  });
});

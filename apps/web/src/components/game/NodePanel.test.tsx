import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  campaignNodeActionChoices,
  campaignNodeViews,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  deserializeSave,
  makeUnit,
  refreshCampaignNodeSnapshot,
  setHolderPos,
  worldOf,
} from '@iron-ridge/engine';
import type { CampaignNodeActionChoice, CampaignNodeView, GameState } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import {
  nodePlacementTargets,
  useNodePlacementStore,
  visibleNodeActionChoices,
} from '../../stores/useNodePlacementStore.ts';
import { strategicKnowledge } from '../../lib/strategicVisibility.ts';
import { NodePanel } from './NodePanel.tsx';

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useGameStore.getState().quit();
    useNodePlacementStore.getState().cancelPlacement();
  });
});

function configuredGame(): GameState {
  return createGame({
    ...defaultSettings(),
    controllers: { A: 'human', B: 'human' },
    fog: false,
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
}

function home(game: GameState): CampaignNodeView {
  return campaignNodeViews(game).find((candidate) => candidate.mainHex === game.hq.A)!;
}

function buildChoice(game: GameState, subHex?: string): CampaignNodeActionChoice {
  return campaignNodeActionChoices(game, home(game).nodeId).find(
    (candidate) =>
      candidate.request.kind === 'build' &&
      candidate.request.definitionId === 'workshop' &&
      candidate.request.tier === 1 &&
      (!subHex || candidate.request.subHex === subHex) &&
      candidate.legal,
  )!;
}

function buildButton(): HTMLElement {
  return screen.getByRole('button', { name: /Build Workshop T1 3 CP/ });
}

function NodeHarness({ cell = null }: { cell?: string | null }): React.ReactElement {
  const game = useGameStore((state) => state.game)!;
  return <NodePanel game={game} mainHex={game.hq.A} inspectedCell={cell} canAct />;
}

function load(game: GameState): void {
  act(() => useGameStore.setState({ game }));
}

function addEngineer(game: GameState): void {
  game.armies
    .find((army) => army.team === 'A' && army.kind === 'commander')!
    .units.push(makeUnit(game, 'A', 'ww2_engineer'));
}

function stageBuild(game: GameState): void {
  fireEvent.click(buildButton());
  const choice = buildChoice(game);
  if (choice.request.kind !== 'build') throw new Error('Expected a build');
  const tile = choice.request.subHex;
  act(() => {
    expect(useNodePlacementStore.getState().selectTile(game, tile)).toBe(true);
  });
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: contextual node work through the real game store', () => {
  it('chooses a building before a legal map tile, then commits the quoted spend once and saves it', () => {
    const game = configuredGame();
    const node = home(game);
    const choice = buildChoice(game);
    expect(choice).toBeDefined();
    const before = JSON.stringify(game);
    load(game);
    render(<NodeHarness />);
    fireEvent.click(buildButton());
    expect(screen.getByRole('status')).toHaveTextContent('Choose a highlighted tile');
    expect(screen.queryByRole('button', { name: /Confirm build/ })).not.toBeInTheDocument();
    expect(JSON.stringify(useGameStore.getState().game)).toBe(before);
    const plan = useNodePlacementStore.getState().plan!;
    const targets = nodePlacementTargets(game, plan);
    expect(targets.length).toBeGreaterThan(0);
    if (choice.request.kind !== 'build') throw new Error('Expected a build');
    expect(targets).toContain(choice.request.subHex);
    const tile = choice.request.subHex;
    act(() => {
      useNodePlacementStore.getState().selectTile(game, tile);
    });
    expect(JSON.stringify(useGameStore.getState().game)).toBe(before);
    const confirm = screen.getByRole('button', { name: `Confirm build (${choice.cpCost} CP)` });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    const next = useGameStore.getState().game!;
    expect(next.cp.A).toBe(game.cp.A - choice.cpCost);
    expect(home(next).buildings).toHaveLength(node.buildings.length + 1);
    const work = next.infrastructure!.capture.work;
    expect(work.nodeSpending.find((record) => record.nodeId === node.nodeId)).toMatchObject({
      ordinarySpent: true,
      operationCount: 1,
    });
    expect(work.engineerSpending).toEqual(game.infrastructure!.capture.work.engineerSpending);
    expect(next.infrastructure!.workRequests).toHaveLength(1);
    expect(useNodePlacementStore.getState().plan).toBeNull();
    const restored = deserializeSave(useGameStore.getState().exportSave()!.text);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.save.state).toEqual(next);
  });

  it('uses the already inspected empty tile without asking for another location', () => {
    const game = configuredGame();
    const choice = buildChoice(game);
    if (choice.request.kind !== 'build') throw new Error('Expected a build');
    load(game);
    render(<NodeHarness cell={choice.request.subHex} />);
    fireEvent.click(buildButton());
    expect(useNodePlacementStore.getState().plan?.subHex).toBe(choice.request.subHex);
    expect(screen.queryByText(/Choose a highlighted tile/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Confirm build (${choice.cpCost} CP)` }));
    expect(home(useGameStore.getState().game!).buildings).toEqual(
      expect.arrayContaining([expect.objectContaining({ subHex: choice.request.subHex })]),
    );
  });

  it('opens the building-first catalog from the inspected center while retaining tile context', () => {
    const game = configuredGame();
    const center = home(game).centerSubHex;
    load(game);
    act(() => useGameStore.getState().setUi({ inspectedCell: center }));
    render(<NodeHarness cell={center} />);
    expect(screen.queryByRole('button', { name: /Build Workshop T1/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Build at node' }));
    expect(buildButton()).toBeEnabled();
    expect(useGameStore.getState().ui.inspectedCell).toBe(center);
    fireEvent.click(buildButton());
    expect(useNodePlacementStore.getState().plan?.subHex).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Choose a highlighted tile');
    expect(useGameStore.getState().ui.inspectedCell).toBe(center);
    expect(useGameStore.getState().game).toBe(game);
  });

  it('ignores illegal placement clicks and cancellation spends no CP, work or engineer allowance', () => {
    const game = configuredGame();
    const before = JSON.stringify(game);
    load(game);
    render(<NodeHarness />);
    fireEvent.click(buildButton());
    act(() => {
      expect(useNodePlacementStore.getState().selectTile(game, home(game).centerSubHex)).toBe(
        false,
      );
      expect(useNodePlacementStore.getState().selectTile(game, 'not-a-tile')).toBe(false);
    });
    expect(useNodePlacementStore.getState().plan?.subHex).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel building' }));
    expect(useNodePlacementStore.getState().plan).toBeNull();
    expect(JSON.stringify(useGameStore.getState().game)).toBe(before);
    stageBuild(game);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel building work' }));
    expect(useNodePlacementStore.getState().plan).toBeNull();
    expect(JSON.stringify(useGameStore.getState().game)).toBe(before);
  });

  it('upgrades the selected building with a local engineer and no new placement request', () => {
    const game = configuredGame();
    addEngineer(game);
    const node = home(game);
    const choice = campaignNodeActionChoices(game, node.nodeId).find(
      (candidate) => candidate.request.kind === 'upgrade' && candidate.legal,
    )!;
    expect(choice).toBeDefined();
    load(game);
    render(<NodeHarness cell={node.centerSubHex} />);
    expect(screen.queryByRole('button', { name: /Build Workshop/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `${choice.label} ${choice.cpCost} CP` }));
    expect(useNodePlacementStore.getState().plan).toBeNull();
    expect(screen.queryByText(/Choose a highlighted tile/)).not.toBeInTheDocument();
    expect(useGameStore.getState().game!.cp).toEqual(game.cp);
    fireEvent.click(screen.getByRole('button', { name: `Confirm order (${choice.cpCost} CP)` }));
    const next = useGameStore.getState().game!;
    expect(
      home(next).buildings.find((building) => building.subHex === node.centerSubHex)?.tier,
    ).toBe(2);
    expect(next.cp.A).toBe(game.cp.A - choice.cpCost);
    expect(next.infrastructure!.capture.work.engineerSpending).toHaveLength(1);
  });

  it('repairs the selected ruined building in place', () => {
    const game = configuredGame();
    addEngineer(game);
    const node = home(game);
    const record = game.infrastructure!.capture.nodes.find(
      (candidate) => candidate.id === node.nodeId,
    )!;
    const infra = game.infrastructure!;
    game.infrastructure = {
      ...infra,
      capture: {
        ...infra.capture,
        nodes: infra.capture.nodes.map((candidate) =>
          candidate.id === record.id
            ? {
                ...candidate,
                buildings: candidate.buildings.map((building) => ({ ...building, ruined: true })),
              }
            : candidate,
        ),
      },
    };
    const choice = campaignNodeActionChoices(game, node.nodeId).find(
      (candidate) => candidate.request.kind === 'repair-building' && candidate.legal,
    )!;
    expect(choice).toBeDefined();
    load(game);
    render(<NodeHarness cell={node.centerSubHex} />);
    fireEvent.click(screen.getByRole('button', { name: `${choice.label} ${choice.cpCost} CP` }));
    expect(useNodePlacementStore.getState().plan).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Confirm order (${choice.cpCost} CP)` }));
    const next = useGameStore.getState().game!;
    expect(home(next).buildings[0]?.ruined).toBe(false);
    expect(next.cp.A).toBe(game.cp.A - choice.cpCost);
    expect(next.infrastructure!.capture.work.engineerSpending).toHaveLength(1);
  });

  it('shows the engine refusal for an upgrade without local engineers and leaves CP untouched', () => {
    const game = configuredGame();
    const { world } = worldOf(game);
    for (const commander of game.armies.filter(
      (holder) => holder.team === 'A' && holder.kind === 'commander',
    )) {
      const remote = world.subs.find(
        (cell) => cell.main !== game.hq.A && !game.armies.some((holder) => holder.pos === cell.key),
      )!;
      setHolderPos(world, commander, remote.key);
    }
    const node = home(game);
    const refused = campaignNodeActionChoices(game, node.nodeId).find(
      (choice) => choice.request.kind === 'upgrade' && !choice.legal,
    )!;
    expect(refused?.reason).toBeTruthy();
    load(game);
    render(<NodeHarness cell={node.centerSubHex} />);
    expect(screen.getByText(refused.reason!)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `${refused.label} ${refused.cpCost} CP` }),
    ).toBeDisabled();
    expect(useGameStore.getState().game!.cp).toEqual(game.cp);
  });

  it('shows unaffordable build choices with the actual engine reason and quoted CP price', () => {
    const game = configuredGame();
    game.cp.A = 0;
    refreshCampaignNodeSnapshot(game);
    const refused = campaignNodeActionChoices(game, home(game).nodeId).find(
      (choice) => choice.request.kind === 'build' && choice.request.definitionId === 'workshop',
    )!;
    expect(refused.legal).toBe(false);
    const before = JSON.stringify(game);
    load(game);
    render(<NodeHarness />);
    expect(buildButton()).toBeDisabled();
    expect(screen.getAllByText(refused.reason!).length).toBeGreaterThan(0);
    fireEvent.click(buildButton());
    expect(useNodePlacementStore.getState().plan).toBeNull();
    expect(JSON.stringify(useGameStore.getState().game)).toBe(before);
  });

  it('refuses a changed price after a location quote without spending anything', () => {
    const game = configuredGame();
    load(game);
    render(<NodeHarness />);
    stageBuild(game);
    const changed = structuredClone(game);
    const definition = changed.infrastructure!.profile.definitions.find(
      (candidate) => candidate.id === 'workshop',
    )!;
    Object.assign(definition.costs.build, { 1: 9 });
    load(changed);
    expect(screen.getByRole('button', { name: 'Confirm build (3 CP)' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('This order changed');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm build (3 CP)' }));
    expect(useGameStore.getState().game).toBe(changed);
    expect(home(changed).buildings).toHaveLength(1);
    expect(changed.infrastructure!.workRequests).toHaveLength(0);
  });

  it('keeps placement highlights and action choices within current fog knowledge', () => {
    const game = configuredGame();
    game.settings.fog = true;
    const node = home(game);
    const choice = buildChoice(game);
    if (choice.request.kind !== 'build') throw new Error('Expected a build');
    const knowledge = strategicKnowledge(game, 'A');
    const visible = visibleNodeActionChoices(game, node, 'A');
    for (const candidate of visible) {
      if (candidate.request.kind === 'build') {
        expect(knowledge.cells.has(candidate.request.subHex)).toBe(true);
      }
    }
    useNodePlacementStore.getState().startPlacement({
      nodeId: node.nodeId,
      mainHex: node.mainHex,
      definitionId: choice.request.definitionId,
      tier: choice.request.tier,
      view: 'B',
    });
    expect(nodePlacementTargets(game, useNodePlacementStore.getState().plan)).toEqual([]);
    expect(useNodePlacementStore.getState().selectTile(game, choice.request.subHex)).toBe(false);
    const enemyNode = campaignNodeViews(game).find((candidate) => candidate.owner === 'B')!;
    expect(visibleNodeActionChoices(game, enemyNode, 'A')).toEqual([]);
  });
});

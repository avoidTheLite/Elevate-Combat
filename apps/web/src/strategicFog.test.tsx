import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignNodeSite, GameState } from '@iron-ridge/engine';
import * as engine from '@iron-ridge/engine';
import {
  createFoundationPlaytestConfiguration,
  createGame,
  campaignNodeActionChoices,
  defaultSettings,
  mainNeighbors,
  hexDistance,
  refreshCampaignNodeSnapshot,
  setHolderPos,
  worldOf,
} from '@iron-ridge/engine';
import { strategicKnowledge } from './lib/strategicVisibility.ts';
import { buildStrategicScene } from './render/buildScene.ts';
import { TEAM_COLOR } from './render/spec.ts';
import { NodePanel } from './components/game/NodePanel.tsx';
import { StrategicSidebar } from './components/game/StrategicSidebar.tsx';
import { SupplyPanel } from './components/game/SupplyPanel.tsx';
import { RoadRepairPanel } from './components/game/RoadRepairPanel.tsx';
import { useGameStore } from './stores/useGameStore.ts';
import { usePanelStore } from './stores/usePanelStore.ts';

function fixture(infrastructure = false): GameState {
  return createGame({
    ...defaultSettings(),
    grid: { mainCols: 7, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human', B: 'human' },
    ...(infrastructure ? { infrastructure: createFoundationPlaytestConfiguration(7, 3) } : {}),
  });
}

function partialEnemyNode(): { game: GameState; site: CampaignNodeSite; anchor: string } {
  const game = createGame({
    ...defaultSettings(),
    seed: 984311,
    grid: { mainCols: 7, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human', B: 'human' },
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
  const { world, terrain } = worldOf(game);
  terrain.heights.fill(1);
  const eye = game.armies.find((holder) => holder.team === 'A' && holder.kind === 'commander')!;
  const site = game.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'B')!;
  const main = world.mainByKey.get(site.mainHex)!;
  const anchor = world.subs.find((cell) => {
    setHolderPos(world, eye, cell.key);
    const visible = engine.strategicVisibleCells(game, 'A');
    return main.subKeys.some((key) => visible.has(key)) && !visible.has(site.centerSubHex);
  })!;
  expect(anchor).toBeDefined();
  return { game, site, anchor: anchor.key };
}

beforeEach(() => {
  act(() => {
    useGameStore.getState().quit();
    usePanelStore.setState({ collapsed: {}, autoCollapse: false });
  });
});

describe('GAMES-ELEVATE-WORLD-UC-002: ownership through strategic fog', () => {
  it('does not enumerate hidden hostile buildings when only a MainHex edge is visible', () => {
    const { game, site } = partialEnemyNode();
    const knowledge = strategicKnowledge(game, 'A');
    expect(knowledge.mains.has(site.mainHex)).toBe(true);
    expect(knowledge.cells.has(site.centerSubHex)).toBe(false);
    expect(
      campaignNodeActionChoices(game, site.nodeId).some((choice) =>
        /Upgrade.*Town center/i.test(choice.label),
      ),
    ).toBe(true);
    render(<NodePanel game={game} mainHex={site.mainHex} canAct={false} view="A" />);
    expect(screen.getByText('Node state').parentElement).toHaveTextContent('UNKNOWN');
    expect(screen.queryByLabelText('Node order')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('retains legal activation of an observed neutral site without exposing other teams’ work choices', () => {
    const game = fixture(true);
    const { world } = worldOf(game);
    const site = game.infrastructure!.sites.find(
      (candidate) =>
        game.infrastructure!.capture.nodes.find((node) => node.id === candidate.nodeId)!.owner ===
        null,
    )!;
    const eye = game.armies.find((holder) => holder.team === 'A' && holder.kind === 'commander')!;
    setHolderPos(world, eye, site.annexSubHexes[0]!);
    refreshCampaignNodeSnapshot(game);
    const legal = campaignNodeActionChoices(game, site.nodeId).filter(
      (choice) => choice.legal && choice.request.kind === 'activate',
    );
    expect(legal.length).toBeGreaterThan(0);
    expect(strategicKnowledge(game, 'A').cells.has(site.centerSubHex)).toBe(true);
    render(<NodePanel game={game} mainHex={site.mainHex} canAct view="A" />);
    expect(screen.getByLabelText('Node order')).toBeInTheDocument();
    for (const choice of legal)
      expect(
        screen.getByRole('option', { name: `${choice.label} · ${choice.cpCost} CP` }),
      ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /unavailable/ })).not.toBeInTheDocument();
  });

  it('hides wholly occluded damaged roads while keeping fog-off and omniscient inspection', () => {
    const base = fixture(true);
    const site = base.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'B')!;
    const game = createGame({
      ...base.settings,
      infrastructure: {
        ...base.settings.infrastructure!,
        roads: [
          {
            id: 'hidden-Bravo-road',
            mainHex: site.mainHex,
            path: [site.centerSubHex, site.annexSubHexes[0]!],
            damaged: true,
          },
        ],
      },
    });
    expect(strategicKnowledge(game, 'A').mains.has(site.mainHex)).toBe(false);
    const { container, rerender } = render(
      <RoadRepairPanel game={game} mainHex={site.mainHex} canAct={false} view="A" />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<RoadRepairPanel game={game} mainHex={site.mainHex} canAct={false} view={null} />);
    expect(screen.getByLabelText('Road repair order')).toBeInTheDocument();
    const open = structuredClone(game);
    open.settings.fog = false;
    rerender(<RoadRepairPanel game={open} mainHex={site.mainHex} canAct={false} view="A" />);
    expect(screen.getByLabelText('Road repair order')).toBeInTheDocument();
  });

  it('hides a damaged road when even one cell of its path remains occluded', () => {
    const { game: base, site, anchor } = partialEnemyNode();
    const { world } = worldOf(base);
    const knowledge = strategicKnowledge(base, 'A');
    const main = world.mainByKey.get(site.mainHex)!;
    const visible = main.subKeys.find(
      (key) =>
        knowledge.cells.has(key) &&
        main.subKeys.some(
          (other) =>
            !knowledge.cells.has(other) &&
            hexDistance(world.subByKey.get(key)!.hex, world.subByKey.get(other)!.hex) === 1,
        ),
    )!;
    const hidden = main.subKeys.find(
      (key) =>
        !knowledge.cells.has(key) &&
        hexDistance(world.subByKey.get(visible)!.hex, world.subByKey.get(key)!.hex) === 1,
    )!;
    const game = createGame({
      ...base.settings,
      infrastructure: {
        ...base.settings.infrastructure!,
        roads: [
          {
            id: 'partly-hidden-road',
            mainHex: site.mainHex,
            path: [visible, hidden],
            damaged: true,
          },
        ],
      },
    });
    const eye = game.armies.find((holder) => holder.team === 'A' && holder.kind === 'commander')!;
    setHolderPos(world, eye, anchor);
    expect(strategicKnowledge(game, 'A').cells.has(visible)).toBe(true);
    expect(strategicKnowledge(game, 'A').cells.has(hidden)).toBe(false);
    const { container } = render(
      <RoadRepairPanel game={game} mainHex={site.mainHex} canAct={false} view="A" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('reuses tile visibility across hover rebuilds and invalidates it when an observer moves', () => {
    const game = fixture();
    const { world } = worldOf(game);
    const observer = game.armies.find(
      (holder) => holder.team === 'A' && holder.kind === 'commander',
    )!;
    const spy = vi.spyOn(engine, 'strategicVisibleCells');
    try {
      const first = strategicKnowledge(game, 'A');
      buildStrategicScene(game, { ...useGameStore.getState().ui, hoverCell: observer.pos }, 'A');
      buildStrategicScene(game, { ...useGameStore.getState().ui, hoverCell: null }, 'A');
      expect(spy).toHaveBeenCalledTimes(1);
      const next = world.mainByKey.get(observer.at)!.subKeys.find((key) => key !== observer.pos)!;
      setHolderPos(world, observer, next);
      expect(strategicKnowledge(game, 'A')).not.toBe(first);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('renders unknown neutral and enemy ownership identically, including HQs and fortifications', () => {
    const game = fixture();
    const hidden = game.hq.B;
    game.ownershipKnowledge!.A = {};
    const ui = useGameStore.getState().ui;
    expect(strategicKnowledge(game, 'A').mains.has(hidden)).toBe(false);
    expect(strategicKnowledge(game, 'A').owners.has(hidden)).toBe(false);
    const enemy = buildStrategicScene(game, ui, 'A', 'control');
    game.hexes[hidden]!.owner = null;
    const neutral = buildStrategicScene(game, ui, 'A', 'control');
    expect(neutral).toEqual(enemy);
    const { world } = worldOf(game);
    for (const key of world.mainByKey.get(hidden)!.subKeys)
      expect(enemy.cells.find((cell) => cell.key === key)!.fort).toBe(0);
    expect(enemy.tokens.some((token) => token.id === 'hq-B')).toBe(false);
  });

  it('retains observed territory color and frontiers without consulting unseen neighboring ownership', () => {
    const game = fixture();
    const hidden = game.hq.B;
    const { world } = worldOf(game);
    const neighbor = mainNeighbors(world, hidden).find((main) => main.col === 5)!;
    game.ownershipKnowledge!.A = { [hidden]: 'B' };
    const ui = useGameStore.getState().ui;
    const before = structuredClone(game);
    const known = buildStrategicScene(game, ui, 'A', 'control');
    expect(game).toEqual(before);
    expect(
      known.borders.find((border) => border.color === TEAM_COLOR.B)!.segments.length,
    ).toBeGreaterThan(0);
    game.hexes[neighbor.key]!.owner = 'B';
    game.hexes[hidden]!.owner = null;
    const changedUnseenTruth = buildStrategicScene(game, ui, 'A', 'control');
    expect(changedUnseenTruth).toEqual(known);
    expect(strategicKnowledge(game, 'A').owners.get(hidden)).toBe('B');
    expect(strategicKnowledge(game, 'B').owners.get(hidden)).toBeNull();
    expect(strategicKnowledge(game, null).owners.get(hidden)).toBeNull();
  });

  it('shows last observed owner in the sidebar and hides current node owner, claims and buildings', () => {
    const game = fixture(true);
    const hidden = game.hq.B;
    game.ownershipKnowledge!.A[hidden] = null;
    game.log.push({ turn: 1, team: 'B', text: 'BRAVO takes hidden territory' });
    act(() =>
      useGameStore.setState({ game, ui: { ...useGameStore.getState().ui, selectedMain: hidden } }),
    );
    const before = structuredClone(game);
    render(<StrategicSidebar game={game} view="A" canAct={false} />);
    expect(screen.getByText('Owner').parentElement).toHaveTextContent('NEUTRAL');
    expect(screen.getByText(/Last observed owner/)).toBeInTheDocument();
    expect(screen.getByText(/Node details are hidden by fog of war/)).toBeInTheDocument();
    expect(screen.queryByText('Node owner')).not.toBeInTheDocument();
    expect(screen.queryByText('Territorial claim')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Node buildings')).not.toBeInTheDocument();
    expect(screen.queryByText('BRAVO HQ')).not.toBeInTheDocument();
    expect(screen.queryByText(/BRAVO takes hidden territory/)).not.toBeInTheDocument();
    const spec = buildStrategicScene(game, useGameStore.getState().ui, 'A');
    const site = game.infrastructure!.sites.find((candidate) => candidate.mainHex === hidden)!;
    expect(spec.tokens.some((token) => token.id === site.nodeId)).toBe(false);
    expect(
      spec.overlays.some((overlay) =>
        [site.centerSubHex, ...site.annexSubHexes].includes(overlay.key),
      ),
    ).toBe(false);
    expect(game).toEqual(before);
  });

  it('does not expose the other human’s current building allowances or supply network', () => {
    const game = fixture(true);
    game.active = 'B';
    render(
      <>
        <NodePanel game={game} mainHex={game.hq.B} canAct={false} view="A" />
        <SupplyPanel game={game} mainHex={game.hq.B} view="A" />
      </>,
    );
    expect(screen.queryByText('Building operations left')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Node supply' })).not.toBeInTheDocument();
  });

  it('leaves omniscient and fog-disabled inspection fully available', () => {
    const game = fixture(true);
    const hidden = game.hq.B;
    const ui = useGameStore.getState().ui;
    expect(strategicKnowledge(game, null).owners.get(hidden)).toBe('B');
    expect(buildStrategicScene(game, ui, null).tokens.some((token) => token.team === 'B')).toBe(
      true,
    );
    game.settings.fog = false;
    expect(strategicKnowledge(game, 'A').mains.has(hidden)).toBe(true);
    render(<NodePanel game={game} mainHex={hidden} canAct={false} view={null} />);
    expect(screen.getByText('Node owner').parentElement).toHaveTextContent('BRAVO');
    expect(screen.getByLabelText('Node buildings')).toBeInTheDocument();
  });
});

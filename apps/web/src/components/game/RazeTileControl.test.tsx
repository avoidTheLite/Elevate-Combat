import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  apply,
  campaignBuildingData,
  campaignNodeActionChoices,
  campaignNodeEffects,
  contextFor,
  createBattle,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  mainNeighbors,
  refreshCampaignNodeSnapshot,
  setHolderPos,
  syncCampaignClaims,
  worldOf,
} from '@iron-ridge/engine';
import type { GameState } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { buildTacticalScene } from '../../render/buildScene.ts';
import { TacticalSidebar } from './TacticalSidebar.tsx';

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
});

function fixture(stationed = false): {
  game: GameState;
  unitId: string;
  buildingId: string;
  nodeId: string;
  tile: string;
} {
  let game = createGame({
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 3 },
    controllers: { A: 'human', B: 'human' },
    fog: false,
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
  const bTurn = apply(game, { type: 'endTurn' });
  if (bTurn.error) throw new Error(bTurn.error);
  game = bTurn.state;
  const nodeId = game.infrastructure!.sites.find((site) => site.homeTeam === 'B')!.nodeId;
  const build = campaignNodeActionChoices(game, nodeId).find(
    (choice) =>
      choice.legal && choice.request.kind === 'build' && choice.request.definitionId === 'workshop',
  )!;
  if (!build) throw new Error('Fixture workshop build is unavailable');
  const built = apply(game, { type: 'nodeWork', request: build.request });
  if (built.error) throw new Error(built.error);
  const aTurn = apply(built.state, { type: 'endTurn' });
  if (aTurn.error) throw new Error(aTurn.error);
  game = aTurn.state;
  const building = game
    .infrastructure!.capture.nodes.find((node) => node.id === nodeId)!
    .buildings.find((candidate) => campaignBuildingData(candidate).definitionId === 'workshop')!;
  const tile = campaignBuildingData(building).subHex;
  const { world } = worldOf(game);
  const attacker = game.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
  const defender = game.armies.find((army) => army.team === 'B' && army.kind === 'commander')!;
  const origin = mainNeighbors(world, defender.at).find(
    (main) => game.hexes[main.key].owner === null,
  )!;
  const position = origin.subKeys.find((key) => !game.armies.some((army) => army.pos === key))!;
  setHolderPos(world, attacker, position);
  const unitId = attacker.units[0].id;
  if (stationed) {
    const [guard] = attacker.units.splice(0, 1);
    game.armies.push({
      id: 'workshop-guard',
      team: 'A',
      kind: 'garrison',
      building: 'temporary',
      pos: tile,
      at: defender.at,
      units: [guard],
      movesLeft: 0,
      stationedFacing: 4,
    });
  }
  const battle = createBattle(game, attacker, defender, attacker.at, defender.at, world);
  const cells = battle.mains
    .flatMap((main) => world.mainByKey.get(main)!.subKeys)
    .filter((key) => key !== tile);
  for (const unit of battle.units) {
    unit.pos = unit.id === unitId ? tile : cells.shift()!;
    unit.acted = false;
  }
  battle.phase = 'combat';
  battle.active = 'A';
  battle.round = 1;
  game.phase = 'battle';
  game.battle = battle;
  syncCampaignClaims(game);
  refreshCampaignNodeSnapshot(game);
  return { game, unitId, buildingId: building.id, nodeId, tile };
}

function Harness(): React.ReactElement {
  const game = useGameStore((state) => state.game)!;
  return <TacticalSidebar game={game} ctx={contextFor(game)} view={null} canAct seenIds={null} />;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: Raze Tile through the actual tactical UI', () => {
  it('spends ACT and movement but no CP/work, updates the overlay immediately and resumes the exact saved battle', () => {
    const prepared = fixture();
    act(() => {
      useGameStore.setState({ game: prepared.game });
      useGameStore.getState().setUi({ selectedUnit: prepared.unitId });
    });
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /Capture Tile/ })).not.toBeInTheDocument();
    const cp = { ...prepared.game.cp };
    const work = structuredClone(prepared.game.infrastructure!.capture.work);
    const data = structuredClone(
      prepared.game
        .infrastructure!.capture.nodes.find((node) => node.id === prepared.nodeId)!
        .buildings.find((building) => building.id === prepared.buildingId)!.data,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Raze Tile (1 ACT · 0 CP)' }));
    const saved = structuredClone(useGameStore.getState().game!);
    expect(saved.battle!.units.find((unit) => unit.id === prepared.unitId)).toMatchObject({
      acted: true,
      mp: 0,
      pos: prepared.tile,
    });
    expect(saved.cp).toEqual(cp);
    expect(saved.infrastructure!.capture.work).toMatchObject({
      commandPoints: work.commandPoints,
      nodeSpending: work.nodeSpending,
      engineerSpending: work.engineerSpending,
      receipts: work.receipts,
    });
    expect(saved.battle!.ruinedInfrastructureBuildingIds).toContain(prepared.buildingId);
    expect(
      campaignNodeEffects(saved, prepared.nodeId).some(
        (building) => building.buildingId === prepared.buildingId,
      ),
    ).toBe(false);
    expect(
      saved
        .infrastructure!.capture.nodes.find((node) => node.id === prepared.nodeId)!
        .buildings.find((building) => building.id === prepared.buildingId)!.data,
    ).toEqual(data);
    const scene = buildTacticalScene(saved, useGameStore.getState().ui, null).spec;
    expect(scene.overlays).toContainEqual(
      expect.objectContaining({ key: prepared.tile, color: 0xffa03c }),
    );
    expect(screen.getByRole('button', { name: 'Raze Tile (1 ACT · 0 CP)' })).toBeDisabled();
    expect(screen.getByText('Unit already acted')).toBeInTheDocument();
    const exported = useGameStore.getState().exportSave()!;
    act(() => {
      useGameStore.getState().quit();
      expect(useGameStore.getState().importSave(exported.text)).toBe(true);
    });
    expect(useGameStore.getState().game).toEqual(saved);
  });

  it('permits a stationed unit to Raze Tile in place while retaining no movement or rotation controls', () => {
    const prepared = fixture(true);
    act(() => {
      useGameStore.setState({ game: prepared.game });
      useGameStore.getState().setUi({ selectedUnit: prepared.unitId });
    });
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /FACE|PACK UP|DIG IN/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raze Tile (1 ACT · 0 CP)' }));
    const next = useGameStore.getState().game!;
    expect(next.battle!.units.find((unit) => unit.id === prepared.unitId)).toMatchObject({
      stationed: true,
      acted: true,
      mp: 0,
      pos: prepared.tile,
      facing: 4,
    });
    const invalidMove = apply(next, {
      type: 'move',
      unitId: prepared.unitId,
      cell: next.battle!.units.find((unit) => unit.id !== prepared.unitId)!.pos!,
    });
    expect(invalidMove.error).toBeTruthy();
    expect(invalidMove.state).toBe(next);
  });

  it('explains the exact-tile requirement without offering an adjacent or center takeover action', () => {
    const prepared = fixture();
    const unit = prepared.game.battle!.units.find((candidate) => candidate.id === prepared.unitId)!;
    unit.pos = [...contextFor(prepared.game).cells.keys()].find(
      (cell) => !prepared.game.battle!.units.some((candidate) => candidate.pos === cell),
    )!;
    refreshCampaignNodeSnapshot(prepared.game);
    act(() => {
      useGameStore.setState({ game: prepared.game });
      useGameStore.getState().setUi({ selectedUnit: prepared.unitId });
    });
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Raze Tile' })).toBeDisabled();
    expect(
      screen.getByText(
        'Stand on an enemy annex upgrade to Raze Tile. Center choices are Capture Node and Raze Node.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Capture Tile|Capture Node|Raze Node/ }),
    ).not.toBeInTheDocument();
    expect(prepared.game.battle!.ruinedInfrastructureBuildingIds).toBeUndefined();
  });
});

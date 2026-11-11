import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  contextFor,
  apply,
  campaignNodeActionChoices,
  campaignNodeViews,
  commanderReach,
  canSee,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  hexDistance,
  parseKey,
  reachable,
  refreshCampaignNodeSnapshot,
  setHolderPos,
  validateGameState,
  worldOf,
} from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { chooseTileEntity, inspectTile, visibleTileEntities } from '../../lib/selection.ts';
import { regularPlaytestSettings } from '../../lib/campaignScenarios.ts';
import { alphaGarrison, commanderOf, strategicGame } from '../../lib/testGames.ts';
import { createMovementDemo, movementDemoFocus } from '../../controls/demoScenario.ts';
import { blindFireFixture } from '../../controls/reviewFixtures.ts';
import { useMapControls } from '../../controls/useMapControls.ts';
import { saveControlPreferences, readControlPreferences } from '../../controls/preferences.ts';
import { MapCallouts } from '../../controls/MapCallouts.tsx';
import { StrategicSidebar } from './StrategicSidebar.tsx';
import { TacticalSidebar } from './TacticalSidebar.tsx';
import { createFoundationDemoScenario } from '../../foundation/demoScenarios.ts';
import { useNodePlacementStore } from '../../stores/useNodePlacementStore.ts';
import { holderForClick, nearbyHqForTile } from '../../lib/holders.ts';
import { selectableAt } from '../../controls/commands.ts';

function emptyHqNeighbor(game: ReturnType<typeof strategicGame>): string {
  const hq = alphaGarrison(game);
  const cell = worldOf(game).world.subs.find(
    (candidate) =>
      candidate.key !== hq.pos &&
      !game.armies.some((holder) => holder.pos === candidate.key) &&
      holderForClick(game, 'A', candidate.key)?.id === hq.id,
  );
  if (!cell) throw new Error('Fixture requires an actually empty HQ ring subhex');
  return cell.key;
}

const store = (): ReturnType<typeof useGameStore.getState> => useGameStore.getState();
beforeEach(() => {
  localStorage.clear();
  store().quit();
  useNodePlacementStore.getState().cancelPlacement();
});

function tactical(): ReturnType<typeof createMovementDemo> {
  const game = createMovementDemo();
  useGameStore.setState({ game, handoff: null });
  store().setUi(movementDemoFocus(game));
  return game;
}
function TacticalContext(): React.ReactElement {
  const game = useGameStore((s) => s.game)!;
  return <TacticalSidebar game={game} ctx={contextFor(game)} view={null} canAct seenIds={null} />;
}
function StrategicContext(): React.ReactElement {
  const game = useGameStore((s) => s.game)!;
  return <StrategicSidebar game={game} view={null} canAct />;
}

describe('persistent tile and entity context', () => {
  it.each([false, true])(
    'GAMES-ELEVATE-CAMPAIGN-UC-002: empty HQ neighbor inspection has no proxy occupant and retains the prior actor (%s)',
    (hasActor) => {
      const game = strategicGame(true);
      const neighbor = emptyHqNeighbor(game);
      const actor = hasActor ? commanderOf(game, 'A').id : null;
      useGameStore.setState({ game, handoff: null });
      store().setUi({ selectedArmy: actor });
      const before = structuredClone(game);
      expect(holderForClick(game, 'A', neighbor)?.id).toBe(alphaGarrison(game).id);
      expect(visibleTileEntities(game, neighbor)).toEqual([]);
      for (let i = 0; i < 5; i++) {
        act(() => inspectTile(game, neighbor));
        expect(store().ui.inspectedCell).toBe(neighbor);
        expect(store().ui.selectedArmy).toBe(actor);
        expect(store().ui.selectedEntity).toBeNull();
      }
      expect(store().game).toEqual(before);
    },
  );
  it.each(['classic', 'ready'] as const)(
    'GAMES-ELEVATE-CAMPAIGN-UC-002: %s explicit nearby HQ selection inspects its real tile without spending',
    (preset) => {
      const game = preset === 'ready' ? createGame(regularPlaytestSettings()) : strategicGame(true);
      const neighbor = emptyHqNeighbor(game);
      const hq = alphaGarrison(game);
      useGameStore.setState({ game, handoff: null });
      act(() => inspectTile(game, neighbor));
      render(<StrategicContext />);
      expect(screen.queryByTestId('entity-context-body')).not.toBeInTheDocument();
      expect(selectableAt(game, neighbor)).toEqual([]);
      // A stale occupant choice cannot treat the off-tile HQ as being here.
      act(() => chooseTileEntity(game, neighbor, hq.id));
      expect(store().ui.selectedArmy).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'SELECT NEARBY HQ' }));
      expect(store().ui.inspectedCell).toBe(hq.pos);
      expect(store().ui.selectedEntity).toBe(
        visibleTileEntities(game, hq.pos).find((e) => e.id === hq.id || e.kind === 'node')!.id,
      );
      expect(screen.queryByRole('button', { name: 'SELECT NEARBY HQ' })).not.toBeInTheDocument();
      expect(store().game).toBe(game);
      const selected = store().ui.selectedArmy;
      act(() => inspectTile(game, neighbor));
      expect(store().ui.selectedArmy).toBe(selected);
      expect(screen.queryByTestId('entity-context-body')).not.toBeInTheDocument();
      expect(store().game).toBe(game);
    },
  );

  it.each([false, true])(
    'GAMES-ELEVATE-CAMPAIGN-UC-002: HQ ring clicks inspect; explicit MOVE alone spends the legal cost (QuickMove %s)',
    (quickMove) => {
      const game = strategicGame(true);
      const actor = commanderOf(game, 'A');
      const reach = commanderReach(game, actor);
      const neighbor = [...reach.keys()].find(
        (key) =>
          key !== actor.pos && nearbyHqForTile(game, 'A', key)?.id === alphaGarrison(game).id,
      )!;
      expect(neighbor).toBeDefined();
      useGameStore.setState({ game, handoff: null });
      store().setUi({ selectedArmy: actor.id });
      const { result } = renderHook(() =>
        useMapControls(
          useGameStore((s) => s.game)!,
          useGameStore((s) => s.ui),
          false,
        ),
      );
      act(() => result.current.setPreference({ quickMove }));
      for (let i = 0; i < 4; i++) {
        act(() =>
          result.current.interact({
            source: 'click',
            originKey: null,
            targetKey: neighbor,
            button: 0,
          }),
        );
        expect(store().ui.inspectedCell).toBe(neighbor);
        expect(store().ui.selectedArmy).toBe(actor.id);
        expect(result.current.pending).toBeNull();
        expect(store().game).toBe(game);
      }
      act(() =>
        result.current.interact({
          source: 'context',
          originKey: null,
          targetKey: neighbor,
          button: 0,
        }),
      );
      expect(result.current.targetOccupants).toEqual([]);
      expect(result.current.nearbyHq?.pos).toBe(alphaGarrison(game).pos);
      render(<MapCallouts controls={result.current} />);
      expect(screen.getByRole('button', { name: 'SELECT NEARBY HQ' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'MOVE' }));
      if (!quickMove) {
        expect(store().game).toBe(game);
        expect(result.current.pending?.command.target).toBe(neighbor);
        act(() => result.current.confirm());
      }
      const moved = commanderOf(store().game!, 'A');
      expect(moved.pos).toBe(neighbor);
      expect(moved.movesLeft).toBe(actor.movesLeft - reach.get(neighbor)!);
      const committed = store().game;
      act(() => result.current.confirm());
      expect(store().game).toBe(committed);
      expect(validateGameState(store().game!)).toEqual([]);
    },
  );

  it('GAMES-ELEVATE-CAMPAIGN-UC-002: nearby HQ navigation respects fog and yields to a real commander', () => {
    const game = strategicGame(true);
    const enemyHq = game.armies.find((h) => h.team === 'B' && h.building === 'hq')!;
    const enemyRing = worldOf(game).world.subs.find(
      (c) => c.key !== enemyHq.pos && holderForClick(game, null, c.key)?.id === enemyHq.id,
    )!.key;
    expect(nearbyHqForTile(game, 'A', enemyRing)).toBeUndefined();
    expect(visibleTileEntities(game, enemyRing, 'A')).toEqual([]);
    expect(selectableAt(game, enemyRing)).toEqual([]);
    useGameStore.setState({ game, handoff: null });
    store().setUi({ inspectedCell: enemyRing });
    render(<StrategicSidebar game={game} view="A" canAct />);
    expect(screen.queryByRole('button', { name: 'SELECT NEARBY HQ' })).not.toBeInTheDocument();
    const neighbor = emptyHqNeighbor(game);
    const actor = commanderOf(game, 'A');
    setHolderPos(worldOf(game).world, actor, neighbor);
    expect(nearbyHqForTile(game, 'A', neighbor)).toBeUndefined();
    expect(visibleTileEntities(game, neighbor).map((e) => e.id)).toEqual([actor.id]);
    act(() => inspectTile(game, neighbor));
    expect(store().ui.selectedArmy).toBe(actor.id);
    expect(holderForClick(game, 'A', neighbor)?.id).toBe(actor.id);
  });

  it('offers separate commander and actual annex building cards without node-wide roster panels', () => {
    let game = createGame({
      ...defaultSettings(),
      fog: false,
      infrastructure: createFoundationPlaytestConfiguration(7, 3),
    });
    const node = campaignNodeViews(game).find((candidate) => candidate.mainHex === game.hq.A)!;
    const quote = campaignNodeActionChoices(game, node.nodeId).find(
      (choice) =>
        choice.legal &&
        choice.request.kind === 'build' &&
        choice.request.definitionId === 'workshop',
    )!;
    const built = apply(game, { type: 'nodeWork', request: quote.request });
    expect(built.error).toBeNull();
    game = built.state;
    const workshop = campaignNodeViews(game)
      .find((candidate) => candidate.nodeId === node.nodeId)!
      .buildings.find((building) => building.name === 'Workshop')!;
    setHolderPos(worldOf(game).world, commanderOf(game, 'A'), workshop.subHex);
    expect(validateGameState(game)).toEqual([]);
    useGameStore.setState({ game });
    act(() => inspectTile(game, workshop.subHex));
    expect(visibleTileEntities(game, workshop.subHex).map((entity) => entity.kind)).toEqual([
      'holder',
      'building',
    ]);
    expect(store().ui.selectedArmy).toBeNull();
    render(<StrategicContext />);
    expect(screen.getAllByTestId('entity-context-body')).toHaveLength(2);
    expect(screen.queryByText(/SUPPLY NETWORK|RECRUIT → NODE GARRISON/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select Workshop' }));
    expect(store().ui.selectedArmy).toBeNull();
    expect(screen.getAllByTestId('entity-context-body')).toHaveLength(1);
    expect(store().ui.selectedEntity).toBe(`building:${workshop.id}`);
    expect(store().game).toBe(game);
  });

  it('inspects a valid tactical unit and Workshop together and keeps direct Raze Tile available before a choice', () => {
    const game = createFoundationDemoScenario('annex-raid', 7, 3, 'ww2', 15);
    const node = campaignNodeViews(game).find((candidate) =>
      candidate.buildings.some((building) => building.name === 'Workshop'),
    )!;
    const workshop = node.buildings.find((building) => building.name === 'Workshop')!;
    expect(validateGameState(game)).toEqual([]);
    useGameStore.setState({ game });
    const { result } = renderHook(() =>
      useMapControls(
        useGameStore((s) => s.game)!,
        useGameStore((s) => s.ui),
        false,
      ),
    );
    act(() =>
      result.current.interact({
        source: 'click',
        originKey: null,
        targetKey: workshop.subHex,
        button: 0,
      }),
    );
    expect(store().ui.selectedUnit).toBeNull();
    expect(result.current.actor).toBeNull();
    expect(result.current.pending).toBeNull();
    expect(visibleTileEntities(game, workshop.subHex).map((entity) => entity.kind)).toEqual([
      'unit',
      'building',
    ]);
    expect(
      visibleTileEntities(game, node.centerSubHex).filter((entity) => entity.kind === 'node'),
    ).toHaveLength(1);
    expect(
      visibleTileEntities(game, node.centerSubHex).filter((entity) => entity.kind === 'building'),
    ).toHaveLength(0);
    render(<TacticalContext />);
    expect(screen.getAllByTestId('entity-context-body')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Build |Upgrade / })).not.toBeInTheDocument();
    const raze = screen.getByRole('button', { name: /Raze Tile/ });
    expect(raze).toBeEnabled();
    fireEvent.click(raze);
    expect(store().ui.selectedUnit).toBeNull();
    expect(screen.getByText('RUINED')).toBeInTheDocument();
    expect(validateGameState(store().game!)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Select Workshop' }));
    expect(screen.getAllByTestId('entity-context-body')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Raze Tile/ })).not.toBeInTheDocument();
  });

  it('does not reveal an unseen tactical annex building or allow choosing its card', () => {
    const game = createFoundationDemoScenario('annex-raid', 7, 3, 'ww2', 15);
    game.settings.fog = true;
    game.settings.controllers = { A: 'human', B: 'ai' };
    const workshop = campaignNodeViews(game)
      .flatMap((node) => node.buildings)
      .find((building) => building.name === 'Workshop')!;
    const ctx = contextFor(game);
    const occupied = new Set(
      game.battle!.units.filter((unit) => unit.team === 'B').map((unit) => unit.pos),
    );
    const candidates = [...ctx.cells].sort(
      (a, b) =>
        hexDistance(parseKey(b), parseKey(workshop.subHex)) -
        hexDistance(parseKey(a), parseKey(workshop.subHex)),
    );
    for (const unit of game.battle!.units.filter((candidate) => candidate.team === 'A')) {
      unit.pos = candidates.find((cell) => {
        unit.pos = cell;
        return !occupied.has(cell) && !canSee(ctx, unit, workshop.subHex);
      })!;
      expect(unit.pos).toBeDefined();
      occupied.add(unit.pos);
    }
    expect(validateGameState(game)).toEqual([]);
    useGameStore.setState({ game });
    act(() => inspectTile(game, workshop.subHex));
    expect(visibleTileEntities(game, workshop.subHex)).toEqual([]);
    act(() => chooseTileEntity(game, workshop.subHex, `building:${workshop.id}`));
    expect(store().ui.selectedEntity).toBeNull();
    render(
      <TacticalSidebar
        game={game}
        ctx={contextFor(game)}
        view="A"
        canAct
        seenIds={
          new Set(game.battle!.units.filter((unit) => unit.team === 'A').map((unit) => unit.id))
        }
      />,
    );
    expect(screen.queryByRole('button', { name: 'Select Workshop' })).not.toBeInTheDocument();
    expect(screen.queryByText('Workshop')).not.toBeInTheDocument();
  });

  it('keeps node placement confirmation visible after inspecting the chosen empty annex tile', () => {
    const game = createGame({
      ...defaultSettings(),
      fog: false,
      infrastructure: createFoundationPlaytestConfiguration(7, 3),
    });
    const node = campaignNodeViews(game).find((candidate) => candidate.mainHex === game.hq.A)!;
    useGameStore.setState({ game });
    act(() => inspectTile(game, node.centerSubHex));
    render(<StrategicContext />);
    fireEvent.click(screen.getByRole('button', { name: 'Build at node' }));
    fireEvent.click(screen.getByRole('button', { name: /Build Workshop T1 3 CP/ }));
    const quote = campaignNodeActionChoices(game, node.nodeId).find(
      (choice) =>
        choice.legal &&
        choice.request.kind === 'build' &&
        choice.request.definitionId === 'workshop',
    )!;
    if (quote.request.kind !== 'build') throw new Error('Expected build quote');
    const tile = quote.request.subHex;
    act(() => {
      expect(useNodePlacementStore.getState().selectTile(game, tile)).toBe(true);
      store().setUi({ inspectedCell: tile, selectedMain: node.mainHex });
    });
    expect(store().game).toBe(game);
    const confirm = screen.getByRole('button', { name: 'Confirm build (3 CP)' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(store().game!.cp.A).toBe(game.cp.A - 3);
    expect(
      visibleTileEntities(store().game!, tile).some((entity) => entity.kind === 'building'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Select Workshop' })).toBeInTheDocument();
  });

  it('refreshes map preferences when Settings changes them without executing an order', () => {
    const game = tactical();
    const { result } = renderHook(() =>
      useMapControls(
        useGameStore((s) => s.game)!,
        useGameStore((s) => s.ui),
        false,
      ),
    );
    act(() => saveControlPreferences({ ...readControlPreferences(), quickMove: true }));
    expect(result.current.preferences.quickMove).toBe(true);
    expect(store().game).toBe(game);
    expect(result.current.pending).toBeNull();
  });

  it('has no empty sidebar or global status panels before an inspection', () => {
    const game = strategicGame(false);
    useGameStore.setState({ game });
    const { container, rerender } = render(<StrategicContext />);
    expect(container).toBeEmptyDOMElement();
    const battle = createMovementDemo();
    act(() => useGameStore.setState({ game: battle }));
    rerender(<TacticalContext />);
    expect(container).toBeEmptyDOMElement();
  });

  it('inspects an empty legal tactical destination without staging or spending, while retaining its actor', () => {
    const game = tactical();
    const actor = game.battle!.units.find((u) => u.id === store().ui.selectedUnit)!;
    const ctx = contextFor(game);
    const key = [...reachable(ctx, actor).keys()].find(
      (cell) => cell !== actor.pos && !ctx.unitAt.has(cell),
    )!;
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
        targetKey: key,
        button: 0,
        pointerType: 'touch',
      }),
    );
    expect(store().ui.inspectedCell).toBe(key);
    expect(store().ui.selectedUnit).toBe(actor.id);
    expect(result.current.pending).toBeNull();
    expect(store().game).toBe(game);
    render(<TacticalContext />);
    expect(screen.getByText(`[ TILE ${key} ]`)).toBeInTheDocument();
    expect(screen.queryByTestId('unit-detail')).not.toBeInTheDocument();
    expect(screen.queryByText(/BATTLE FOR|COMBAT LOG|END TURN|RETREAT/)).not.toBeInTheDocument();
  });

  it('immediately chooses one entity, and repeated tile inspection keeps it selected', () => {
    const game = tactical();
    const unit = game.battle!.units.find((u) => u.team === 'A')!;
    act(() => inspectTile(game, unit.pos!));
    expect(store().ui.selectedUnit).toBe(unit.id);
    expect(store().ui.selectedEntity).toBe(unit.id);
    act(() => inspectTile(game, unit.pos!));
    expect(store().ui.selectedUnit).toBe(unit.id);
    expect(store().game).toBe(game);
  });

  it('opens every real co-occupant card, exposes nearby icons, then focuses the deliberately chosen card', () => {
    const game = createGame({ ...regularPlaytestSettings(), fog: false });
    const site = game.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'A')!;
    const commander = commanderOf(game, 'A');
    setHolderPos(worldOf(game).world, commander, site.centerSubHex);
    expect(validateGameState(game)).toEqual([]);
    useGameStore.setState({ game });
    act(() => inspectTile(game, site.centerSubHex));
    const entities = visibleTileEntities(game, site.centerSubHex);
    expect(entities.map((e) => e.kind)).toEqual(['holder', 'node']);
    expect(store().ui.selectedArmy).toBeNull();
    render(<StrategicContext />);
    expect(screen.getAllByTestId('entity-context-body')).toHaveLength(2);
    const { result } = renderHook(() =>
      useMapControls(
        useGameStore((s) => s.game)!,
        useGameStore((s) => s.ui),
        false,
      ),
    );
    act(() =>
      result.current.setAnchors([
        { key: site.centerSubHex, x: 100, y: 100, radius: 35, width: 70, height: 50 },
      ]),
    );
    const map = render(<MapCallouts controls={result.current} />);
    const icons = screen.getByRole('group', { name: 'Entities on inspected tile' });
    expect(within(icons).getAllByRole('button')).toHaveLength(2);
    expect(icons.style.left).toContain('clamp(');
    expect(icons.style.top).toContain('clamp(');
    const commanderIcon = within(icons).getByRole('button', {
      name: `Select ${entities[0]!.label}`,
    });
    fireEvent.click(commanderIcon, { detail: 1 });
    expect(store().ui.selectedArmy).toBeNull();
    fireEvent.pointerDown(commanderIcon, { button: 0, isPrimary: true });
    fireEvent.pointerCancel(commanderIcon);
    fireEvent.click(commanderIcon, { detail: 1 });
    expect(store().ui.selectedArmy).toBeNull();
    fireEvent.pointerDown(commanderIcon, { button: 0, isPrimary: true });
    fireEvent.click(commanderIcon, { detail: 1 });
    expect(store().ui.selectedArmy).toBe(commander.id);
    expect(screen.getAllByTestId('entity-context-body')).toHaveLength(1);
    const node = entities.find((e) => e.kind === 'node')!;
    fireEvent.click(screen.getAllByRole('button', { name: `Select ${node.label}` })[0]!);
    expect(store().ui.selectedEntity).toBe(node.id);
    expect(store().ui.selectedArmy).toBeNull();
    expect(screen.getAllByTestId('entity-context-body')).toHaveLength(1);
    expect(store().game).toBe(game);
    map.unmount();
  });

  it('runs a direct node action from an expanded unchosen entity card', () => {
    const game = createGame({ ...regularPlaytestSettings(), fog: false });
    const site = game.infrastructure!.sites.find(
      (candidate) =>
        candidate.homeTeam === null &&
        game.infrastructure!.capture.nodes.find((node) => node.id === candidate.nodeId)!.owner ===
          null,
    )!;
    const commander = commanderOf(game, 'A');
    setHolderPos(worldOf(game).world, commander, site.centerSubHex);
    refreshCampaignNodeSnapshot(game);
    useGameStore.setState({ game });
    act(() => inspectTile(game, site.centerSubHex));
    render(<StrategicContext />);
    expect(screen.getAllByTestId('entity-context-body')).toHaveLength(2);
    expect(store().ui.selectedArmy).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Activate.*Town center/i }));
    expect(store().game).toBe(game);
    fireEvent.click(screen.getByRole('button', { name: /Confirm order/i }));
    expect(
      store().game!.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!.owner,
    ).toBe('A');
    expect(store().ui.selectedArmy).toBeNull();
  });

  it('never exposes a hidden hostile entity through cards, icons, or an explicit choice', () => {
    const f = blindFireFixture();
    const enemy = f.battle.units.find((unit) => unit.team === 'B')!;
    enemy.pos = f.target;
    enemy.exposed = false;
    useGameStore.setState({
      game: f.game,
      ui: { ...f.ui, inspectedCell: null, selectedEntity: null },
    });
    act(() => inspectTile(f.game, f.target, 'A'));
    expect(visibleTileEntities(f.game, f.target, 'A')).toEqual([]);
    const actor = store().ui.selectedUnit;
    act(() => chooseTileEntity(f.game, f.target, enemy.id));
    expect(store().ui.selectedUnit).toBe(actor);
    render(
      <TacticalSidebar
        game={f.game}
        ctx={contextFor(f.game)}
        view="A"
        canAct
        seenIds={new Set([f.shooter.id])}
      />,
    );
    expect(screen.queryByText(enemy.label)).not.toBeInTheDocument();
    const detail = screen.getByTestId('target-detail');
    expect(detail).not.toHaveAttribute('open');
    fireEvent.click(within(detail).getByText(/ATTACK BREAKDOWN/));
    expect(detail).toHaveTextContent('Defender statistics are unknown');
    expect(detail.textContent).not.toMatch(/TN |Expected damage|Armor|Hit chance [0-9]/);
    act(() => store().setUi({ selectedUnit: enemy.id }));
    const { result } = renderHook(() =>
      useMapControls(
        useGameStore((s) => s.game)!,
        useGameStore((s) => s.ui),
        false,
      ),
    );
    expect(result.current.actor).toBeNull();
    expect(result.current.actions).toEqual([]);
  });
});

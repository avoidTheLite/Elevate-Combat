import type { Army, BattleUnit, CampaignNodeView, GameState, Team } from '@iron-ridge/engine';
import {
  campaignNodeViews,
  contextFor,
  revealedEnemies,
  visibleCells,
  worldOf,
} from '@iron-ridge/engine';
import { useGameStore, viewTeam } from '../stores/useGameStore.ts';
import type { UiState } from '../stores/useGameStore.ts';
import { holderName, nearbyHqForTile, seenHolders } from './holders.ts';
import { strategicKnowledge } from './strategicVisibility.ts';

export type TileEntity =
  | { kind: 'holder'; id: string; label: string; icon: string; holder: Army }
  | { kind: 'unit'; id: string; label: string; icon: string; unit: BattleUnit }
  | { kind: 'node'; id: string; label: string; icon: string; nodeId: string }
  | {
      kind: 'building';
      id: string;
      label: string;
      icon: string;
      nodeId: string;
      buildingId: string;
      building: CampaignNodeView['buildings'][number];
    };

function infrastructureAt(game: GameState, key: string, observed: boolean): TileEntity[] {
  if (!observed) return [];
  return campaignNodeViews(game).flatMap((node): TileEntity[] => {
    if (node.centerSubHex === key)
      return [
        {
          kind: 'node',
          id: `node:${node.nodeId}`,
          label: node.name,
          icon: '▣',
          nodeId: node.nodeId,
        },
      ];
    return node.buildings
      .filter((building) => building.subHex === key)
      .map((building) => ({
        kind: 'building',
        id: `building:${building.id}`,
        label: building.name,
        icon: '▣',
        nodeId: node.nodeId,
        buildingId: building.id,
        building,
      }));
  });
}

/** Presentation only: use the existing engine visibility and occupancy rules. */
export function visibleTileEntities(
  game: GameState,
  key: string,
  view: Team | null = viewTeam(game),
): TileEntity[] {
  if (game.phase === 'battle' && game.battle) {
    const observer = game.settings.fog ? view : null;
    const ctx = contextFor(game);
    const revealed = observer
      ? new Set(revealedEnemies(ctx, game.battle, observer).map((u) => u.id))
      : null;
    const units: TileEntity[] = game.battle.units
      .filter(
        (u) =>
          u.hp > 0 && u.pos === key && (!observer || u.team === observer || revealed?.has(u.id)),
      )
      .map((unit) => ({ kind: 'unit', id: unit.id, label: unit.label, icon: '◆', unit }));
    return [
      ...units,
      ...infrastructureAt(
        game,
        key,
        ctx.cells.has(key) && (!observer || visibleCells(ctx, game.battle, observer).has(key)),
      ),
    ];
  }
  const knowledge = strategicKnowledge(game, view);
  const infrastructure = infrastructureAt(game, key, knowledge.cells.has(key));
  const node = infrastructure.find((entity) => entity.kind === 'node');
  const holders: TileEntity[] = seenHolders(game, view)
    .filter((holder) => holder.pos === key)
    // A node card includes its garrison roster; do not duplicate that building.
    .filter((holder) => !node || holder.kind !== 'garrison' || holder.building === 'temporary')
    .map((holder) => ({
      kind: 'holder',
      id: holder.id,
      label: holderName(holder),
      icon: holder.kind === 'commander' ? '⚑' : '▣',
      holder,
    }));
  return [...holders, ...infrastructure];
}

function entityPatch(entity: TileEntity): Partial<UiState> {
  return {
    selectedEntity: entity.id,
    selectedUnit: entity.kind === 'unit' ? entity.id : null,
    selectedArmy: entity.kind === 'holder' ? entity.id : null,
    checkedUnits: [],
  };
}

/** Inspecting does not issue an order, including when a movement actor already exists. */
export function inspectTile(
  game: GameState,
  key: string,
  view: Team | null = viewTeam(game),
): void {
  if (useGameStore.getState().game !== game) return;
  const { world } = worldOf(game);
  const cell = world.subByKey.get(key);
  if (!cell || (game.phase === 'battle' && !contextFor(game).cells.has(key))) return;
  const entities = visibleTileEntities(game, key, view);
  useGameStore.getState().setUi({
    inspectedCell: key,
    selectedMain: cell.main,
    selectedEntity: null,
    hoverCell: null,
    ...(entities.length === 1
      ? entityPatch(entities[0]!)
      : entities.length > 1
        ? { selectedArmy: null, selectedUnit: null, checkedUnits: [] }
        : {}),
  });
}

export function chooseTileEntity(game: GameState, key: string, id: string): void {
  if (useGameStore.getState().game !== game) return;
  const entities = visibleTileEntities(game, key);
  let entity = entities.find((candidate) => candidate.id === id);
  if (!entity && game.phase === 'strategic') {
    const represented = seenHolders(game, viewTeam(game)).some(
      (holder) =>
        holder.id === id &&
        holder.pos === key &&
        holder.kind === 'garrison' &&
        holder.building !== 'temporary',
    );
    if (represented) entity = entities.find((candidate) => candidate.kind === 'node');
  }
  if (!entity) return;
  useGameStore.getState().setUi({
    inspectedCell: key,
    hoverCell: null,
    selectedMain: worldOf(game).world.subByKey.get(key)?.main ?? null,
    ...entityPatch(entity),
  });
}

/** Explicit navigation selects the real HQ tile, including its combined node card. */
export function chooseNearbyHq(game: GameState, key: string): void {
  if (useGameStore.getState().game !== game) return;
  const hq = nearbyHqForTile(game, viewTeam(game), key);
  if (!hq) return;
  const entity = visibleTileEntities(game, hq.pos).find(
    (candidate) => candidate.id === hq.id || candidate.kind === 'node',
  );
  if (entity) chooseTileEntity(game, hq.pos, entity.id);
}

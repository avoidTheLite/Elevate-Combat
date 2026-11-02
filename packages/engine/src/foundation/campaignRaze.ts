import type { Battle, GameState } from '../types.ts';
import { unitType } from '../units.ts';
import { campaignBuildingData } from './campaignNodes.ts';
import { foundationHasPending } from './campaign.ts';

export type CampaignRazeTileResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };
export interface CampaignRazeTileQuote {
  readonly unitId: string;
  readonly buildingId: string;
  readonly eligible: boolean;
  readonly reason: string | null;
  readonly actionCost: 1;
  readonly cpCost: 0;
  readonly nodeId?: string;
  readonly subHex?: string;
  readonly label?: string;
}
const failure = (error: string): CampaignRazeTileResult => ({ ok: false, error });

/** Historical tactical damage remains valid after node ownership changes during resolution. */
export function validateCampaignRazeTileState(state: GameState): string | null {
  const ids = state.battle?.ruinedInfrastructureBuildingIds;
  if (ids === undefined) return null;
  if (
    !Array.isArray(ids) ||
    !Array.from(ids).every((id) => typeof id === 'string' && id.trim()) ||
    new Set(ids).size !== ids.length
  )
    return 'Invalid tactical annex ruins';
  if (!state.infrastructure)
    return ids.length ? 'Tactical annex ruins require infrastructure' : null;
  try {
    for (const id of ids) {
      const node = state.infrastructure.capture.nodes.find((node) =>
        node.buildings.some((building) => building.id === id),
      );
      const building = node?.buildings.find((building) => building.id === id);
      if (!node || !building || !state.battle!.mains.includes(node.mainHex))
        return 'Tactical annex ruin references an unknown battle building';
      const data = campaignBuildingData(building);
      const site = state.infrastructure.sites.find((site) => site.nodeId === node.id);
      if (data.placement !== 'annex' || !site?.annexSubHexes.includes(data.subHex))
        return 'Tactical Raze Tile cannot damage a center';
    }
    return null;
  } catch {
    return 'Invalid tactical annex ruin building';
  }
}

/** Raze one enemy annex under the acting troop, using its existing normal ACT. */
export function applyCampaignRazeTile(
  state: GameState,
  unitId: string,
  buildingId: string,
): CampaignRazeTileResult {
  const battle = state.battle;
  const foundation = state.infrastructure;
  if (state.phase !== 'battle' || !battle || battle.phase !== 'combat')
    return failure('Raze Tile requires active tactical combat');
  if (!foundation) return failure('Campaign infrastructure is not enabled');
  if (foundationHasPending(state)) return failure('Resolve the pending campaign choices first');
  const invalid = validateCampaignRazeTileState(state);
  if (invalid) return failure(invalid);
  const unit = battle.units.find((unit) => unit.id === unitId);
  if (!unit || unit.hp <= 0 || !unit.pos)
    return failure('A living military unit must be on the field');
  if (unit.team !== battle.active) return failure('Not your unit');
  if (unit.acted) return failure('Unit already acted');
  try {
    unitType(unit.typeId);
  } catch {
    return failure('Unknown military unit');
  }
  const node = foundation.capture.nodes.find((node) =>
    node.buildings.some((building) => building.id === buildingId),
  );
  const building = node?.buildings.find((building) => building.id === buildingId);
  if (!node || !building) return failure('Unknown annex building');
  const data = campaignBuildingData(building);
  const site = foundation.sites.find((site) => site.nodeId === node.id);
  if (data.placement !== 'annex' || !site?.annexSubHexes.includes(data.subHex))
    return failure('Only an annex tile can be razed with this action');
  if (!battle.mains.includes(node.mainHex)) return failure('Annex is outside this battle');
  if (node.owner === null || node.owner === unit.team)
    return failure('Raze Tile requires an enemy annex');
  if (unit.pos !== data.subHex) return failure('Stand on the annex tile to raze it');
  if (building.ruined || battle.ruinedInfrastructureBuildingIds?.includes(buildingId))
    return failure('Annex is already ruined');
  // Stationed units have this explicit in-place exception; no movement is granted.
  unit.acted = true;
  unit.mp = 0;
  battle.ruinedInfrastructureBuildingIds = [
    ...(battle.ruinedInfrastructureBuildingIds ?? []),
    buildingId,
  ].sort();
  battle.log.push({
    round: battle.round,
    team: unit.team,
    kind: 'info',
    text: `${unit.label} razes annex ${buildingId}`,
  });
  return { ok: true };
}

/** Quotes use the exact command path on a disposable state, without spending AP or CP. */
export function quoteCampaignRazeTile(
  state: GameState,
  unitId: string,
  buildingId: string,
): CampaignRazeTileQuote {
  const node = state.infrastructure?.capture.nodes.find((node) =>
    node.buildings.some((building) => building.id === buildingId),
  );
  const building = node?.buildings.find((building) => building.id === buildingId);
  const data = building ? campaignBuildingData(building) : null;
  const result = applyCampaignRazeTile(structuredClone(state), unitId, buildingId);
  return {
    unitId,
    buildingId,
    eligible: result.ok,
    reason: result.ok ? null : result.error,
    actionCost: 1,
    cpCost: 0,
    ...(node && data
      ? {
          nodeId: node.id,
          subHex: data.subHex,
          label:
            state.infrastructure!.profile.definitions.find(
              (definition) => definition.id === data.definitionId,
            )?.name ?? data.role,
        }
      : {}),
  };
}

export function campaignRazeTileOptions(state: GameState, unitId: string): CampaignRazeTileQuote[] {
  return (
    state.infrastructure?.capture.nodes
      .filter((node) => state.battle?.mains.includes(node.mainHex))
      .flatMap((node) =>
        node.buildings
          .filter((building) => campaignBuildingData(building).placement === 'annex')
          .map((building) => quoteCampaignRazeTile(state, unitId, building.id)),
      )
      .sort((a, b) => (a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0)) ??
    []
  );
}

/** Idempotent battle commit: keep all tier, upgrade, slot and equipment data intact. */
export function commitCampaignRazeTiles(state: GameState, battle: Battle): CampaignRazeTileResult {
  if (battle !== state.battle || battle.phase !== 'over')
    return failure('Raze Tile damage commits from the real completed battle');
  const invalid = validateCampaignRazeTileState(state);
  if (invalid) return failure(invalid);
  const ids = new Set(battle.ruinedInfrastructureBuildingIds ?? []);
  if (!ids.size) return { ok: true };
  const foundation = state.infrastructure!;
  state.infrastructure = {
    ...foundation,
    capture: {
      ...foundation.capture,
      nodes: foundation.capture.nodes.map((node) => ({
        ...node,
        buildings: node.buildings.map((building) =>
          ids.has(building.id) ? { ...building, ruined: true } : building,
        ),
      })),
    },
  };
  return { ok: true };
}

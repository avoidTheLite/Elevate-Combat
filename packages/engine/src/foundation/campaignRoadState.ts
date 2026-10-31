import type { GameState } from '../types.ts';
import type { SupplyRoadSection } from './supplyGraph.ts';

/** Tactical repair is working state until battle writeback; its CP/work receipt is already durable. */
export function workingCampaignRoads(state: GameState): readonly SupplyRoadSection[] {
  const roads = state.infrastructure?.supply?.roads ?? [];
  const repaired = new Set(
    state.battle?.repairedInfrastructureRoads?.map((repair) => repair.roadId) ?? [],
  );
  return repaired.size
    ? roads.map((road) => (repaired.has(road.id) ? { ...road, damaged: false } : road))
    : roads;
}

export function validateCampaignRoadRepairState(state: GameState): string | null {
  const repairs = state.battle?.repairedInfrastructureRoads;
  if (repairs === undefined) return null;
  try {
    if (!Array.isArray(repairs) || !state.infrastructure?.supply)
      return 'Tactical road repairs require infrastructure and a valid repair list';
    const roads = new Set<string>();
    const receipts = new Set<string>();
    for (const repair of repairs) {
      if (
        !repair ||
        typeof repair.roadId !== 'string' ||
        !repair.roadId.trim() ||
        typeof repair.requestId !== 'string' ||
        !repair.requestId.trim() ||
        roads.has(repair.roadId) ||
        receipts.has(repair.requestId)
      )
        return 'Invalid or duplicate tactical road repair';
      roads.add(repair.roadId);
      receipts.add(repair.requestId);
      const road = state.infrastructure.supply.roads.find((road) => road.id === repair.roadId);
      const receipt = state.infrastructure.capture.work.receipts.find(
        (receipt) => receipt.request.requestId === repair.requestId,
      );
      if (
        !road ||
        !state.battle!.mains.includes(road.mainHex) ||
        !receipt ||
        receipt.request.kind !== 'repair-road' ||
        receipt.request.targetId !== road.id ||
        receipt.engineerUnitId === null ||
        receipt.nodeOperationsSpent !== 0
      )
        return 'Tactical road repair has lost its battle section or engineering receipt';
    }
    return null;
  } catch {
    return 'Invalid tactical road repair state';
  }
}

import { buildWorld } from '../grid.ts';
import { hexDistance, parseKey } from '../hex.ts';
import { withRules } from '../rules.ts';
import type { GameState } from '../types.ts';
import { unitType } from '../units.ts';
import { foundationHasPending } from './campaign.ts';
import { applyFoundationWork } from './workLedger.ts';
import type { FoundationWorkReceipt, FoundationWorkRequest } from './workLedger.ts';

export interface CampaignRoadRepairRequest {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly ownerTurnId: string;
  readonly roadId: string;
  readonly engineerUnitId: string;
}

export type CampaignRoadRepairResult =
  | { readonly ok: true; readonly replayed: boolean; readonly receipt: FoundationWorkReceipt }
  | { readonly ok: false; readonly error: string };

const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const whole = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * GAMES-ELEVATE-CAMPAIGN-UC-001: repair an explicit map road using one persistent engineer action.
 * No ownership condition or node operation is added. Geometry/effects change without a turn,
 * reward replay, newly generated road or tactical-damage rule. Outer apply owns its state clone.
 */
export function applyCampaignRoadRepair(
  state: GameState,
  request: CampaignRoadRepairRequest,
): CampaignRoadRepairResult {
  return withRules(state.settings.rules, () => {
    try {
      const f = state.infrastructure;
      if (!f?.supply || !f.configuration || !f.clock)
        return { ok: false, error: 'Road infrastructure is not initialized' };
      if (
        !request ||
        !validId(request.requestId) ||
        !whole(request.expectedVersion) ||
        !validId(request.ownerTurnId) ||
        !validId(request.roadId) ||
        !validId(request.engineerUnitId)
      )
        return { ok: false, error: 'Invalid road repair request' };
      const previous = f.capture.work.receipts.find(
        (receipt) => receipt.request.requestId === request.requestId,
      );
      if (previous) {
        const prior = previous.request;
        if (
          prior.kind !== 'repair-road' ||
          prior.expectedVersion !== request.expectedVersion ||
          prior.ownerTurnId !== request.ownerTurnId ||
          prior.targetId !== request.roadId ||
          prior.engineerUnitId !== request.engineerUnitId
        )
          return { ok: false, error: 'Request ID belongs to different work' };
        return { ok: true, replayed: true, receipt: previous };
      }
      if (state.phase !== 'strategic')
        return { ok: false, error: 'Road repair requires the strategic phase' };
      if (foundationHasPending(state) || f.clock.pendingTurnStart !== null)
        return {
          ok: false,
          error: 'Resolve pending turn, capture, stationing or free shots first',
        };
      const team = state.active;
      if (
        request.ownerTurnId !== f.ownerTurns[team] ||
        f.clock.ownerCycle[team] !== request.ownerTurnId ||
        !f.clock.startedCycles.includes(request.ownerTurnId)
      )
        return { ok: false, error: 'Road repair must use the current owner turn' };
      if (!whole(f.configuration.roadRepairCp))
        return { ok: false, error: 'An explicit whole road repair CP cost is required' };
      if (
        request.expectedVersion !== f.capture.version ||
        f.capture.work.version !== f.capture.version
      )
        return { ok: false, error: 'Road repair snapshot is stale' };
      if (
        f.capture.work.commandPoints.A !== state.cp.A ||
        f.capture.work.commandPoints.B !== state.cp.B
      )
        return { ok: false, error: 'CP snapshot changed; refresh infrastructure first' };
      const roads = f.supply.roads.filter((road) => road.id === request.roadId);
      if (roads.length !== 1) return { ok: false, error: 'Unknown or ambiguous road section' };
      const road = roads[0];
      if (road.damaged !== true) return { ok: false, error: 'Road section is not damaged' };
      const world = buildWorld(state.settings.grid);
      if (
        !world.mainByKey.has(road.mainHex) ||
        !road.path.length ||
        new Set(road.path).size !== road.path.length ||
        road.path.some(
          (key, index) =>
            world.subByKey.get(key)?.main !== road.mainHex ||
            (index > 0 && hexDistance(parseKey(road.path[index - 1]), parseKey(key)) !== 1),
        )
      )
        return { ok: false, error: 'Road section has invalid MainHex-local geometry' };
      const engineerHolder = state.armies.find((holder) =>
        holder.units.some((unit) => unit.id === request.engineerUnitId),
      );
      if (engineerHolder && world.subByKey.get(engineerHolder.pos)?.main !== engineerHolder.at)
        return { ok: false, error: 'Engineer holder position/MainHex mismatch' };
      const workRequest: FoundationWorkRequest = {
        requestId: request.requestId,
        expectedVersion: request.expectedVersion,
        ownerTurnId: request.ownerTurnId,
        team,
        kind: 'repair-road',
        targetId: road.id,
        engineerUnitId: request.engineerUnitId,
      };
      const repaired = applyFoundationWork(f.capture.work, workRequest, {
        ownerTurn: { team, id: request.ownerTurnId },
        nodes: f.capture.nodes.map((node) => ({
          id: node.id,
          mainHex: node.mainHex,
          owner: node.owner,
        })),
        targets: [
          {
            id: road.id,
            kind: 'repair-road',
            mainHex: road.mainHex,
            cpCost: f.configuration.roadRepairCp,
          },
        ],
        holders: state.armies,
      });
      if (!repaired.ok) return { ok: false, error: repaired.reason };
      if (repaired.replayed) return { ok: true, replayed: true, receipt: repaired.receipt };
      state.cp = { ...repaired.state.commandPoints };
      state.infrastructure = {
        ...f,
        capture: { ...f.capture, version: repaired.state.version, work: repaired.state },
        supply: {
          ...f.supply,
          roads: f.supply.roads.map((section) =>
            section.id === road.id ? { ...section, damaged: false } : section,
          ),
        },
      };
      return { ok: true, replayed: false, receipt: repaired.receipt };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Invalid road repair state',
      };
    }
  });
}

export function constructCampaignRoadRepairRequest(
  state: GameState,
  roadId: string,
  engineerUnitId: string,
): CampaignRoadRepairRequest {
  const f = state.infrastructure;
  if (!f) throw new Error('Road infrastructure is not initialized');
  return {
    requestId: `road-repair:${JSON.stringify([state.nextId, f.capture.version, f.ownerTurns[state.active], roadId, engineerUnitId])}`,
    expectedVersion: f.capture.version,
    ownerTurnId: f.ownerTurns[state.active],
    roadId,
    engineerUnitId,
  };
}

export interface CampaignRoadRepairQuote {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly roadId: string;
  readonly mainHex: string | null;
  readonly cpCost: number | null;
  readonly engineerUnitId: string | null;
  readonly engineerLabel: string | null;
  readonly request: CampaignRoadRepairRequest | null;
}

/** Authoritative dry run, without spending CP/actions or incrementing IDs/versions. */
export function quoteCampaignRoadRepair(
  state: GameState,
  roadId: string,
  engineerUnitId: string,
): CampaignRoadRepairQuote {
  const road = state.infrastructure?.supply?.roads.find((section) => section.id === roadId);
  const cost = state.infrastructure?.configuration?.roadRepairCp;
  const unit = state.armies
    .flatMap((holder) => holder.units)
    .find((candidate) => candidate.id === engineerUnitId);
  let request: CampaignRoadRepairRequest | null = null;
  try {
    request = constructCampaignRoadRepairRequest(state, roadId, engineerUnitId);
    const result = applyCampaignRoadRepair(structuredClone(state), request);
    return {
      allowed: result.ok,
      reason: result.ok ? null : result.error,
      roadId,
      mainHex: road?.mainHex ?? null,
      cpCost: whole(cost) ? cost : null,
      engineerUnitId,
      engineerLabel: unit?.label ?? null,
      request,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : 'Invalid road repair state',
      roadId,
      mainHex: road?.mainHex ?? null,
      cpCost: whole(cost) ? cost : null,
      engineerUnitId,
      engineerLabel: unit?.label ?? null,
      request,
    };
  }
}

/** Disabled missing/spent-engineer reasons remain visible; map assets are never invented. */
export function campaignRoadRepairOptions(state: GameState): CampaignRoadRepairQuote[] {
  return withRules(state.settings.rules, () =>
    (state.infrastructure?.supply?.roads ?? [])
      .filter((road) => road.damaged)
      .flatMap((road) => {
        const engineers = state.armies
          .filter((holder) => holder.team === state.active && holder.at === road.mainHex)
          .flatMap((holder) =>
            holder.units.filter((unit) => {
              try {
                return unit.hp > 0 && unitType(unit.typeId).engineer === true;
              } catch {
                return false;
              }
            }),
          );
        if (engineers.length)
          return engineers.map((unit) => quoteCampaignRoadRepair(state, road.id, unit.id));
        const cost = state.infrastructure?.configuration?.roadRepairCp;
        return [
          {
            allowed: false,
            reason: 'Road repair needs a living friendly engineer in this MainHex',
            roadId: road.id,
            mainHex: road.mainHex,
            cpCost: whole(cost) ? cost : null,
            engineerUnitId: null,
            engineerLabel: null,
            request: null,
          },
        ];
      }),
  );
}

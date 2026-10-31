import type { Army, GameState } from '../types.ts';
import { withRules } from '../rules.ts';
import { unitType } from '../units.ts';
import { logStrategic, makeUnit, newId } from '../strategic.ts';
import { campaignBuildingData } from './campaignNodes.ts';
import {
  campaignNodeCapacity,
  campaignNodeEffects,
  campaignSupplyView,
  foundationHasPending,
} from './campaign.ts';
import {
  campaignSupplyReinforcementAllowance,
  campaignSupplyReinforcementContext,
  recordCampaignSupplyDeployment,
  refreshCampaignSupplyOrigins,
} from './campaignSupply.ts';
import { applyReinforcementSpend } from './reinforcement.ts';

export type CampaignRecruitmentResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

function housingMetrics(
  state: GameState,
  nodeId: string,
  garrison: Army | undefined,
): { housing: number; occupied: number } {
  return {
    housing: campaignNodeCapacity(state, nodeId, 'housing'),
    occupied: garrison?.units.filter((unit) => unit.hp > 0).length ?? 0,
  };
}

function throughputMetrics(
  state: GameState,
  nodeId: string,
  homeConnected: boolean,
): { throughput: number; used: number } {
  const f = state.infrastructure!;
  const attributed = new Map(
    f.supply!.deployments.map((deployment) => [deployment.requestId, deployment.nodeId]),
  );
  return {
    throughput: campaignNodeCapacity(
      state,
      nodeId,
      'throughput',
      homeConnected
        ? f.configuration!.throughputHomeMultiplier
        : f.configuration!.throughputRegionalMultiplier,
    ),
    used: f
      .supply!.reinforcement.receipts.filter(
        (receipt) =>
          receipt.request.team === state.active &&
          receipt.request.ownerTurnId === f.ownerTurns[state.active] &&
          attributed.get(receipt.request.requestId) === nodeId,
      )
      .reduce((sum, receipt) => sum + receipt.request.units, 0),
  };
}

/**
 * GAMES-ELEVATE-CAMPAIGN-UC-001/002: recruit one real unit using the current node and C1 budgets.
 * All validation/debit preparation precedes campaign mutation. Outer apply owns its clone,
 * CP snapshot/claim refresh and event scheduling; this boundary never opens or tops up a cycle.
 */
export function recruitCampaignUnit(
  state: GameState,
  typeId: string,
  requestedNodeId?: string,
): CampaignRecruitmentResult {
  return withRules(state.settings.rules, () => {
    try {
      const f = state.infrastructure;
      if (!f?.supply || !f.configuration || !f.clock)
        return { ok: false, error: 'Strategic infrastructure is not initialized' };
      if (state.phase !== 'strategic') return { ok: false, error: 'Not in strategic phase' };
      if (foundationHasPending(state))
        return { ok: false, error: 'Resolve pending capture, stationing or free shots first' };
      if (f.clock.pendingTurnStart !== null)
        return { ok: false, error: 'Turn-start resolution is still pending' };
      const team = state.active;
      const cycle = f.ownerTurns[team];
      if (!cycle || f.clock.ownerCycle[team] !== cycle || !f.clock.startedCycles.includes(cycle))
        return { ok: false, error: 'Owner-turn recruitment budget is not open' };
      const site =
        requestedNodeId === undefined
          ? f.sites.find((candidate) => candidate.homeTeam === team)
          : f.sites.find((candidate) => candidate.nodeId === requestedNodeId);
      if (!site) return { ok: false, error: 'Unknown recruitment node' };
      const node = f.capture.nodes.find((candidate) => candidate.id === site.nodeId);
      if (!node || node.owner !== team)
        return { ok: false, error: 'You do not control this recruitment node' };
      const center = node.buildings.find(
        (building) => campaignBuildingData(building).placement === 'center',
      );
      if (!center || center.ruined || !campaignBuildingData(center).active)
        return { ok: false, error: 'Recruitment requires an active node center' };
      const effects = campaignNodeEffects(state, node.id);
      const home = site.homeTeam === team;
      if (!home && !effects.some((building) => building.effects.recruitment))
        return { ok: false, error: 'This node has no active recruitment building' };
      if (
        f.capture.receipts.some(
          (receipt) =>
            receipt.batch.team === team &&
            receipt.batch.ownerTurnId === cycle &&
            receipt.changes.some(
              (change) => change.nodeId === node.id && change.outcome === 'capture',
            ),
        )
      )
        return {
          ok: false,
          error: 'A captured node cannot deploy troops until its next owner turn',
        };
      const type = unitType(typeId);
      if (type.era !== state.settings.era) return { ok: false, error: 'Wrong era' };
      if (
        !Number.isSafeInteger(type.cost) ||
        type.cost < 0 ||
        !Number.isSafeInteger(state.cp[team]) ||
        state.cp[team] < 0
      )
        return { ok: false, error: 'Invalid recruitment CP state' };
      if (state.cp[team] < type.cost) return { ok: false, error: `Need ${type.cost} CP` };
      const garrisons = state.armies.filter(
        (army) =>
          army.kind === 'garrison' &&
          army.team === team &&
          (home
            ? army.building === 'hq' && army.at === node.mainHex
            : army.building === 'node' && army.nodeId === node.id),
      );
      if (garrisons.length > 1)
        return { ok: false, error: 'Recruitment node has ambiguous garrisons' };
      const garrison = garrisons[0];
      if (home && !garrison) return { ok: false, error: 'No HQ garrison' };
      if (garrison && (garrison.at !== node.mainHex || garrison.pos !== node.centerSubHex))
        return { ok: false, error: 'Recruitment garrison does not occupy its node center' };
      if (
        state.armies.some(
          (army) =>
            army.id !== garrison?.id &&
            army.pos === node.centerSubHex &&
            army.units.some((unit) => unit.hp > 0),
        )
      )
        return { ok: false, error: 'Node center is occupied by another force' };
      const { housing, occupied } = housingMetrics(state, node.id, garrison);
      if (!Number.isFinite(housing) || housing < 0 || occupied + 1 > housing)
        return { ok: false, error: `Node housing is full (${occupied}/${housing})` };
      const supply = campaignSupplyView(state, team);
      const suppliedNode = supply?.nodes[node.id];
      if (!supply || !suppliedNode || suppliedNode.connection === 'none')
        return { ok: false, error: 'Recruitment node has no eligible supply authority' };
      const { throughput, used } = throughputMetrics(state, node.id, suppliedNode.homeConnected);
      if (
        !Number.isFinite(throughput) ||
        throughput < 0 ||
        !Number.isSafeInteger(used) ||
        used + 1 > throughput
      )
        return {
          ok: false,
          error: `Node recruitment throughput is exhausted (${used}/${throughput})`,
        };
      const runtime = refreshCampaignSupplyOrigins(f.supply, supply, cycle);
      const available = campaignSupplyReinforcementAllowance(
        runtime,
        supply,
        cycle,
        'reinforcement',
        node.id,
      );
      const lane = available.lanes.find((candidate) => candidate.available >= 1);
      if (!lane || available.available < 1)
        return { ok: false, error: 'Network reinforcement allowance is exhausted' };
      if (
        !Number.isSafeInteger(state.nextId) ||
        state.nextId < 1 ||
        state.nextId > Number.MAX_SAFE_INTEGER - 2
      )
        return { ok: false, error: 'Unit identity range is exhausted' };
      const unitId = `${team}u${state.nextId}`;
      const garrisonId = `${team}nodeGarrison${state.nextId + 1}`;
      if (
        state.armies.some(
          (army) => army.id === unitId || army.units.some((unit) => unit.id === unitId),
        ) ||
        (!garrison &&
          state.armies.some(
            (army) => army.id === garrisonId || army.units.some((unit) => unit.id === garrisonId),
          ))
      )
        return { ok: false, error: 'Recruitment would duplicate an existing identity' };
      const requestId = JSON.stringify(['recruit', team, cycle, node.id, state.nextId]);
      if (runtime.reinforcement.receipts.some((receipt) => receipt.request.requestId === requestId))
        return { ok: false, error: 'Recruitment request identity has already been spent' };
      const context = campaignSupplyReinforcementContext(
        runtime,
        supply,
        cycle,
        'reinforcement',
        node.id,
      );
      const debit = applyReinforcementSpend(
        runtime.reinforcement,
        {
          requestId,
          expectedVersion: runtime.reinforcement.version,
          team,
          ownerTurnId: cycle,
          networkId: lane.networkId,
          units: 1,
        },
        context,
      );
      if (!debit.ok) return { ok: false, error: debit.reason };
      if (debit.replayed)
        return { ok: false, error: 'Recruitment request identity has already been spent' };
      const spent = recordCampaignSupplyDeployment(
        { ...runtime, reinforcement: debit.state },
        requestId,
        node.id,
      );

      // No remaining fallible validation: commit the prepared debit, real unit and CP together.
      const unit = makeUnit(state, team, typeId);
      const target: Army = garrison ?? {
        id: newId(state, `${team}nodeGarrison`),
        team,
        kind: 'garrison',
        building: 'node',
        nodeId: node.id,
        at: node.mainHex,
        pos: node.centerSubHex,
        units: [],
        movesLeft: 0,
      };
      target.units.push(unit);
      if (!garrison) state.armies.push(target);
      state.cp[team] -= type.cost;
      state.infrastructure = { ...f, supply: spent };
      logStrategic(state, `Recruited ${type.name} at ${node.id} (−${type.cost} CP)`, team);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Invalid recruitment state',
      };
    }
  });
}

export interface CampaignRecruitmentQuote {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly nodeId: string | null;
  readonly targetHolderId: string | null;
  readonly cost: number | null;
  readonly housing: number | null;
  readonly occupied: number | null;
  readonly throughput: number | null;
  readonly throughputUsed: number | null;
  readonly localRemaining: number | null;
  readonly sharedRemaining: number | null;
}

/** Authoritative UI/AI preview: actual command on an isolated clone; no receipt or cycle is issued. */
export function quoteCampaignRecruitment(
  state: GameState,
  typeId: string,
  requestedNodeId?: string,
): CampaignRecruitmentQuote {
  const result = recruitCampaignUnit(structuredClone(state), typeId, requestedNodeId);
  const quote: CampaignRecruitmentQuote = {
    allowed: result.ok,
    reason: result.ok ? null : result.error,
    nodeId: null,
    targetHolderId: null,
    cost: null,
    housing: null,
    occupied: null,
    throughput: null,
    throughputUsed: null,
    localRemaining: null,
    sharedRemaining: null,
  };
  let cost: number | null = null;
  try {
    cost = withRules(state.settings.rules, () => unitType(typeId).cost);
  } catch {
    /* Unknown unit retains the real command reason. */
  }
  const f = state.infrastructure;
  const site =
    requestedNodeId === undefined
      ? f?.sites.find((candidate) => candidate.homeTeam === state.active)
      : f?.sites.find((candidate) => candidate.nodeId === requestedNodeId);
  if (!f || !site) return { ...quote, cost };
  const node = f.capture.nodes.find((candidate) => candidate.id === site.nodeId);
  if (!node || node.owner !== state.active) return { ...quote, cost, nodeId: site.nodeId };
  try {
    const home = site.homeTeam === state.active;
    const garrison = state.armies.find(
      (army) =>
        army.team === state.active &&
        army.kind === 'garrison' &&
        (home
          ? army.building === 'hq' && army.at === node.mainHex
          : army.building === 'node' && army.nodeId === node.id),
    );
    const housing = housingMetrics(state, node.id, garrison);
    const supply = campaignSupplyView(state, state.active);
    if (!supply || !f.supply)
      return { ...quote, cost, nodeId: node.id, targetHolderId: garrison?.id ?? null, ...housing };
    const metrics = throughputMetrics(state, node.id, supply.nodes[node.id].homeConnected);
    const runtime = refreshCampaignSupplyOrigins(f.supply, supply, f.ownerTurns[state.active]);
    const shared = campaignSupplyReinforcementAllowance(
      runtime,
      supply,
      f.ownerTurns[state.active],
      'reinforcement',
      node.id,
    );
    return {
      ...quote,
      cost,
      nodeId: node.id,
      targetHolderId: garrison?.id ?? null,
      ...housing,
      throughput: metrics.throughput,
      throughputUsed: metrics.used,
      localRemaining: Math.max(0, metrics.throughput - metrics.used),
      sharedRemaining: shared.available,
    };
  } catch {
    return { ...quote, cost, nodeId: node.id };
  }
}

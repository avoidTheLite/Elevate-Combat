import type { World } from '../grid.ts';
import type { Terrain } from '../terrain.ts';
import type { Team } from '../types.ts';
import { heightAt } from '../terrain.ts';
import { hexDistance, hexKey, parseKey } from '../hex.ts';
import {
  compareFoundationAmounts,
  evaluateFoundationAttribute,
  multiplyFoundationAmounts,
} from './attributes.ts';
import type {
  FoundationAmount,
  FoundationExactAmount,
  FoundationIncomeContribution,
  HomeConnectedBoost,
} from './attributes.ts';
import { territorialClaimCounts } from './control.ts';
import type { TerritorialControl } from './control.ts';
import { campaignBuildingData } from './campaignNodes.ts';
import type { CampaignInfrastructure } from './campaignNodes.ts';
import {
  createReinforcementState,
  openReinforcementCycle,
  reinforcementAllowance,
  validateReinforcementState,
} from './reinforcement.ts';
import type { ReinforcementContext, ReinforcementState } from './reinforcement.ts';
import { evaluateSupplyGraph, validateSupplyProfile } from './supplyGraph.ts';
import type {
  SupplyConnector,
  SupplyGraphEvaluation,
  SupplyProfile,
  SupplyRoadSection,
  SupplyRoute,
} from './supplyGraph.ts';

export interface CampaignSupplyBenefit {
  readonly id: string;
  readonly units: string;
  readonly homeConnectedBoost: HomeConnectedBoost;
  readonly maximum: number | null;
  readonly applyRouteEfficiency: boolean;
  readonly isolatedRegionalFactor: number;
  readonly rounding: 'none' | 'floor' | 'ceil' | 'nearest';
}

export interface CampaignSupplyHqBenefits {
  readonly authorityId: string;
  readonly contributions: readonly {
    readonly benefitId: string;
    readonly value: FoundationAmount;
  }[];
}

export interface CampaignSupplyInput {
  readonly world: World;
  readonly terrain: Terrain;
  readonly team: Team;
  readonly nodes: readonly SupplyConnector[];
  readonly roads: readonly SupplyRoadSection[];
  readonly stationedUnits: readonly {
    readonly unitId: string;
    readonly team: Team;
    readonly subHex: string;
    readonly hp: number;
  }[];
  readonly control: TerritorialControl;
  readonly profile: SupplyProfile;
  readonly benefits: readonly CampaignSupplyBenefit[];
  readonly hqBenefits: readonly CampaignSupplyHqBenefits[];
}

export interface CampaignSupplyBenefitSelection {
  readonly benefitId: string;
  readonly providerId: string | null;
  readonly value: number;
  readonly exactValue: FoundationExactAmount;
  readonly route: SupplyRoute | null;
  readonly homeConnected: boolean;
}

export interface CampaignSupplyEvaluation extends SupplyGraphEvaluation {
  readonly benefitSelections: Readonly<
    Record<string, Readonly<Record<string, CampaignSupplyBenefitSelection>>>
  >;
}

/** Persist inputs and budget provenance, never a cached route graph. */
export interface CampaignSupplyRuntime {
  readonly formatVersion: 1;
  readonly profile: SupplyProfile;
  readonly roads: readonly SupplyRoadSection[];
  readonly benefits: readonly CampaignSupplyBenefit[];
  readonly hqBenefits: readonly CampaignSupplyHqBenefits[];
  readonly reinforcement: ReinforcementState;
  readonly originBindings: readonly {
    readonly team: Team;
    readonly ownerTurnId: string;
    readonly nodeId: string;
    readonly lineageIds: readonly string[];
  }[];
  readonly deployments: readonly {
    readonly requestId: string;
    readonly nodeId: string;
  }[];
}

/** A caller must deliberately supply every rule profile, including empty road/benefit lists. */
export function createCampaignSupplyRuntime(
  input: Pick<CampaignSupplyRuntime, 'profile' | 'roads' | 'benefits' | 'hqBenefits'>,
): CampaignSupplyRuntime {
  validateSupplyProfile(input.profile);
  if (
    !Array.isArray(input.roads) ||
    !Array.isArray(input.benefits) ||
    !Array.isArray(input.hqBenefits)
  )
    throw new Error('Explicit supply configuration lists are required');
  const runtime: CampaignSupplyRuntime = {
    formatVersion: 1,
    ...structuredClone(input),
    reinforcement: createReinforcementState(),
    originBindings: [],
    deployments: [],
  };
  const invalid = validateCampaignSupplyRuntime(runtime);
  if (invalid) throw new Error(invalid);
  return runtime;
}

/** Reads real seven-cell node centers; callers resolve typed relay effects explicitly per node. */
export function campaignSupplyConnectors(
  infrastructure: Pick<CampaignInfrastructure, 'sites' | 'capture'>,
  relayRangeBonuses: Readonly<Record<string, FoundationAmount>>,
): SupplyConnector[] {
  return infrastructure.capture.nodes.map((node) => {
    const site = infrastructure.sites.find((candidate) => candidate.nodeId === node.id);
    if (!site) throw new Error('Supply node has no map site');
    const centers = node.buildings.filter(
      (building) => campaignBuildingData(building).placement === 'center',
    );
    if (centers.length !== 1) throw new Error('Supply node must contain one center');
    const center = centers[0];
    const data = campaignBuildingData(center);
    if (!Object.hasOwn(relayRangeBonuses, node.id))
      throw new Error('Explicit node relay range is required');
    const relayRangeBonus = relayRangeBonuses[node.id];
    if (compareFoundationAmounts(relayRangeBonus, 0) < 0)
      throw new Error('Relay range bonus must be nonnegative');
    const operational = !center.ruined && data.active;
    return {
      id: node.id,
      subHex: node.centerSubHex,
      owner: node.owner,
      operational,
      relayRangeBonus,
      authority:
        !operational || node.owner === null
          ? null
          : site.homeTeam === node.owner
            ? 'home'
            : data.tier >= 2
              ? 'regional'
              : null,
    };
  });
}

const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function requireId(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a supply benefit ID');
}
function nonnegative(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid supply benefit value');
}

/**
 * GAMES-ELEVATE-CAMPAIGN-UC-001/002: actual lattice/elevation/control inputs, shared HQ evaluator.
 * Terrain classification mirrors movement.ts: height zero is marsh, other heights land.
 * All costs, climb/drop restrictions, range and benefit tuning are explicit required inputs.
 */
export function evaluateCampaignSupply(input: CampaignSupplyInput): CampaignSupplyEvaluation {
  territorialClaimCounts(input.control);
  if (input.terrain.heights.length !== input.world.subs.length)
    throw new Error('Supply terrain/world mismatch');
  for (const main of input.world.mains) {
    if (!Object.hasOwn(input.control, main.key)) throw new Error('Supply control omits a MainHex');
  }
  const unitIds = new Set<string>();
  for (const unit of input.stationedUnits) {
    requireId(unit.unitId);
    if (unitIds.has(unit.unitId)) throw new Error('Duplicate stationed supply unit');
    unitIds.add(unit.unitId);
    nonnegative(unit.hp);
    if (!['A', 'B'].includes(unit.team) || !input.world.subByKey.has(unit.subHex))
      throw new Error('Invalid stationed supply unit');
  }
  const graph = evaluateSupplyGraph({
    cells: input.world.subs.map((cell) => {
      const height = heightAt(input.world, input.terrain, cell.key);
      return {
        key: cell.key,
        mainHex: cell.main,
        height,
        terrain: height === 0 ? 'marsh' : 'land',
      };
    }),
    connectors: input.nodes,
    roads: input.roads,
    blockers: input.stationedUnits.filter((unit) => unit.hp > 0),
    claims: Object.fromEntries(
      Object.values(input.control).map((cell) => [cell.mainHexId, cell.claim]),
    ),
    profile: input.profile,
    team: input.team,
  });
  const definitions = new Map<string, CampaignSupplyBenefit>();
  for (const benefit of input.benefits) {
    requireId(benefit.id);
    requireId(benefit.units);
    if (definitions.has(benefit.id)) throw new Error('Duplicate supply benefit definition');
    nonnegative(benefit.isolatedRegionalFactor);
    if (benefit.isolatedRegionalFactor > 1 || typeof benefit.applyRouteEfficiency !== 'boolean')
      throw new Error('Invalid regional benefit modifier');
    if (benefit.maximum !== null) nonnegative(benefit.maximum);
    definitions.set(benefit.id, benefit);
  }
  const providers = new Map<string, Map<string, FoundationAmount>>();
  for (const provider of input.hqBenefits) {
    if (providers.has(provider.authorityId)) throw new Error('Duplicate supply HQ provider');
    const node = input.nodes.find((candidate) => candidate.id === provider.authorityId);
    if (!node || node.authority === null) throw new Error('Unknown supply HQ provider');
    const values = new Map<string, FoundationAmount>();
    for (const contribution of provider.contributions) {
      if (!definitions.has(contribution.benefitId) || values.has(contribution.benefitId))
        throw new Error('Unknown or duplicate HQ benefit');
      if (compareFoundationAmounts(contribution.value, 0) < 0)
        throw new Error('Invalid supply benefit value');
      values.set(contribution.benefitId, contribution.value);
    }
    providers.set(provider.authorityId, values);
  }
  const benefitSelections = Object.fromEntries(
    Object.values(graph.nodes).map((destination) => {
      const selections = Object.fromEntries(
        [...definitions.values()]
          .sort((a, b) => lexical(a.id, b.id))
          .map((benefit) => {
            const candidates = destination.routes.flatMap((route) => {
              const raw = providers.get(route.authorityId)?.get(benefit.id);
              if (raw === undefined) return [];
              const authority = input.nodes.find((node) => node.id === route.authorityId)!;
              const homeConnected = graph.nodes[authority.id].homeConnected;
              const regionalFactor =
                authority.authority === 'regional' && !homeConnected
                  ? benefit.isolatedRegionalFactor
                  : 1;
              return [
                {
                  sourceId: JSON.stringify([authority.id, benefit.id]),
                  attributeId: benefit.id,
                  targetId: destination.nodeId,
                  units: benefit.units,
                  active: true,
                  eligible: true,
                  value: multiplyFoundationAmounts(
                    multiplyFoundationAmounts(raw, regionalFactor),
                    benefit.applyRouteEfficiency ? route.exactEffectiveEfficiency : 1,
                  ),
                  hqId: authority.id,
                  kind: authority.authority as 'home' | 'regional',
                  homeConnected,
                  boost: benefit.homeConnectedBoost,
                },
              ];
            });
            const evaluated = evaluateFoundationAttribute({
              definition: {
                id: benefit.id,
                units: benefit.units,
                groups: [{ id: 'hq', phase: 'flat', combine: 'highest-only' }],
                hqGroupId: 'hq',
                minimum: 0,
                maximum: benefit.maximum,
                rounding: benefit.rounding,
              },
              targetId: destination.nodeId,
              baseValue: 0,
              contributions: [],
              hqContributions: candidates,
            });
            const providerId = evaluated.selectedHq?.hqId ?? null;
            return [
              benefit.id,
              {
                benefitId: benefit.id,
                providerId,
                value: evaluated.value as number,
                exactValue: evaluated.exactValue,
                route: destination.routes.find((route) => route.authorityId === providerId) ?? null,
                homeConnected: providerId === null ? false : graph.nodes[providerId].homeConnected,
              } satisfies CampaignSupplyBenefitSelection,
            ];
          }),
      );
      return [destination.nodeId, selections];
    }),
  );
  return { ...graph, benefitSelections };
}

export interface SupplyBuildingIncomeSource {
  readonly sourceId: string;
  readonly nodeId: string;
  readonly value: FoundationAmount;
  readonly active: boolean;
  readonly eligible: boolean;
  readonly reach: 'base' | 'network' | 'home';
  /** Null explicitly applies the selected route efficiency; otherwise use the selected HQ factor. */
  readonly benefitId: string | null;
}

/** Qualifies building income only; raw territorial income is deliberately absent from this API. */
export function projectSupplyBuildingIncome(
  supply: CampaignSupplyEvaluation,
  sources: readonly SupplyBuildingIncomeSource[],
): FoundationIncomeContribution[] {
  const seen = new Set<string>();
  return sources.map((source) => {
    requireId(source.sourceId);
    if (seen.has(source.sourceId)) throw new Error('Duplicate building income source');
    seen.add(source.sourceId);
    if (compareFoundationAmounts(source.value, 0) < 0)
      throw new Error('Invalid building income value');
    if (typeof source.active !== 'boolean' || typeof source.eligible !== 'boolean')
      throw new Error('Invalid building income flags');
    if (!['base', 'network', 'home'].includes(source.reach))
      throw new Error('Unknown building income reach');
    const node = supply.nodes[source.nodeId];
    if (!node) throw new Error('Unknown building income node');
    const selection =
      source.benefitId === null
        ? null
        : supply.benefitSelections[source.nodeId]?.[source.benefitId];
    if (source.benefitId !== null && !selection) throw new Error('Unknown building income benefit');
    const factor =
      source.reach === 'base'
        ? 1
        : (selection?.exactValue ?? node.activeRoute?.exactEffectiveEfficiency ?? 0);
    const eligible =
      source.eligible &&
      (source.reach === 'base' ||
        (source.reach === 'home' ? node.homeConnected : node.connection !== 'none'));
    const evaluation = evaluateFoundationAttribute({
      definition: {
        id: 'building-income',
        units: 'CP',
        groups: [{ id: 'supply', phase: 'multiplier', combine: 'multiplicative' }],
        hqGroupId: null,
        minimum: 0,
        maximum: null,
        rounding: 'aggregate-income',
      },
      targetId: source.nodeId,
      baseValue: source.value,
      contributions: [
        {
          sourceId: `${source.sourceId}/supply`,
          attributeId: 'building-income',
          targetId: source.nodeId,
          units: 'factor',
          groupId: 'supply',
          active: true,
          eligible: true,
          value: factor,
        },
      ],
      hqContributions: [],
    });
    return {
      sourceId: source.sourceId,
      kind: 'building',
      value: evaluation.value,
      active: source.active,
      eligible,
    };
  });
}

/**
 * C1 opening/remaining hooks. Caller supplies whole capacity and immutable lineage attribution.
 * Descendants can share an origin; independent origins are never silently unioned here.
 */
export function supplyReinforcementHeadroom(input: {
  supply: CampaignSupplyEvaluation;
  capacityBenefitId: string;
  bindings: readonly {
    readonly nodeId: string;
    readonly lineageId: string;
    readonly spent: number;
  }[];
}): { networkId: string; lineageId: string; currentRemaining: number }[] {
  requireId(input.capacityBenefitId);
  const seenNodes = new Set<string>();
  const networks = new Map<string, { lineageId: string; capacity: number; spent: number }>();
  for (const binding of input.bindings) {
    requireId(binding.lineageId);
    if (seenNodes.has(binding.nodeId)) throw new Error('Duplicate reinforcement node binding');
    seenNodes.add(binding.nodeId);
    if (!Number.isSafeInteger(binding.spent) || binding.spent < 0)
      throw new Error('Invalid network spending');
    const node = input.supply.nodes[binding.nodeId];
    if (!node || node.islandId === null)
      throw new Error('Reinforcement binding has no current network');
    const selection = input.supply.benefitSelections[binding.nodeId]?.[input.capacityBenefitId];
    if (!selection || !Number.isSafeInteger(selection.value))
      throw new Error('Reinforcement capacity must be an explicit whole benefit');
    const prior = networks.get(node.islandId);
    if (prior && prior.lineageId !== binding.lineageId)
      throw new Error('Independent reinforcement origins require an explicit merge contract');
    const capacity = Math.max(prior?.capacity ?? 0, selection.value);
    const spent = (prior?.spent ?? 0) + binding.spent;
    if (!Number.isSafeInteger(spent)) throw new Error('Network spending exceeds safe range');
    networks.set(node.islandId, { lineageId: binding.lineageId, capacity, spent });
  }
  return [...networks.entries()]
    .sort(([a], [b]) => lexical(a, b))
    .map(([networkId, network]) => ({
      networkId,
      lineageId: network.lineageId,
      currentRemaining: Math.max(0, network.capacity - network.spent),
    }));
}

function runtimeValid(runtime: CampaignSupplyRuntime): void {
  if (!runtime || runtime.formatVersion !== 1 || validateReinforcementState(runtime.reinforcement))
    throw new Error('Invalid campaign supply ledger');
  const bindingIds = new Set<string>();
  for (const binding of runtime.originBindings) {
    requireId(binding.ownerTurnId);
    requireId(binding.nodeId);
    if (!['A', 'B'].includes(binding.team) || !Array.isArray(binding.lineageIds))
      throw new Error('Invalid supply origin binding');
    const key = JSON.stringify([binding.team, binding.ownerTurnId, binding.nodeId]);
    if (bindingIds.has(key)) throw new Error('Duplicate supply origin binding');
    bindingIds.add(key);
    const cycle = runtime.reinforcement.cycles.find(
      (candidate) =>
        candidate.team === binding.team && candidate.ownerTurnId === binding.ownerTurnId,
    );
    if (!cycle || new Set(binding.lineageIds).size !== binding.lineageIds.length)
      throw new Error('Supply origin has no unique frozen grant');
    for (const origin of binding.lineageIds) {
      requireId(origin);
      if (!cycle.grants.some((grant) => grant.lineageId === origin))
        throw new Error('Supply origin has no frozen grant');
    }
  }
  const deployments = new Set<string>();
  for (const deployment of runtime.deployments) {
    requireId(deployment.requestId);
    requireId(deployment.nodeId);
    const receipt = runtime.reinforcement.receipts.find(
      (candidate) => candidate.request.requestId === deployment.requestId,
    );
    if (deployments.has(deployment.requestId) || !receipt)
      throw new Error('Invalid deployment attribution');
    const lane = laneMembers(receipt.request.networkId);
    if (
      lane.lineageId !== receipt.lineageId ||
      lane.team !== receipt.request.team ||
      !lane.nodeIds.includes(deployment.nodeId)
    )
      throw new Error('Deployment attribution does not match the debit network');
    deployments.add(deployment.requestId);
  }
}

/** Save validation only: never evaluate topology, open grants or migrate controller state. */
export function validateCampaignSupplyRuntime(runtime: CampaignSupplyRuntime): string | null {
  try {
    runtimeValid(runtime);
    validateSupplyProfile(runtime.profile);
    if (
      !Array.isArray(runtime.roads) ||
      !Array.isArray(runtime.benefits) ||
      !Array.isArray(runtime.hqBenefits)
    )
      throw new Error('Explicit supply configuration lists are required');
    const roadIds = new Set<string>();
    for (const road of runtime.roads) {
      requireId(road.id);
      requireId(road.mainHex);
      if (
        roadIds.has(road.id) ||
        typeof road.damaged !== 'boolean' ||
        !Array.isArray(road.path) ||
        !road.path.length ||
        new Set(road.path).size !== road.path.length
      )
        throw new Error('Invalid persisted road section');
      roadIds.add(road.id);
      road.path.forEach((key: string, index: number) => {
        requireId(key);
        const position = parseKey(key);
        if (
          !Number.isSafeInteger(position.q) ||
          !Number.isSafeInteger(position.r) ||
          hexKey(position) !== key ||
          (index > 0 && hexDistance(parseKey(road.path[index - 1]), position) !== 1)
        )
          throw new Error('Invalid persisted road path');
      });
    }
    const definitions = new Set<string>();
    for (const benefit of runtime.benefits) {
      requireId(benefit.id);
      requireId(benefit.units);
      if (
        definitions.has(benefit.id) ||
        typeof benefit.applyRouteEfficiency !== 'boolean' ||
        !['none', 'floor', 'ceil', 'nearest'].includes(benefit.rounding)
      )
        throw new Error('Invalid persisted benefit definition');
      definitions.add(benefit.id);
      nonnegative(benefit.isolatedRegionalFactor);
      if (benefit.isolatedRegionalFactor > 1) throw new Error('Invalid regional factor');
      if (benefit.maximum !== null) nonnegative(benefit.maximum);
      const boost = benefit.homeConnectedBoost;
      if (!boost || !['add', 'multiply'].includes(boost.operation))
        throw new Error('Invalid Home-connected boost');
      nonnegative(boost.value);
      if (boost.value <= (boost.operation === 'add' ? 0 : 1))
        throw new Error('Home-connected boost must improve positive benefits');
      if (boost.cap !== null) nonnegative(boost.cap);
    }
    const providers = new Set<string>();
    for (const provider of runtime.hqBenefits) {
      requireId(provider.authorityId);
      if (providers.has(provider.authorityId) || !Array.isArray(provider.contributions))
        throw new Error('Invalid persisted HQ provider');
      providers.add(provider.authorityId);
      const values = new Set<string>();
      for (const contribution of provider.contributions) {
        if (!definitions.has(contribution.benefitId) || values.has(contribution.benefitId))
          throw new Error('Unknown or duplicate persisted HQ benefit');
        values.add(contribution.benefitId);
        if (compareFoundationAmounts(contribution.value, 0) < 0)
          throw new Error('Invalid persisted HQ benefit value');
      }
    }
    const deployments = new Set(runtime.deployments.map((deployment) => deployment.requestId));
    if (
      runtime.reinforcement.receipts.some((receipt) => !deployments.has(receipt.request.requestId))
    )
      throw new Error('Every reinforcement receipt requires deployment attribution');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid campaign supply runtime';
  }
}

function capacityOfIsland(
  supply: CampaignSupplyEvaluation,
  nodeIds: readonly string[],
  benefitId: string,
): number {
  let capacity = 0;
  for (const nodeId of nodeIds) {
    const selection = supply.benefitSelections[nodeId]?.[benefitId];
    if (!selection || !Number.isSafeInteger(selection.value) || selection.value < 0)
      throw new Error('Reinforcement capacity requires a nonnegative whole benefit');
    capacity = Math.max(capacity, selection.value);
  }
  return capacity;
}

/** Freeze each initial island once; even zero capacity cannot be replenished by a later HQ. */
export function openCampaignSupplyCycle(
  runtime: CampaignSupplyRuntime,
  supply: CampaignSupplyEvaluation,
  ownerTurnId: string,
  capacityBenefitId: string,
): CampaignSupplyRuntime {
  runtimeValid(runtime);
  requireId(ownerTurnId);
  requireId(capacityBenefitId);
  const grants = supply.islands.map((island) => ({
    lineageId: JSON.stringify([supply.team, ownerTurnId, island.id]),
    capacity: capacityOfIsland(supply, island.nodeIds, capacityBenefitId),
  }));
  const result = openReinforcementCycle(runtime.reinforcement, {
    expectedVersion: runtime.reinforcement.version,
    team: supply.team,
    ownerTurnId,
    grants,
  });
  if (!result.ok) throw new Error(result.reason);
  const originBindings = supply.islands.flatMap((island, index) =>
    island.nodeIds.map((nodeId) => ({
      team: supply.team,
      ownerTurnId,
      nodeId,
      lineageIds: [grants[index].lineageId],
    })),
  );
  return {
    ...runtime,
    reinforcement: result.state,
    originBindings: [...runtime.originBindings, ...originBindings],
  };
}

/**
 * Preserve each original grant across splits. When networks meet, propagate their origin IDs
 * without changing any grant or debit. Persist this result before another topology transition.
 * New isolated nodes have no origin until the next opening; joining nodes inherit current origins.
 */
export function refreshCampaignSupplyOrigins(
  runtime: CampaignSupplyRuntime,
  supply: CampaignSupplyEvaluation,
  ownerTurnId: string,
): CampaignSupplyRuntime {
  runtimeValid(runtime);
  requireId(ownerTurnId);
  const cycle = runtime.reinforcement.cycles.find(
    (candidate) => candidate.team === supply.team && candidate.ownerTurnId === ownerTurnId,
  );
  if (!cycle) throw new Error('Supply owner-turn budget is not open');
  const current = new Map(
    runtime.originBindings
      .filter((binding) => binding.team === supply.team && binding.ownerTurnId === ownerTurnId)
      .map((binding) => [binding.nodeId, binding]),
  );
  for (const island of supply.islands) {
    const lineageIds = [
      ...new Set(island.nodeIds.flatMap((nodeId) => current.get(nodeId)?.lineageIds ?? [])),
    ].sort(lexical);
    for (const nodeId of island.nodeIds)
      current.set(nodeId, { team: supply.team, ownerTurnId, nodeId, lineageIds });
  }
  return {
    ...runtime,
    originBindings: [
      ...runtime.originBindings.filter(
        (binding) => binding.team !== supply.team || binding.ownerTurnId !== ownerTurnId,
      ),
      ...[...current.values()].sort((a, b) => lexical(a.nodeId, b.nodeId)),
    ],
  };
}

/** Virtual lanes preserve separate grants while sharing physical-network headroom. */
export function supplyReinforcementLaneId(islandId: string, lineageId: string): string {
  return JSON.stringify([islandId, lineageId]);
}

function laneMembers(networkId: string): { lineageId: string; team: Team; nodeIds: string[] } {
  try {
    const lane = JSON.parse(networkId);
    if (
      !Array.isArray(lane) ||
      lane.length !== 2 ||
      typeof lane[0] !== 'string' ||
      typeof lane[1] !== 'string'
    )
      throw new Error();
    const island = JSON.parse(lane[0]);
    if (
      !Array.isArray(island) ||
      island.length !== 2 ||
      !['A', 'B'].includes(island[0]) ||
      !Array.isArray(island[1]) ||
      !island[1].length ||
      island[1].some((nodeId: unknown) => typeof nodeId !== 'string' || !nodeId.trim()) ||
      new Set(island[1]).size !== island[1].length
    )
      throw new Error();
    return { lineageId: lane[1], team: island[0], nodeIds: island[1] };
  } catch {
    throw new Error('Deployment uses an invalid physical-network origin lane');
  }
}

export function campaignSupplyReinforcementContext(
  runtime: CampaignSupplyRuntime,
  supply: CampaignSupplyEvaluation,
  ownerTurnId: string,
  capacityBenefitId: string,
  destinationNodeId?: string,
): ReinforcementContext {
  runtimeValid(runtime);
  requireId(ownerTurnId);
  requireId(capacityBenefitId);
  const destination = destinationNodeId === undefined ? null : supply.nodes[destinationNodeId];
  if (destinationNodeId !== undefined && !destination)
    throw new Error('Unknown reinforcement destination');
  const cycle = runtime.reinforcement.cycles.find(
    (candidate) => candidate.team === supply.team && candidate.ownerTurnId === ownerTurnId,
  );
  if (!cycle) throw new Error('Supply owner-turn budget is not open');
  const attribution = new Map(
    runtime.deployments.map((deployment) => [deployment.requestId, deployment.nodeId]),
  );
  const receipts = runtime.reinforcement.receipts.filter(
    (receipt) =>
      receipt.request.team === supply.team && receipt.request.ownerTurnId === ownerTurnId,
  );
  if (receipts.some((receipt) => !attribution.has(receipt.request.requestId)))
    throw new Error('Every reinforcement debit needs durable deployment-node attribution');
  const networks = supply.islands.flatMap((island) => {
    const members = new Set(island.nodeIds);
    const lineageIds = [
      ...new Set(
        runtime.originBindings
          .filter(
            (binding) =>
              binding.team === supply.team &&
              binding.ownerTurnId === ownerTurnId &&
              members.has(binding.nodeId),
          )
          .flatMap((binding) => binding.lineageIds),
      ),
    ].sort(lexical);
    const spent = receipts
      .filter((receipt) => members.has(attribution.get(receipt.request.requestId)!))
      .reduce((total, receipt) => total + receipt.request.units, 0);
    if (!Number.isSafeInteger(spent)) throw new Error('Network spending exceeds safe range');
    const capacity = capacityOfIsland(supply, island.nodeIds, capacityBenefitId);
    const eligibleCapacity =
      destination?.islandId === island.id
        ? Math.min(capacity, capacityOfIsland(supply, [destination.nodeId], capacityBenefitId))
        : capacity;
    const currentRemaining = Math.max(0, eligibleCapacity - spent);
    return lineageIds.map((lineageId) => ({
      networkId: supplyReinforcementLaneId(island.id, lineageId),
      lineageId,
      currentRemaining,
    }));
  });
  return {
    snapshotVersion: runtime.reinforcement.version,
    ownerTurn: { team: supply.team, id: ownerTurnId },
    networks,
  };
}

/** Record atomically alongside the successful kernel debit and actual troop deployment. */
export function recordCampaignSupplyDeployment(
  runtime: CampaignSupplyRuntime,
  requestId: string,
  nodeId: string,
): CampaignSupplyRuntime {
  runtimeValid(runtime);
  requireId(requestId);
  requireId(nodeId);
  const receipt = runtime.reinforcement.receipts.find(
    (candidate) => candidate.request.requestId === requestId,
  );
  if (!receipt) throw new Error('Deployment requires a successful reinforcement receipt');
  const lane = laneMembers(receipt.request.networkId);
  if (
    lane.lineageId !== receipt.lineageId ||
    lane.team !== receipt.request.team ||
    !lane.nodeIds.includes(nodeId)
  )
    throw new Error('Deployment node was not in the debit network');
  const prior = runtime.deployments.find((deployment) => deployment.requestId === requestId);
  if (prior) {
    if (prior.nodeId !== nodeId) throw new Error('Deployment request belongs to another node');
    return runtime;
  }
  return { ...runtime, deployments: [...runtime.deployments, { requestId, nodeId }] };
}

/** Node-facing availability, with shared physical headroom counted once across origin lanes. */
export function campaignSupplyReinforcementAllowance(
  runtime: CampaignSupplyRuntime,
  supply: CampaignSupplyEvaluation,
  ownerTurnId: string,
  capacityBenefitId: string,
  nodeId: string,
): {
  available: number;
  lanes: { networkId: string; lineageId: string; available: number }[];
} {
  const node = supply.nodes[nodeId];
  if (!node) throw new Error('Unknown reinforcement destination node');
  const context = campaignSupplyReinforcementContext(
    runtime,
    supply,
    ownerTurnId,
    capacityBenefitId,
    nodeId,
  );
  if (node.connection === 'none' || node.islandId === null) return { available: 0, lanes: [] };
  const networks = context.networks.filter(
    (network) => JSON.parse(network.networkId)[0] === node.islandId,
  );
  const lanes = networks.map((network) => {
    const allowance = reinforcementAllowance(runtime.reinforcement, context, network.networkId);
    if (!allowance.ok) throw new Error(allowance.reason);
    return {
      networkId: network.networkId,
      lineageId: network.lineageId,
      available: allowance.available,
    };
  });
  const headroom = networks[0]?.currentRemaining ?? 0;
  let available = 0;
  for (const lane of lanes)
    available = lane.available >= headroom - available ? headroom : available + lane.available;
  return { available, lanes };
}

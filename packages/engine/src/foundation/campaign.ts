import type { GameState, Team } from '../types.ts';
import type { Battle } from '../types.ts';
import { buildWorld } from '../grid.ts';
import type { World } from '../grid.ts';
import { generateTerrain } from '../terrain.ts';
import type { Terrain } from '../terrain.ts';
import type { CampaignInfrastructure, CampaignNodeProfile } from './campaignNodes.ts';
import type { CampaignGarrisonState } from './campaignGarrisons.ts';
import type { CampaignSupplyRuntime, CampaignSupplyBenefit } from './campaignSupply.ts';
import type { SupplyProfile } from './supplyGraph.ts';
import type { BuildingTier } from './attributes.ts';
import { getFreeShotPrompt } from './freeShots.ts';
import {
  campaignBuildingData,
  createCampaignInfrastructure,
  validateCampaignInfrastructure,
  validateCampaignNodeProfile,
  refreshCampaignNodeSnapshot,
  openCampaignNodeTurn,
  prepareCampaignCapture,
} from './campaignNodes.ts';
import {
  createCampaignGarrisonState,
  openCampaignGarrisonCycle,
  beginCampaignFreeShots,
  validateCampaignGarrisonState,
} from './campaignGarrisons.ts';
import {
  createCampaignSupplyRuntime,
  campaignSupplyConnectors,
  evaluateCampaignSupply,
  projectSupplyBuildingIncome,
  openCampaignSupplyCycle,
  refreshCampaignSupplyOrigins,
  validateCampaignSupplyRuntime,
} from './campaignSupply.ts';
import { validateSupplyProfile, validateSupplyGraphInput } from './supplyGraph.ts';
import type { SupplyRoadSection } from './supplyGraph.ts';
import {
  addFoundationAmounts,
  evaluateFoundationAttribute,
  foundationExactAmount,
  multiplyFoundationAmounts,
} from './attributes.ts';
import { validateCampaignRazeTileState } from './campaignRaze.ts';
import { validateCampaignWithdrawal } from './campaignWithdrawal.ts';
import type { CampaignSupplyEvaluation, CampaignSupplyHqBenefits } from './campaignSupply.ts';
import {
  projectGameTerritorialControl,
  calculateTerritorialIncome,
  territorialClaimCounts,
} from './control.ts';
import type { TerritorialControl } from './control.ts';

export interface CampaignBuildingEffects {
  readonly income: number;
  readonly housing: number;
  readonly throughput: number;
  readonly recruitment: boolean;
  readonly relayRangeBonus: number;
  readonly reinforcement: number;
}

export interface CampaignConfiguration {
  readonly id: string;
  readonly name: string;
  readonly tuningStatus: 'playtest' | 'configured';
  readonly nodes: CampaignNodeProfile;
  readonly supply: SupplyProfile;
  readonly benefits: readonly CampaignSupplyBenefit[];
  readonly effects: Readonly<
    Record<string, Readonly<Partial<Record<BuildingTier, CampaignBuildingEffects>>>>
  >;
  readonly throughputHomeMultiplier: number;
  readonly throughputRegionalMultiplier: number;
  readonly roadRepairCp: number;
  /** Explicit map assets; no roads are manufactured by loading or recomputing supply. */
  readonly roads?: readonly SupplyRoadSection[];
}

export interface CampaignTurnClock {
  readonly ownerCycle: Readonly<Record<Team, string>>;
  readonly paidIncomeEvents: readonly string[];
  readonly startedCycles: readonly string[];
  /** Surviving tactical positions remain available until all manual outcomes finish. */
  readonly completedBattleIds: readonly string[];
  readonly resolvingBattle: Battle | null;
  readonly pendingTurnStart: string | null;
}

export interface CampaignFoundationState extends CampaignInfrastructure {
  readonly configuration?: CampaignConfiguration;
  readonly garrisons?: CampaignGarrisonState;
  readonly supply?: CampaignSupplyRuntime;
  readonly clock?: CampaignTurnClock;
}

const worlds = new Map<string, { world: World; terrain: Terrain }>();
const supplySnapshots = new Map<string, CampaignSupplyEvaluation>();
function geometry(state: GameState): { world: World; terrain: Terrain } {
  const key = JSON.stringify([state.settings.grid, state.settings.seed]);
  const old = worlds.get(key);
  if (old) return old;
  const world = buildWorld(state.settings.grid);
  const result = { world, terrain: generateTerrain(world, state.settings.seed) };
  if (worlds.size >= 8) worlds.delete(worlds.keys().next().value!);
  worlds.set(key, result);
  return result;
}
function freezeProjection<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeProjection(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Pending ownership/target input always precedes ordinary commands and AI turn logic. */
export function foundationPendingTeam(state: GameState): Team | null {
  const foundation = state.infrastructure;
  if (!foundation) return null;
  if (foundation.capture.pending) return foundation.capture.pending.team;
  if (foundation.garrisons?.pendingStationing) return foundation.garrisons.pendingStationing.winner;
  const shots = foundation.garrisons?.freeShots;
  if (shots?.pending) {
    const prompt = getFreeShotPrompt(shots);
    if (prompt.ok && prompt.status !== 'complete') return prompt.team;
  }
  return null;
}

export function foundationHasPending(state: GameState): boolean {
  return !!(
    state.infrastructure?.capture.pending ||
    state.infrastructure?.garrisons?.pendingStationing ||
    state.infrastructure?.garrisons?.freeShots.pending
  );
}

export function validateCampaignConfiguration(raw: unknown): string[] {
  const errors: string[] = [];
  try {
    const c = raw as CampaignConfiguration;
    if (
      !c ||
      typeof c.id !== 'string' ||
      !c.id.trim() ||
      typeof c.name !== 'string' ||
      !['configured', 'playtest'].includes(c.tuningStatus)
    )
      return ['Invalid foundation configuration'];
    const nodeError = validateCampaignNodeProfile(c.nodes);
    if (nodeError) errors.push(nodeError);
    validateSupplyProfile(c.supply);
    if (
      !Object.hasOwn(c.supply.terrainCosts, 'land') ||
      !Object.hasOwn(c.supply.terrainCosts, 'marsh')
    )
      errors.push('Campaign supply requires both land and marsh costs');
    if (!Number.isSafeInteger(c.roadRepairCp) || c.roadRepairCp < 0)
      errors.push('Explicit whole CP road repair cost is required');
    if (
      ![c.throughputHomeMultiplier, c.throughputRegionalMultiplier].every(
        (n) => Number.isFinite(n) && n >= 0,
      )
    )
      errors.push('Explicit nonnegative throughput connection multipliers are required');
    if (
      !Array.isArray(c.benefits) ||
      !c.benefits.length ||
      !c.effects ||
      typeof c.effects !== 'object'
    )
      return [...errors, 'Foundation effects and HQ benefit definitions are required'];
    for (const definition of c.nodes.definitions) {
      for (let tier = 1; tier <= definition.maximumTier; tier++) {
        const e = c.effects[definition.id]?.[tier as BuildingTier];
        if (
          !e ||
          typeof e.recruitment !== 'boolean' ||
          ['income', 'housing', 'throughput', 'relayRangeBonus', 'reinforcement'].some(
            (k) =>
              !Number.isFinite(e[k as keyof CampaignBuildingEffects]) ||
              Number(e[k as keyof CampaignBuildingEffects]) < 0,
          )
        )
          errors.push(`Missing or invalid effects: ${definition.id} tier ${tier}`);
      }
    }
    if (
      !c.benefits.some((benefit) => benefit.id === 'income-factor') ||
      !c.benefits.some((benefit) => benefit.id === 'reinforcement')
    )
      errors.push('Income and reinforcement HQ definitions are required');
    const reinforcement = c.benefits.find((b) => b.id === 'reinforcement');
    if (reinforcement) {
      if (reinforcement.units !== 'units')
        errors.push('Reinforcement benefit must use whole-unit output');
      if (reinforcement.rounding === 'none' && reinforcement.applyRouteEfficiency)
        errors.push('Distance-modified reinforcement needs an explicit integer rounding boundary');
      for (const e of Object.values(c.effects).flatMap((tiers) => Object.values(tiers))) {
        if (!e) continue;
        for (const context of [
          { kind: 'home' as const, homeConnected: true, factor: 1 },
          {
            kind: 'regional' as const,
            homeConnected: false,
            factor: reinforcement.isolatedRegionalFactor,
          },
          { kind: 'regional' as const, homeConnected: true, factor: 1 },
        ]) {
          const output = evaluateFoundationAttribute({
            definition: {
              id: 'reinforcement',
              units: 'units',
              groups: [{ id: 'hq', phase: 'flat', combine: 'highest-only' }],
              hqGroupId: 'hq',
              minimum: 0,
              maximum: reinforcement.maximum,
              rounding: reinforcement.rounding,
            },
            targetId: 'profile-check',
            baseValue: 0,
            contributions: [],
            hqContributions: [
              {
                sourceId: 'profile-hq',
                hqId: 'profile-hq',
                attributeId: 'reinforcement',
                targetId: 'profile-check',
                units: 'units',
                active: true,
                eligible: true,
                kind: context.kind,
                homeConnected: context.homeConnected,
                value: multiplyFoundationAmounts(e.reinforcement, context.factor),
                boost: reinforcement.homeConnectedBoost,
              },
            ],
          }).value;
          if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0)
            errors.push('Configured reinforcement modifiers can produce an invalid unit count');
        }
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : 'Invalid foundation configuration');
  }
  return errors;
}

/** Pure validation only: loading never calls initialization or a turn/event resolver. */
export function validateCampaignFoundationState(state: GameState, world: World): string[] {
  const errors: string[] = [];
  const f = state.infrastructure;
  if (f === undefined)
    return state.settings.infrastructure ? ['Configured infrastructure state is missing'] : errors;
  if (f === null || typeof f !== 'object') return ['Malformed foundation runtime'];
  const nodeError = validateCampaignInfrastructure(f, world, state.hq);
  if (nodeError) errors.push(nodeError);
  if (!f.configuration || !f.garrisons || !f.supply || !f.clock)
    return [...errors, 'Foundation runtime is incomplete'];
  errors.push(...validateCampaignConfiguration(f.configuration));
  if (canonical(f.configuration) !== canonical(state.settings.infrastructure))
    errors.push('Saved foundation configuration differs from settings');
  if (canonical(f.profile) !== canonical(f.configuration.nodes))
    errors.push('Node profile differs from configured rules');
  if (
    canonical(f.supply.profile) !== canonical(f.configuration.supply) ||
    canonical(f.supply.benefits) !== canonical(f.configuration.benefits)
  )
    errors.push('Supply profile differs from configured rules');
  if (
    f.capture.work.commandPoints.A !== state.cp.A ||
    f.capture.work.commandPoints.B !== state.cp.B
  )
    errors.push('Foundation CP snapshot differs from campaign CP');
  const garrisonError = validateCampaignGarrisonState(state);
  if (garrisonError) errors.push(garrisonError);
  const supplyError = validateCampaignSupplyRuntime(f.supply);
  if (supplyError) errors.push(supplyError);
  const tileError = validateCampaignRazeTileState(state);
  if (tileError) errors.push(tileError);
  if (state.battle) {
    const withdrawalError = validateCampaignWithdrawal(state.battle, state);
    if (withdrawalError) errors.push(withdrawalError);
  }
  try {
    const terrain = geometry(state).terrain;
    const relayBonuses = Object.fromEntries(
      f.capture.nodes.map((node) => [
        node.id,
        campaignNodeEffects(state, node.id).reduce(
          (n, item) => addFoundationAmounts(n, item.effects.relayRangeBonus),
          foundationExactAmount(0),
        ),
      ]),
    );
    validateSupplyGraphInput({
      cells: world.subs.map((cell) => ({
        key: cell.key,
        mainHex: cell.main,
        height: terrain.heights[cell.index]!,
        terrain: terrain.heights[cell.index] === 0 ? 'marsh' : 'land',
      })),
      connectors: campaignSupplyConnectors(f, relayBonuses),
      roads: f.supply.roads,
      blockers: [],
      claims: Object.fromEntries(
        Object.entries(state.hexes).map(([key, value]) => [key, value.owner]),
      ),
      profile: f.supply.profile,
      team: 'A',
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Invalid supply map geometry');
  }
  const c = f.clock;
  for (const list of [c.paidIncomeEvents, c.startedCycles, c.completedBattleIds])
    if (
      !Array.isArray(list) ||
      list.some((id) => typeof id !== 'string' || !id) ||
      new Set(list).size !== list.length
    )
      errors.push('Invalid saved foundation event history');
  for (const team of ['A', 'B'] as const)
    if (!c.ownerCycle?.[team] || c.ownerCycle[team] !== f.ownerTurns[team])
      errors.push('Owner cycle differs from node work cycle');
  if (c.pendingTurnStart !== null && c.pendingTurnStart !== c.ownerCycle[state.active])
    errors.push('Invalid pending turn-start event');
  if (
    c.resolvingBattle &&
    (state.battle?.id !== c.resolvingBattle.id || state.battle.phase !== 'over')
  )
    errors.push('Manual resolution lost its saved final battle');
  else if (c.resolvingBattle && canonical(c.resolvingBattle) !== canonical(state.battle))
    errors.push('Saved final battle snapshots disagree');
  return errors;
}

export function initializeCampaignFoundation(state: GameState): void {
  const configuration = state.settings.infrastructure;
  if (!configuration) return;
  const invalid = validateCampaignConfiguration(configuration);
  if (invalid.length) throw new Error(invalid.join('; '));
  const world = buildWorld(state.settings.grid);
  const base = createCampaignInfrastructure(state, world, configuration.nodes);
  const ownerCycle = { A: 'A:0', B: 'B:0' };
  state.infrastructure = {
    ...base,
    ownerTurns: ownerCycle,
    configuration: structuredClone(configuration),
    garrisons: createCampaignGarrisonState(),
    supply: createCampaignSupplyRuntime({
      profile: configuration.supply,
      benefits: configuration.benefits,
      roads: configuration.roads ?? [],
      hqBenefits: [],
    }),
    clock: {
      ownerCycle,
      paidIncomeEvents: [],
      startedCycles: [],
      completedBattleIds: [],
      resolvingBattle: null,
      pendingTurnStart: null,
    },
  };
  for (const team of ['A', 'B'] as const) openCampaignGarrisonCycle(state, team, ownerCycle[team]);
  syncCampaignClaims(state);
}

export function campaignTerritorialControl(state: GameState): TerritorialControl {
  const { world } = geometry(state);
  return projectGameTerritorialControl(
    state,
    world,
    state.infrastructure?.capture.nodes.map((node) => ({
      id: node.id,
      mainHexId: node.mainHex,
      owner: node.owner,
    })) ?? [],
  );
}

/** Legacy owner is a rendered/cache projection in configured games, never node authority. */
export function syncCampaignClaims(state: GameState): void {
  if (!state.infrastructure) return;
  const control = campaignTerritorialControl(state);
  for (const [key, cell] of Object.entries(control))
    state.hexes[key] = {
      ...state.hexes[key],
      owner: cell.claim,
      warning: state.hexes[key]?.owner === cell.claim ? (state.hexes[key]?.warning ?? 0) : 0,
    };
}

export function campaignNodeEffects(
  state: GameState,
  nodeId: string,
): {
  buildingId: string;
  effects: CampaignBuildingEffects;
  tier: BuildingTier;
}[] {
  const f = state.infrastructure;
  if (!f?.configuration) return [];
  const node = f.capture.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const center = node.buildings.find((b) => campaignBuildingData(b).placement === 'center');
  if (!center || center.ruined || !campaignBuildingData(center).active) return [];
  const tacticalRuins = new Set(state.battle?.ruinedInfrastructureBuildingIds ?? []);
  return node.buildings
    .filter((b) => !b.ruined && !tacticalRuins.has(b.id) && campaignBuildingData(b).active)
    .map((b) => {
      const data = campaignBuildingData(b);
      const effects = f.configuration!.effects[data.definitionId]?.[data.tier];
      if (!effects) throw new Error('Building effect profile is incomplete');
      return { buildingId: b.id, effects, tier: data.tier };
    });
}

/** Whole-unit eligibility floors once after the exact additive/modifier pipeline. */
export function campaignNodeCapacity(
  state: GameState,
  nodeId: string,
  attribute: 'housing' | 'throughput',
  multiplier = 1,
): number {
  const effects = campaignNodeEffects(state, nodeId);
  const output = evaluateFoundationAttribute({
    definition: {
      id: attribute,
      units: 'units',
      groups: [
        { id: 'buildings', phase: 'flat', combine: 'additive' },
        { id: 'connection', phase: 'multiplier', combine: 'multiplicative' },
      ],
      hqGroupId: null,
      minimum: 0,
      maximum: null,
      rounding: 'floor',
    },
    targetId: nodeId,
    baseValue: 0,
    contributions: [
      ...effects.map((building) => ({
        sourceId: building.buildingId,
        attributeId: attribute,
        targetId: nodeId,
        units: 'units',
        groupId: 'buildings',
        active: true,
        eligible: true,
        value: building.effects[attribute],
      })),
      {
        sourceId: `${nodeId}:connection`,
        attributeId: attribute,
        targetId: nodeId,
        units: 'factor',
        groupId: 'connection',
        active: true,
        eligible: true,
        value: multiplier,
      },
    ],
    hqContributions: [],
  }).value;
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0)
    throw new Error('Building unit capacity exceeds the supported safe whole-count range');
  return output;
}

export function campaignSupplyView(state: GameState, team: Team): CampaignSupplyEvaluation | null {
  const f = state.infrastructure;
  if (!f?.supply || !f.configuration) return null;
  const { world, terrain } = geometry(state);
  const relayBonuses = Object.fromEntries(
    f.capture.nodes.map((node) => [
      node.id,
      campaignNodeEffects(state, node.id).reduce(
        (n, item) => addFoundationAmounts(n, item.effects.relayRangeBonus),
        foundationExactAmount(0),
      ),
    ]),
  );
  const nodes = campaignSupplyConnectors(f, relayBonuses).map((node) => {
    const site = f.sites.find((s) => s.nodeId === node.id)!;
    return {
      ...node,
      authority:
        site.homeTeam === team && node.owner === team
          ? ('home' as const)
          : node.authority === 'home'
            ? null
            : node.authority,
    };
  });
  const hqBenefits: CampaignSupplyHqBenefits[] = nodes
    .filter((node) => node.authority !== null)
    .map((node) => ({
      authorityId: node.id,
      contributions: [
        { benefitId: 'income-factor', value: 1 },
        {
          benefitId: 'reinforcement',
          value: Math.max(
            0,
            ...campaignNodeEffects(state, node.id).map((b) => b.effects.reinforcement),
          ),
        },
      ],
    }));
  const input = {
    world,
    terrain,
    team,
    nodes,
    roads: f.supply.roads,
    stationedUnits: state.armies
      .filter((a) => a.kind === 'garrison' && a.building === 'temporary')
      .flatMap((a) =>
        a.units.map((u) => ({ unitId: u.id, team: a.team, subHex: a.pos, hp: u.hp })),
      ),
    control: campaignTerritorialControl(state),
    profile: f.supply.profile,
    benefits: f.supply.benefits,
    hqBenefits,
  };
  const key = JSON.stringify([
    state.settings.grid,
    state.settings.seed,
    team,
    nodes,
    input.roads,
    input.stationedUnits,
    input.control,
    input.profile,
    input.benefits,
    hqBenefits,
  ]);
  const cached = supplySnapshots.get(key);
  if (cached) return cached;
  const result = freezeProjection(evaluateCampaignSupply(input));
  if (supplySnapshots.size >= 16) supplySnapshots.delete(supplySnapshots.keys().next().value!);
  supplySnapshots.set(key, result);
  return result;
}

export function campaignIncome(state: GameState, team: Team): number {
  const supply = campaignSupplyView(state, team);
  if (!supply || !state.infrastructure) return 3;
  const cycle = state.infrastructure.ownerTurns[team];
  const excluded = new Set(
    state.infrastructure.capture.receipts
      .filter((r) => r.batch.team === team && r.batch.ownerTurnId === cycle)
      .flatMap((r) => r.changes.filter((c) => c.outcome === 'capture').map((c) => c.nodeId)),
  );
  const sources = state.infrastructure.capture.nodes
    .filter((node) => node.owner === team)
    .flatMap((node) =>
      campaignNodeEffects(state, node.id).map((b) => ({
        sourceId: b.buildingId,
        nodeId: node.id,
        value: b.effects.income,
        active: true,
        eligible: !excluded.has(node.id),
        reach: 'network' as const,
        benefitId: 'income-factor',
      })),
    );
  return calculateTerritorialIncome(
    campaignTerritorialControl(state),
    team,
    projectSupplyBuildingIncome(supply, sources),
  ).cp;
}

export function campaignOwnedCount(state: GameState, team: Team): number {
  return territorialClaimCounts(campaignTerritorialControl(state))[team];
}

/** Called by real beginTurn only, never by deserialization or route recalculation. */
export function beginCampaignOwnerTurn(state: GameState): void {
  let f = state.infrastructure;
  if (!f?.clock || !f.supply) return;
  const cycle = `${state.active}:${state.turn}`;
  if (f.clock.startedCycles.includes(cycle)) return;
  openCampaignNodeTurn(state);
  f = state.infrastructure!;
  state.infrastructure = {
    ...f,
    clock: {
      ...f.clock!,
      ownerCycle: { ...f.clock!.ownerCycle, [state.active]: cycle },
      startedCycles: [...f.clock!.startedCycles, cycle],
      pendingTurnStart: cycle,
    },
  };
  openCampaignGarrisonCycle(state, state.active, cycle);
  const supply = campaignSupplyView(state, state.active)!;
  f = state.infrastructure!;
  state.infrastructure = {
    ...f,
    supply: openCampaignSupplyCycle(f.supply!, supply, cycle, 'reinforcement'),
  };
  const paymentId = `income:${cycle}`;
  if (!state.infrastructure.clock!.paidIncomeEvents.includes(paymentId)) {
    state.cp[state.active] += campaignIncome(state, state.active);
    f = state.infrastructure;
    state.infrastructure = {
      ...f,
      clock: { ...f.clock!, paidIncomeEvents: [...f.clock!.paidIncomeEvents, paymentId] },
    };
    refreshCampaignNodeSnapshot(state);
  }
  f = state.infrastructure!;
  const prepared = prepareCampaignCapture(state, buildWorld(state.settings.grid), {
    requestId: `capture:${paymentId}`,
    expectedVersion: f.capture.version,
    event: { kind: 'turn-start-after-income', incomeReceiptId: paymentId },
  });
  if (!prepared.ok) throw new Error(prepared.error);
}

/** Capture completion precedes the shared shot boundary; replay cannot repeat income or shots. */
export function resumeCampaignTurnStart(state: GameState): void {
  const f = state.infrastructure;
  if (
    !f?.clock?.pendingTurnStart ||
    f.capture.pending ||
    f.garrisons?.pendingStationing ||
    state.phase === 'over'
  )
    return;
  if (f.garrisons?.freeShots.pending) return;
  const result = beginCampaignFreeShots(state, 'strategic-after-income', state.active);
  if (!result.ok) throw new Error(result.error);
  const latest = state.infrastructure!;
  state.infrastructure = { ...latest, clock: { ...latest.clock!, pendingTurnStart: null } };
}

/** Recompute provenance only after real mutations; no income or budget is issued here. */
export function refreshCampaignNetworks(state: GameState): void {
  let f = state.infrastructure;
  if (!f?.supply) return;
  for (const team of ['A', 'B'] as const) {
    const cycle: string = f.ownerTurns[team];
    if (!f.supply!.reinforcement.cycles.some((c) => c.team === team && c.ownerTurnId === cycle))
      continue;
    const supply = campaignSupplyView(state, team)!;
    state.infrastructure = { ...f, supply: refreshCampaignSupplyOrigins(f.supply!, supply, cycle) };
    f = state.infrastructure;
  }
}

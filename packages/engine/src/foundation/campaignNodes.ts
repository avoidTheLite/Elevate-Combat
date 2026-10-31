// GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002: real campaign node command boundary.
import { hexKey, neighbors } from '../hex.ts';
import type { World } from '../grid.ts';
import { buildWorld } from '../grid.ts';
import type { GameState, Team } from '../types.ts';
import { evaluateBuildingEligibility, validateBuildingUpgradeState } from './attributes.ts';
import type {
  BuildingTier,
  BuildingPlacement,
  BuildingSpecialty,
  FoundationBuildingDefinition,
} from './attributes.ts';
import {
  beginFoundationCapture,
  chooseFoundationCapture,
  commitFoundationCapture,
  validateFoundationCaptureCosts,
  validateFoundationCaptureState,
} from './capture.ts';
import type {
  FoundationCaptureBuilding,
  FoundationCaptureCosts,
  FoundationCaptureEvent,
  FoundationCaptureFacts,
  FoundationCaptureReceipt,
  FoundationCaptureState,
  FoundationCaptureChoiceRequest,
} from './capture.ts';
import { applyFoundationWork } from './workLedger.ts';
import type { FoundationWorkReceipt, NodeWorkSpend } from './workLedger.ts';
import { withRules } from '../rules.ts';
import { unitType } from '../units.ts';
import { projectGameTerritorialControl } from './control.ts';
import { foundationHasPending } from './campaign.ts';

export interface CampaignNodeSite {
  readonly nodeId: string;
  readonly mainHex: string;
  readonly centerSubHex: string;
  readonly annexSubHexes: readonly string[];
  /** Original Home HQ identity survives capture/Raze; existing holder capacity is unchanged. */
  readonly homeTeam: Team | null;
}

export interface CampaignNodeUpgradeOption {
  readonly id: string;
  readonly cpCost: number;
  readonly engineerRequired: boolean;
}

export interface CampaignNodeDefinition extends FoundationBuildingDefinition {
  readonly id: string;
  readonly name: string;
  readonly engineerRequired: boolean;
  readonly costs: {
    readonly build: Readonly<Partial<Record<BuildingTier, number>>>;
    readonly upgrade: Readonly<Partial<Record<BuildingTier, number>>>;
    readonly repair: Readonly<Partial<Record<BuildingTier, number>>>;
  };
  readonly exclusiveUpgrades: readonly CampaignNodeUpgradeOption[];
  readonly slotlessUnlocks: readonly CampaignNodeUpgradeOption[];
}

/** Required configured rules. This module has no production price or balance defaults. */
export interface CampaignNodeProfile {
  readonly id: string;
  readonly activationCp: number;
  readonly captureCosts: FoundationCaptureCosts;
  readonly initialGenericCenterDefinitionId: string;
  readonly homeCenterDefinitionId: string;
  readonly homeCenterTier: BuildingTier;
  readonly activationCenterDefinitionIds: readonly string[];
  readonly definitions: readonly CampaignNodeDefinition[];
}

export type CampaignBuildingData = {
  readonly definitionId: string;
  readonly role: string;
  readonly specialty: BuildingSpecialty;
  readonly tier: BuildingTier;
  readonly placement: BuildingPlacement;
  readonly subHex: string;
  readonly active: boolean;
  readonly exclusiveChoices: readonly string[];
  readonly unlocks: readonly string[];
  readonly equipmentIds: readonly string[];
};

type ActionBase = {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly ownerTurnId: string;
  readonly nodeId: string;
};
export type CampaignNodeAction = ActionBase &
  (
    | {
        readonly kind: 'activate';
        readonly commanderId: string;
        readonly centerDefinitionId: string;
      }
    | {
        readonly kind: 'build';
        readonly definitionId: string;
        readonly subHex: string;
        readonly tier: BuildingTier;
        readonly engineerUnitId: string | null;
      }
    | {
        readonly kind: 'upgrade';
        readonly buildingId: string;
        readonly tier: BuildingTier;
        readonly engineerUnitId: string | null;
      }
    | {
        readonly kind: 'repair-building';
        readonly buildingId: string;
        readonly engineerUnitId: string;
      }
    | {
        readonly kind: 'select-exclusive' | 'unlock';
        readonly buildingId: string;
        readonly optionId: string;
        readonly engineerUnitId: string | null;
      }
  );
type ActionInput<T> = T extends CampaignNodeAction
  ? Omit<T, 'requestId' | 'expectedVersion' | 'ownerTurnId'>
  : never;
export type CampaignNodeActionInput = ActionInput<CampaignNodeAction>;

export interface CampaignNodeView {
  readonly nodeId: string;
  readonly mainHex: string;
  readonly centerSubHex: string;
  readonly name: string;
  readonly status: 'inactive' | 'active' | 'ruined';
  readonly owner: Team | null;
  readonly claim: Team | null;
  readonly contested: boolean;
  readonly homeTeam: Team | null;
  readonly buildings: readonly {
    readonly id: string;
    readonly name: string;
    readonly subHex: string;
    readonly tier: BuildingTier;
    readonly placement: BuildingPlacement;
    readonly ruined: boolean;
    readonly active: boolean;
  }[];
  readonly work: {
    readonly ordinaryRemaining: 0 | 1;
    readonly operationsRemaining: number;
    readonly buildingWindow: 'open' | 'closed';
    readonly activationRepairOnly: boolean;
  };
}

export interface CampaignNodeActionChoice {
  readonly label: string;
  readonly request: CampaignNodeAction;
  readonly cpCost: number;
  readonly legal: boolean;
  readonly reason: string | null;
  readonly engineerUnitId: string | null;
  readonly engineerLabel: string | null;
  readonly allowance: 'ordinary' | 'engineer' | 'activation' | null;
}

export interface CampaignActivationReceipt {
  readonly request: Extract<CampaignNodeAction, { kind: 'activate' }>;
  readonly resultingVersion: number;
  readonly cpSpent: number;
}

export interface CampaignInfrastructure {
  readonly formatVersion: 1;
  readonly profile: CampaignNodeProfile;
  readonly sites: readonly CampaignNodeSite[];
  readonly capture: FoundationCaptureState;
  readonly ownerTurns: Readonly<Record<Team, string>>;
  readonly activationReceipts: readonly CampaignActivationReceipt[];
  /** Original complete requests retain option/slot details beyond the spending primitive. */
  readonly workRequests: readonly CampaignNodeAction[];
}

export type CampaignNodeGameState = GameState & { infrastructure?: CampaignInfrastructure };
export type CampaignNodeResult =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly receipt:
        CampaignActivationReceipt | FoundationWorkReceipt | FoundationCaptureReceipt | null;
    };

const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const tier = (v: unknown): v is BuildingTier => v === 1 || v === 2 || v === 3;
const specialties: readonly string[] = [
  'generic',
  'industrial',
  'military',
  'medical',
  'logistics',
];
const failure = (error: string): CampaignNodeResult => ({ ok: false, error });
const clone = <T>(v: T): T => structuredClone(v);
const turnId = (state: Pick<GameState, 'turn' | 'active'>): string =>
  `${state.active}:${state.turn}`;

/** Deterministic sites use the existing shared lattice, never seven independent nested grids. */
export function campaignNodeSites(
  world: World,
  hq: Readonly<Record<Team, string>>,
): CampaignNodeSite[] {
  if (!world.mainByKey.has(hq.A) || !world.mainByKey.has(hq.B) || hq.A === hq.B)
    throw new Error('Invalid HQ mapping');
  return world.mains.map((main) => {
    const centerSubHex = hexKey(main.center);
    const annexSubHexes = neighbors(main.center).map(hexKey);
    if (
      new Set([centerSubHex, ...annexSubHexes]).size !== 7 ||
      [centerSubHex, ...annexSubHexes].some((key) => world.subByKey.get(key)?.main !== main.key)
    ) {
      throw new Error('Node geometry must contain seven adjacent cells in its MainHex');
    }
    return {
      nodeId: `node:${main.key}`,
      mainHex: main.key,
      centerSubHex,
      annexSubHexes,
      homeTeam: main.key === hq.A ? 'A' : main.key === hq.B ? 'B' : null,
    };
  });
}

/** Reads typed building payloads retained by the generic capture transaction. */
export function campaignBuildingData(building: FoundationCaptureBuilding): CampaignBuildingData {
  const data = building.data as CampaignBuildingData | null;
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !id(data.definitionId) ||
    !id(data.role) ||
    !specialties.includes(data.specialty) ||
    !tier(data.tier) ||
    !['center', 'annex'].includes(data.placement) ||
    !id(data.subHex) ||
    typeof data.active !== 'boolean' ||
    !Array.isArray(data.exclusiveChoices) ||
    !Array.isArray(data.unlocks) ||
    !Array.isArray(data.equipmentIds) ||
    [data.exclusiveChoices, data.unlocks, data.equipmentIds].some(
      (values) => values.some((value) => !id(value)) || new Set(values).size !== values.length,
    )
  ) {
    throw new Error('Invalid campaign building payload');
  }
  return data;
}

function definition(profile: CampaignNodeProfile, definitionId: string): CampaignNodeDefinition {
  const found = profile.definitions.find((d) => d.id === definitionId);
  if (!found) throw new Error(`Unknown building definition: ${definitionId}`);
  return found;
}

/** Validate explicit data at initialization/load, including every configured tier price. */
export function validateCampaignNodeProfile(profile: CampaignNodeProfile): string | null {
  try {
    if (
      !profile ||
      !id(profile.id) ||
      !whole(profile.activationCp) ||
      validateFoundationCaptureCosts(profile.captureCosts) ||
      !Array.isArray(profile.definitions) ||
      !profile.definitions.length ||
      new Set(profile.definitions.map((d) => d.id)).size !== profile.definitions.length ||
      !Array.isArray(profile.activationCenterDefinitionIds) ||
      !profile.activationCenterDefinitionIds.length ||
      new Set(profile.activationCenterDefinitionIds).size !==
        profile.activationCenterDefinitionIds.length ||
      !tier(profile.homeCenterTier)
    )
      throw new Error('Invalid node profile');
    for (const d of profile.definitions) {
      if (
        !d ||
        !id(d.id) ||
        !id(d.name) ||
        typeof d.engineerRequired !== 'boolean' ||
        !d.costs ||
        !d.costs.build ||
        !d.costs.upgrade ||
        !d.costs.repair ||
        !Array.isArray(d.exclusiveUpgrades) ||
        !Array.isArray(d.slotlessUnlocks)
      )
        throw new Error('Invalid building definition');
      evaluateBuildingEligibility({
        definition: d,
        center: { role: 'generic', tier: 3 },
        placement: d.centerEligible ? 'center' : 'annex',
        requestedTier: d.maximumTier,
        availablePrerequisites: d.prerequisites,
      });
      for (let n = 1; n <= d.maximumTier; n++) {
        if (
          !whole(d.costs.build[n as BuildingTier]) ||
          !whole(d.costs.repair[n as BuildingTier]) ||
          (n > 1 && !whole(d.costs.upgrade[n as BuildingTier]))
        )
          throw new Error('Missing explicit tier price');
      }
      for (const options of [d.exclusiveUpgrades, d.slotlessUnlocks]) {
        if (
          new Set(options.map((o: CampaignNodeUpgradeOption) => o.id)).size !== options.length ||
          options.some(
            (o: CampaignNodeUpgradeOption) =>
              !o || !id(o.id) || !whole(o.cpCost) || typeof o.engineerRequired !== 'boolean',
          )
        )
          throw new Error('Invalid upgrade options');
      }
    }
    const generic = definition(profile, profile.initialGenericCenterDefinitionId);
    const home = definition(profile, profile.homeCenterDefinitionId);
    if (
      !generic.centerEligible ||
      generic.specialty !== 'generic' ||
      !home.centerEligible ||
      profile.homeCenterTier > home.maximumTier ||
      (home.specialty !== 'generic' && profile.homeCenterTier > 2)
    ) {
      throw new Error('Invalid starting center definition');
    }
    for (const key of profile.activationCenterDefinitionIds)
      if (!definition(profile, key).centerEligible) {
        throw new Error('Activation requires center-eligible definitions');
      }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid node profile';
  }
}

function buildingData(
  d: CampaignNodeDefinition,
  subHex: string,
  placement: BuildingPlacement,
  buildingTier: BuildingTier,
  active = true,
): CampaignBuildingData {
  return {
    definitionId: d.id,
    role: d.role,
    specialty: d.specialty,
    tier: buildingTier,
    placement,
    subHex,
    active,
    exclusiveChoices: [],
    unlocks: [],
    equipmentIds: [],
  };
}

/** Fresh/migrated initialization only: retains CP, armies, HQ garrisons (cap 12), forts and RNG. */
export function createCampaignInfrastructure(
  state: GameState,
  world: World,
  profile: CampaignNodeProfile,
): CampaignInfrastructure {
  const invalid = validateCampaignNodeProfile(profile);
  if (invalid) throw new Error(invalid);
  const sites = campaignNodeSites(world, state.hq);
  return {
    formatVersion: 1,
    profile: clone(profile),
    sites,
    capture: {
      version: 0,
      work: {
        version: 0,
        commandPoints: { ...state.cp },
        nodeSpending: [],
        engineerSpending: [],
        receipts: [],
      },
      nodes: sites.map((site) => {
        const d = definition(
          profile,
          site.homeTeam ? profile.homeCenterDefinitionId : profile.initialGenericCenterDefinitionId,
        );
        return {
          id: site.nodeId,
          mainHex: site.mainHex,
          centerSubHex: site.centerSubHex,
          owner: site.homeTeam,
          buildings: [
            {
              id: `${site.nodeId}:center`,
              ruined: false,
              data: buildingData(
                d,
                site.centerSubHex,
                'center',
                site.homeTeam ? profile.homeCenterTier : 1,
                !!site.homeTeam,
              ),
            },
          ],
        };
      }),
      pending: null,
      receipts: [],
    },
    ownerTurns: { A: `A:${state.turn}`, B: `B:${state.turn}` },
    activationReceipts: [],
    workRequests: [],
  };
}

/** Strict saved-state validation; never reconstructs, resets or re-prices existing progress. */
export function validateCampaignInfrastructure(
  infra: CampaignInfrastructure,
  world: World,
  hq: Readonly<Record<Team, string>>,
): string | null {
  try {
    if (
      !infra ||
      infra.formatVersion !== 1 ||
      validateCampaignNodeProfile(infra.profile) ||
      validateFoundationCaptureState(infra.capture) ||
      !infra.ownerTurns ||
      !id(infra.ownerTurns.A) ||
      !id(infra.ownerTurns.B) ||
      !Array.isArray(infra.activationReceipts) ||
      !Array.isArray(infra.workRequests)
    )
      throw new Error('Invalid campaign infrastructure');
    const expected = campaignNodeSites(world, hq);
    if (
      JSON.stringify(infra.sites) !== JSON.stringify(expected) ||
      infra.capture.nodes.length !== expected.length
    ) {
      throw new Error('Site registry differs from map geometry');
    }
    for (const site of infra.sites) {
      const node = infra.capture.nodes.find((n) => n.id === site.nodeId);
      if (!node || node.mainHex !== site.mainHex || node.centerSubHex !== site.centerSubHex)
        throw new Error('Node/site mismatch');
      const slots = new Set<string>();
      let centers = 0;
      for (const building of node.buildings) {
        const data = campaignBuildingData(building);
        const d = definition(infra.profile, data.definitionId);
        if (
          data.role !== d.role ||
          data.specialty !== d.specialty ||
          data.tier > d.maximumTier ||
          (data.placement === 'center'
            ? !d.centerEligible || data.subHex !== site.centerSubHex
            : !d.annexEligible || !site.annexSubHexes.includes(data.subHex)) ||
          slots.has(data.subHex) ||
          (data.placement === 'center' && data.specialty !== 'generic' && data.tier > 2)
        )
          throw new Error('Invalid building placement or definition');
        slots.add(data.subHex);
        if (data.placement === 'center') centers++;
        if (
          !validateBuildingUpgradeState({
            maximumTier: d.maximumTier,
            tier: data.tier,
            exclusiveOptions: d.exclusiveUpgrades.map((o) => o.id),
            slotlessOptions: d.slotlessUnlocks.map((o) => o.id),
            exclusiveChoices: data.exclusiveChoices,
            unlocks: data.unlocks,
          }).valid
        )
          throw new Error('Invalid building upgrades');
      }
      if (centers !== 1) throw new Error('Node requires exactly one center');
    }
    const ids = new Set<string>();
    const versions = new Set(infra.capture.work.receipts.map((r) => r.resultingVersion));
    for (const batch of [
      ...infra.capture.receipts.map((r) => r.batch),
      ...(infra.capture.pending ? [infra.capture.pending] : []),
    ]) {
      versions.add(batch.openedVersion);
      for (const choice of batch.choices) versions.add(choice.resultingVersion);
    }
    for (const receipt of infra.capture.receipts) versions.add(receipt.resultingVersion);
    for (const receipt of infra.activationReceipts) {
      if (
        !receipt ||
        !actionValid(receipt.request) ||
        receipt.request.kind !== 'activate' ||
        ids.has(receipt.request.requestId) ||
        !whole(receipt.resultingVersion) ||
        receipt.resultingVersion !== receipt.request.expectedVersion + 1 ||
        receipt.resultingVersion > infra.capture.version ||
        versions.has(receipt.resultingVersion) ||
        !whole(receipt.cpSpent)
      )
        throw new Error('Invalid activation history');
      ids.add(receipt.request.requestId);
      versions.add(receipt.resultingVersion);
    }
    for (const action of infra.workRequests) {
      if (
        !actionValid(action) ||
        action.kind === 'activate' ||
        ids.has(action.requestId) ||
        !infra.capture.work.receipts.some((r) => r.request.requestId === action.requestId)
      )
        throw new Error('Invalid campaign work history');
      ids.add(action.requestId);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid campaign infrastructure';
  }
}

function actionValid(action: CampaignNodeAction): boolean {
  if (
    !action ||
    !id(action.requestId) ||
    !whole(action.expectedVersion) ||
    !id(action.ownerTurnId) ||
    !id(action.nodeId)
  )
    return false;
  if (action.kind === 'activate') return id(action.commanderId) && id(action.centerDefinitionId);
  if (action.kind === 'repair-building') return id(action.buildingId) && id(action.engineerUnitId);
  const engineer = action.engineerUnitId === null || id(action.engineerUnitId);
  if (action.kind === 'build')
    return engineer && id(action.definitionId) && id(action.subHex) && tier(action.tier);
  if (action.kind === 'upgrade') return engineer && id(action.buildingId) && tier(action.tier);
  return (
    (action.kind === 'select-exclusive' || action.kind === 'unlock') &&
    engineer &&
    id(action.buildingId) &&
    id(action.optionId)
  );
}

function actionKey(action: CampaignNodeAction): string {
  return JSON.stringify([
    action.requestId,
    action.expectedVersion,
    action.ownerTurnId,
    action.nodeId,
    action.kind,
    action.kind === 'activate'
      ? [action.commanderId, action.centerDefinitionId]
      : action.kind === 'build'
        ? [action.definitionId, action.subHex, action.tier, action.engineerUnitId]
        : action.kind === 'upgrade'
          ? [action.buildingId, action.tier, action.engineerUnitId]
          : action.kind === 'repair-building'
            ? [action.buildingId, action.engineerUnitId]
            : [action.buildingId, action.optionId, action.engineerUnitId],
  ]);
}

/** Explicit external-action hook: holder/CP changes invalidate command snapshots without rewards. */
export function refreshCampaignNodeSnapshot(state: CampaignNodeGameState): void {
  const infra = state.infrastructure;
  if (!infra) return;
  if (!whole(state.cp.A) || !whole(state.cp.B) || infra.capture.version >= Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid/exhausted campaign snapshot');
  const version = infra.capture.version + 1;
  state.infrastructure = {
    ...infra,
    capture: {
      ...infra.capture,
      version,
      work: { ...infra.capture.work, version, commandPoints: { ...state.cp } },
    },
  };
}

/** Opening a new owner token exposes its ordinary work window; old receipts/counters stay intact. */
export function openCampaignNodeTurn(state: CampaignNodeGameState): void {
  const infra = state.infrastructure;
  if (!infra) return;
  const nextId = turnId(state);
  const changed =
    infra.ownerTurns[state.active] !== nextId ||
    infra.capture.work.commandPoints.A !== state.cp.A ||
    infra.capture.work.commandPoints.B !== state.cp.B;
  if (!changed) return;
  refreshCampaignNodeSnapshot(state);
  state.infrastructure = {
    ...state.infrastructure!,
    ownerTurns: { ...infra.ownerTurns, [state.active]: nextId },
  };
}

/** Shared real-state action path for humans and AI; invalid requests mutate nothing. */
export function applyCampaignNodeAction(
  state: CampaignNodeGameState,
  world: World,
  action: CampaignNodeAction,
): CampaignNodeResult {
  const infra = state.infrastructure;
  if (!infra) return failure('Infrastructure is not enabled');
  const invalid = validateCampaignInfrastructure(infra, world, state.hq);
  if (invalid) return failure(invalid);
  if (!actionValid(action)) return failure('Invalid node request');
  const previousActivation = infra.activationReceipts.find(
    (r) => r.request.requestId === action.requestId,
  );
  const previousWork = infra.workRequests.find((r) => r.requestId === action.requestId);
  const previous = previousActivation?.request ?? previousWork;
  if (previous) {
    if (actionKey(previous) !== actionKey(action))
      return failure('Request ID already belongs to another node action');
    return {
      ok: true,
      replayed: true,
      receipt:
        previousActivation ??
        infra.capture.work.receipts.find((r) => r.request.requestId === action.requestId)!,
    };
  }
  if (state.phase !== 'strategic' || foundationHasPending(state))
    return failure('Finish the pending event before node work');
  if (
    action.expectedVersion !== infra.capture.version ||
    infra.capture.version >= Number.MAX_SAFE_INTEGER
  )
    return failure('Node snapshot is stale or exhausted');
  if (action.ownerTurnId !== infra.ownerTurns[state.active])
    return failure('Node work must use the current owner turn');
  if (
    infra.capture.work.commandPoints.A !== state.cp.A ||
    infra.capture.work.commandPoints.B !== state.cp.B
  )
    return failure('CP snapshot changed; refresh infrastructure first');
  const node = infra.capture.nodes.find((n) => n.id === action.nodeId);
  const site = infra.sites.find((s) => s.nodeId === action.nodeId);
  if (!node || !site) return failure('Unknown node');
  const center = node.buildings.find((b) => campaignBuildingData(b).placement === 'center')!;
  const centerData = campaignBuildingData(center);
  if (action.kind === 'activate') {
    const commander = state.armies.find((a) => a.id === action.commanderId);
    if (
      !commander ||
      commander.kind !== 'commander' ||
      commander.team !== state.active ||
      commander.at !== node.mainHex ||
      !commander.units.some((u) => u.hp > 0)
    )
      return failure('Activation needs a living friendly commander in this MainHex');
    if (
      (node.owner !== null && node.owner !== state.active) ||
      (state.hexes[node.mainHex]?.owner !== null &&
        state.hexes[node.mainHex]?.owner !== state.active)
    )
      return failure('Activation cannot bypass hostile control');
    if (
      state.armies.some(
        (a) =>
          a.team !== state.active && a.pos === node.centerSubHex && a.units.some((u) => u.hp > 0),
      )
    )
      return failure('A hostile unit occupies the center');
    if (centerData.active && node.owner !== null) return failure('Node is already active');
    const restoring = centerData.active;
    if (
      restoring
        ? action.centerDefinitionId !== centerData.definitionId
        : !infra.profile.activationCenterDefinitionIds.includes(action.centerDefinitionId)
    )
      return failure('Center choice is not eligible for activation');
    const d = definition(infra.profile, action.centerDefinitionId);
    if (state.cp[state.active] < infra.profile.activationCp)
      return failure('Not enough command points');
    const old = infra.capture.work.nodeSpending.find(
      (s) =>
        s.nodeId === node.id && s.team === state.active && s.ownerTurnId === action.ownerTurnId,
    );
    const spend: NodeWorkSpend = {
      ...(old ?? {
        nodeId: node.id,
        team: state.active,
        ownerTurnId: action.ownerTurnId,
        ordinarySpent: false,
        operationCount: 0,
        activationRepairSpent: false,
      }),
      activationClosed: true,
    };
    const version = infra.capture.version + 1;
    const commandPoints = {
      ...state.cp,
      [state.active]: state.cp[state.active] - infra.profile.activationCp,
    };
    const receipt: CampaignActivationReceipt = {
      request: clone(action),
      resultingVersion: version,
      cpSpent: infra.profile.activationCp,
    };
    state.infrastructure = {
      ...infra,
      activationReceipts: [...infra.activationReceipts, receipt],
      capture: {
        ...infra.capture,
        version,
        nodes: infra.capture.nodes.map((n) =>
          n.id === node.id
            ? {
                ...n,
                owner: state.active,
                buildings: n.buildings.map((b) =>
                  b.id === center.id
                    ? {
                        ...b,
                        data: restoring
                          ? { ...centerData, active: true }
                          : buildingData(d, node.centerSubHex, 'center', 1),
                      }
                    : b,
                ),
              }
            : n,
        ),
        work: {
          ...infra.capture.work,
          version,
          commandPoints,
          nodeSpending: [...infra.capture.work.nodeSpending.filter((s) => s !== old), spend],
        },
      },
    };
    state.cp = commandPoints;
    return { ok: true, replayed: false, receipt };
  }
  if (node.owner !== state.active) return failure('Node is not controlled by the active team');
  if (!centerData.active) return failure('Activate this site before building work');
  const existing =
    'buildingId' in action ? node.buildings.find((b) => b.id === action.buildingId) : undefined;
  if (action.kind !== 'build' && !existing) return failure('Unknown building');
  const data = existing ? campaignBuildingData(existing) : null;
  const d = infra.profile.definitions.find(
    (candidate) =>
      candidate.id === (action.kind === 'build' ? action.definitionId : data!.definitionId),
  );
  if (!d) return failure('Unknown building definition');
  const availablePrerequisites = Array.from(
    new Set(
      node.buildings
        .filter((b) => !b.ruined && campaignBuildingData(b).active)
        .map((b) => campaignBuildingData(b).definitionId),
    ),
  );
  const checkEligibility = (requestedTier: BuildingTier): string | null => {
    const result = evaluateBuildingEligibility({
      definition: d,
      center: { role: centerData.specialty, tier: centerData.tier },
      placement: 'annex',
      requestedTier,
      availablePrerequisites,
    });
    return result.eligible ? null : `Building is ineligible: ${result.reason}`;
  };
  let replacement: FoundationCaptureBuilding;
  let cpCost: number | undefined;
  let engineerRequired = d.engineerRequired;
  let targetId: string;
  if (action.kind === 'build') {
    if (center.ruined) return failure('Repair the center before new construction');
    if (
      !site.annexSubHexes.includes(action.subHex) ||
      node.buildings.some((b) => campaignBuildingData(b).subHex === action.subHex)
    )
      return failure('Annex slot is unavailable');
    const reason = checkEligibility(action.tier);
    if (reason) return failure(reason);
    replacement = {
      id: `building:${action.requestId}`,
      ruined: false,
      data: buildingData(d, action.subHex, 'annex', action.tier),
    };
    cpCost = d.costs.build[action.tier];
    targetId = replacement.id;
  } else if (action.kind === 'repair-building') {
    if (!existing!.ruined) return failure('Building does not need repair');
    replacement = { ...existing!, ruined: false };
    cpCost = d.costs.repair[data!.tier];
    engineerRequired = true;
    targetId = `${existing!.id}:repair`;
  } else {
    if (center.ruined || existing!.ruined || !data!.active)
      return failure('Upgrade needs an active building and center');
    if (action.kind === 'upgrade') {
      if (
        action.tier !== data!.tier + 1 ||
        action.tier > d.maximumTier ||
        (data!.placement === 'center' && data!.specialty !== 'generic' && action.tier > 2)
      )
        return failure('Upgrade must advance one eligible tier');
      if (data!.placement === 'annex') {
        const reason = checkEligibility(action.tier);
        if (reason) return failure(reason);
      }
      replacement = { ...existing!, data: { ...data!, tier: action.tier } };
      cpCost = d.costs.upgrade[action.tier];
      engineerRequired = data!.placement === 'center' || d.engineerRequired;
      targetId = `${existing!.id}:tier:${action.tier}`;
    } else {
      const exclusive = action.kind === 'select-exclusive';
      const option = (exclusive ? d.exclusiveUpgrades : d.slotlessUnlocks).find(
        (o) => o.id === action.optionId,
      );
      if (
        !option ||
        (exclusive ? data!.exclusiveChoices.length > 0 : data!.unlocks.includes(action.optionId))
      )
        return failure('Upgrade option is unavailable or already selected');
      replacement = {
        ...existing!,
        data: {
          ...data!,
          exclusiveChoices: exclusive ? [option.id] : data!.exclusiveChoices,
          unlocks: exclusive ? data!.unlocks : [...data!.unlocks, option.id],
        },
      };
      cpCost = option.cpCost;
      engineerRequired = option.engineerRequired;
      targetId = `${existing!.id}:${action.kind}:${option.id}`;
    }
  }
  if (!whole(cpCost)) return failure('Definition is missing an explicit whole CP price');
  const kind =
    action.kind === 'build'
      ? 'build'
      : action.kind === 'repair-building'
        ? 'repair-building'
        : 'upgrade';
  const result = withRules(state.settings.rules, () =>
    applyFoundationWork(
      infra.capture.work,
      {
        requestId: action.requestId,
        expectedVersion: action.expectedVersion,
        ownerTurnId: action.ownerTurnId,
        team: state.active,
        kind,
        targetId,
        engineerUnitId: action.engineerUnitId,
      },
      {
        ownerTurn: { team: state.active, id: action.ownerTurnId },
        nodes: infra.capture.nodes,
        targets:
          kind === 'repair-building'
            ? [{ id: targetId, nodeId: node.id, kind, cpCost }]
            : [{ id: targetId, nodeId: node.id, kind, cpCost, engineerRequired }],
        holders: state.armies,
      },
    ),
  );
  if (!result.ok) return failure(result.reason);
  state.infrastructure = {
    ...infra,
    workRequests: [...infra.workRequests, clone(action)],
    capture: {
      ...infra.capture,
      version: result.state.version,
      work: result.state,
      nodes: infra.capture.nodes.map((n) =>
        n.id === node.id
          ? {
              ...n,
              buildings:
                action.kind === 'build'
                  ? [...n.buildings, replacement]
                  : n.buildings.map((b) => (b.id === replacement.id ? replacement : b)),
            }
          : n,
      ),
    },
  };
  state.cp = { ...result.state.commandPoints };
  return { ok: true, replayed: result.replayed, receipt: result.receipt };
}

function captureFacts(
  state: GameState,
  node: FoundationCaptureState['nodes'][number],
  event: FoundationCaptureEvent,
): FoundationCaptureFacts {
  const holders = state.armies.filter((a) => a.at === node.mainHex);
  const garrisons = holders.filter(
    (a) => a.kind === 'garrison' && a.pos === node.centerSubHex && a.team === node.owner,
  );
  const living = (u: { id: string; hp: number }): boolean => {
    if (event.kind !== 'manual-battle-end') return u.hp > 0;
    if (state.battle?.departedUnitIds?.includes(u.id)) return false;
    const deployed = state.battle?.units.find((b) => b.id === u.id);
    return deployed ? deployed.hp > 0 : u.hp > 0;
  };
  return {
    nodeId: node.id,
    liveGarrisonUnitIds: garrisons.flatMap((a) => a.units.filter(living).map((u) => u.id)),
    liveCenterOccupants:
      event.kind === 'manual-battle-end'
        ? state
            .battle!.units.filter(
              (u) =>
                u.hp > 0 &&
                u.pos === node.centerSubHex &&
                !state.battle!.departedUnitIds?.includes(u.id),
            )
            .map((u) => ({ unitId: u.id, team: u.team }))
        : holders
            .filter((a) => a.pos === node.centerSubHex)
            .flatMap((a) => a.units.filter(living).map((u) => ({ unitId: u.id, team: a.team }))),
    liveHostileMainHexUnitIds: holders
      .filter((a) => a.team !== state.active)
      .flatMap((a) => a.units.filter(living).map((u) => u.id)),
    commanders: holders
      .filter((a) => a.kind === 'commander')
      .map((a) => ({
        id: a.id,
        team: a.team,
        mainHex: a.at,
        subHex: a.pos,
        living: a.units.some(living),
      })),
  };
}

/** Derive eligibility from real holders/final BattleUnits, before tactical cleanup discards them. */
export function prepareCampaignCapture(
  state: CampaignNodeGameState,
  world: World,
  input: {
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly event: FoundationCaptureEvent;
    /** Authoritative moved-commander target scope, never client-supplied eligibility. */
    readonly nodeIds?: readonly string[];
  },
): CampaignNodeResult {
  const infra = state.infrastructure;
  if (!infra) return failure('Infrastructure is not enabled');
  const invalid = validateCampaignInfrastructure(infra, world, state.hq);
  if (invalid) return failure(invalid);
  if (
    input.nodeIds !== undefined &&
    (input.event.kind !== 'strategic-movement' ||
      !Array.isArray(input.nodeIds) ||
      !Array.from(input.nodeIds).every(id) ||
      new Set(input.nodeIds).size !== input.nodeIds.length ||
      input.nodeIds.some((key) => !infra.capture.nodes.some((node) => node.id === key)))
  ) {
    return failure('Invalid controller movement-node scope');
  }
  if (
    input.event.kind === 'manual-battle-end' &&
    (!state.battle || state.battle.id !== input.event.battleId || state.battle.phase !== 'over')
  )
    return failure('Manual capture needs the real final battle snapshot');
  const candidates = infra.capture.nodes
    .filter(
      (n) =>
        (input.nodeIds === undefined || input.nodeIds.includes(n.id)) &&
        n.owner !== null &&
        n.owner !== state.active &&
        (input.event.kind !== 'manual-battle-end' || state.battle!.mains.includes(n.mainHex)),
    )
    .map((n) => ({ node: n, facts: captureFacts(state, n, input.event) }))
    .filter(
      ({ node, facts }) =>
        facts.liveGarrisonUnitIds.length === 0 &&
        (input.event.kind === 'manual-battle-end'
          ? facts.liveCenterOccupants.some((u) => u.team === state.active) &&
            facts.liveCenterOccupants.every((u) => u.team === state.active)
          : facts.liveHostileMainHexUnitIds.length === 0 &&
            facts.commanders.some(
              (c) =>
                c.living &&
                c.team === state.active &&
                (input.event.kind === 'turn-start-after-income' || c.subHex === node.centerSubHex),
            )),
    );
  if (!candidates.length) return { ok: true, replayed: false, receipt: null };
  const result = beginFoundationCapture(
    infra.capture,
    { requestId: input.requestId, expectedVersion: input.expectedVersion },
    {
      snapshotVersion: infra.capture.version,
      ownerTurn: { team: state.active, id: infra.ownerTurns[state.active] },
      event: input.event,
      costs: infra.profile.captureCosts,
      candidates: candidates.map((c) => c.facts),
    },
  );
  if (!result.ok) return failure(result.reason);
  state.infrastructure = { ...infra, capture: result.state };
  return { ok: true, replayed: result.replayed, receipt: result.receipt };
}

export function chooseCampaignCapture(
  state: CampaignNodeGameState,
  request: FoundationCaptureChoiceRequest,
): CampaignNodeResult {
  const infra = state.infrastructure;
  if (!infra) return failure('Infrastructure is not enabled');
  const result = chooseFoundationCapture(infra.capture, request);
  if (!result.ok) return failure(result.reason);
  state.infrastructure = { ...infra, capture: result.state };
  return { ok: true, replayed: result.replayed, receipt: result.receipt };
}

/** Adopts the atomic result; the root coordinator projects claims/effects and evaluates victory. */
export function commitCampaignCapture(
  state: CampaignNodeGameState,
  request: {
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly batchId: string;
  },
): CampaignNodeResult {
  const infra = state.infrastructure;
  if (!infra) return failure('Infrastructure is not enabled');
  if (
    infra.capture.work.commandPoints.A !== state.cp.A ||
    infra.capture.work.commandPoints.B !== state.cp.B
  )
    return failure('CP snapshot changed; refresh infrastructure first');
  const result = commitFoundationCapture(infra.capture, request, {
    snapshotVersion: infra.capture.version,
    ownerTurn: { team: state.active, id: infra.ownerTurns[state.active] },
  });
  if (!result.ok) return failure(result.reason);
  state.infrastructure = { ...infra, capture: result.state };
  state.cp = { ...result.state.work.commandPoints };
  return { ok: true, replayed: result.replayed, receipt: result.receipt };
}

/** Stable UI/AI command construction does not increment nextId or mutate a preview clone. */
export function constructCampaignNodeRequest(
  state: CampaignNodeGameState,
  input: CampaignNodeActionInput,
): CampaignNodeAction {
  const infra = state.infrastructure;
  if (!infra) throw new Error('Infrastructure is not enabled');
  const target =
    input.kind === 'activate'
      ? [input.commanderId, input.centerDefinitionId]
      : input.kind === 'build'
        ? [input.definitionId, input.subHex, input.tier, input.engineerUnitId]
        : input.kind === 'upgrade'
          ? [input.buildingId, input.tier, input.engineerUnitId]
          : input.kind === 'repair-building'
            ? [input.buildingId, input.engineerUnitId]
            : [input.buildingId, input.optionId, input.engineerUnitId];
  return {
    ...input,
    requestId: `node-work:${state.nextId}:${infra.capture.version}:${JSON.stringify([input.kind, input.nodeId, target])}`,
    expectedVersion: infra.capture.version,
    ownerTurnId: infra.ownerTurns[state.active],
  } as CampaignNodeAction;
}

/** Presentation facts share the actual control projection and center operational gate. */
export function campaignNodeViews(state: CampaignNodeGameState): CampaignNodeView[] {
  const infra = state.infrastructure;
  if (!infra) return [];
  const world = buildWorld(state.settings.grid);
  if (validateCampaignInfrastructure(infra, world, state.hq)) return [];
  const control = projectGameTerritorialControl(
    state,
    world,
    infra.capture.nodes.map((node) => ({
      id: node.id,
      mainHexId: node.mainHex,
      owner: node.owner,
    })),
  );
  const tacticalRuins = new Set(state.battle?.ruinedInfrastructureBuildingIds ?? []);
  return infra.sites.map((site): CampaignNodeView => {
    const node = infra.capture.nodes.find((n) => n.id === site.nodeId)!;
    const center = node.buildings.find((b) => campaignBuildingData(b).placement === 'center')!;
    const centerData = campaignBuildingData(center);
    const centerOperational = centerData.active && !center.ruined;
    const spend = infra.capture.work.nodeSpending.find(
      (s) =>
        s.nodeId === node.id &&
        s.team === state.active &&
        s.ownerTurnId === infra.ownerTurns[state.active],
    );
    const open =
      node.owner === state.active && centerData.active && spend?.buildingWindow !== 'closed';
    const activationRepairOnly = open && spend?.activationClosed === true;
    const operationsRemaining = !open
      ? 0
      : activationRepairOnly
        ? Math.min(spend.activationRepairSpent ? 0 : 1, 2 - spend.operationCount)
        : 2 - (spend?.operationCount ?? 0);
    return {
      nodeId: node.id,
      mainHex: node.mainHex,
      centerSubHex: node.centerSubHex,
      name: site.homeTeam
        ? `${site.homeTeam === 'A' ? 'Alpha' : 'Bravo'} Home HQ`
        : definition(infra.profile, centerData.definitionId).name,
      status: !centerData.active ? 'inactive' : center.ruined ? 'ruined' : 'active',
      owner: node.owner,
      claim: control[node.mainHex].claim,
      contested: control[node.mainHex].contested,
      homeTeam: site.homeTeam,
      buildings: node.buildings.map((building) => {
        const data = campaignBuildingData(building);
        const ruined =
          building.ruined || (data.placement === 'annex' && tacticalRuins.has(building.id));
        return {
          id: building.id,
          name: definition(infra.profile, data.definitionId).name,
          subHex: data.subHex,
          tier: data.tier,
          placement: data.placement,
          ruined,
          active: data.active && !ruined && (data.placement === 'center' || centerOperational),
        };
      }),
      work: {
        ordinaryRemaining:
          open && !activationRepairOnly && !spend?.ordinarySpent && operationsRemaining > 0 ? 1 : 0,
        operationsRemaining,
        buildingWindow: open ? 'open' : 'closed',
        activationRepairOnly,
      },
    };
  });
}

/**
 * Generate requests then run the real command against an isolated clone. UI/AI consume these
 * results unchanged; there is no second legality implementation or hidden pricing in a client.
 */
export function campaignNodeActionChoices(
  state: CampaignNodeGameState,
  nodeId: string,
): CampaignNodeActionChoice[] {
  const infra = state.infrastructure;
  if (!infra) return [];
  const world = buildWorld(state.settings.grid);
  if (validateCampaignInfrastructure(infra, world, state.hq)) return [];
  const node = infra.capture.nodes.find((n) => n.id === nodeId);
  const site = infra.sites.find((s) => s.nodeId === nodeId);
  if (!node || !site) return [];
  const center = node.buildings.find((b) => campaignBuildingData(b).placement === 'center')!;
  const centerData = campaignBuildingData(center);
  const turn = infra.ownerTurns[state.active];
  const spent = infra.capture.work.nodeSpending.find(
    (s) => s.nodeId === node.id && s.team === state.active && s.ownerTurnId === turn,
  );
  const engineers = withRules(state.settings.rules, () =>
    state.armies
      .filter((h) => h.team === state.active && h.at === node.mainHex)
      .flatMap((h) =>
        h.units.filter((u) => {
          if (
            u.hp <= 0 ||
            infra.capture.work.engineerSpending.some(
              (s) => s.unitId === u.id && s.team === state.active && s.ownerTurnId === turn,
            )
          )
            return false;
          try {
            return unitType(u.typeId).engineer === true;
          } catch {
            return false;
          }
        }),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
  const engineerFor = (required: boolean): string | null =>
    required || spent?.ordinarySpent ? (engineers[0]?.id ?? null) : null;
  const choices: CampaignNodeActionChoice[] = [];
  const add = (label: string, input: CampaignNodeActionInput, cpCost: number): void => {
    const request = constructCampaignNodeRequest(state, input);
    const preview = structuredClone(state);
    const result = applyCampaignNodeAction(preview, world, request);
    const receipt = result.ok ? result.receipt : null;
    const engineerUnitId =
      receipt && 'engineerUnitId' in receipt
        ? receipt.engineerUnitId
        : !result.ok && 'engineerUnitId' in input
          ? input.engineerUnitId
          : null;
    choices.push({
      label,
      request,
      cpCost: receipt?.cpSpent ?? cpCost,
      legal: result.ok,
      reason: result.ok ? null : result.error,
      engineerUnitId,
      engineerLabel: engineerUnitId
        ? (state.armies.flatMap((h) => h.units).find((u) => u.id === engineerUnitId)?.label ??
          engineerUnitId)
        : null,
      allowance:
        receipt && 'allowance' in receipt
          ? receipt.allowance
          : result.ok && input.kind === 'activate'
            ? 'activation'
            : null,
    });
  };
  if (!centerData.active || node.owner === null) {
    const commander = state.armies
      .filter(
        (a) =>
          a.kind === 'commander' &&
          a.team === state.active &&
          a.at === node.mainHex &&
          a.units.some((u) => u.hp > 0),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    const centerIds = centerData.active
      ? [centerData.definitionId]
      : infra.profile.activationCenterDefinitionIds;
    for (const key of centerIds)
      add(
        `Activate ${definition(infra.profile, key).name}`,
        {
          kind: 'activate',
          nodeId,
          commanderId: commander?.id ?? 'missing-commander',
          centerDefinitionId: key,
        },
        infra.profile.activationCp,
      );
    return choices;
  }
  for (const building of node.buildings) {
    const data = campaignBuildingData(building);
    const d = definition(infra.profile, data.definitionId);
    if (building.ruined) {
      add(
        `Repair ${d.name}`,
        {
          kind: 'repair-building',
          nodeId,
          buildingId: building.id,
          engineerUnitId: engineers[0]?.id ?? 'missing-engineer',
        },
        d.costs.repair[data.tier]!,
      );
      continue;
    }
    const nextTier = data.tier + 1;
    if (
      nextTier <= d.maximumTier &&
      (data.placement !== 'center' || data.specialty === 'generic' || nextTier <= 2)
    ) {
      add(
        `Upgrade ${d.name} to tier ${nextTier}`,
        {
          kind: 'upgrade',
          nodeId,
          buildingId: building.id,
          tier: nextTier as BuildingTier,
          engineerUnitId: engineerFor(data.placement === 'center' || d.engineerRequired),
        },
        d.costs.upgrade[nextTier as BuildingTier]!,
      );
    }
    if (!data.exclusiveChoices.length)
      for (const option of d.exclusiveUpgrades)
        add(
          `Select ${option.id} for ${d.name}`,
          {
            kind: 'select-exclusive',
            nodeId,
            buildingId: building.id,
            optionId: option.id,
            engineerUnitId: engineerFor(option.engineerRequired),
          },
          option.cpCost,
        );
    for (const option of d.slotlessUnlocks.filter((o) => !data.unlocks.includes(o.id)))
      add(
        `Unlock ${option.id} for ${d.name}`,
        {
          kind: 'unlock',
          nodeId,
          buildingId: building.id,
          optionId: option.id,
          engineerUnitId: engineerFor(option.engineerRequired),
        },
        option.cpCost,
      );
  }
  const prerequisites = Array.from(
    new Set(
      node.buildings
        .filter((b) => !b.ruined && campaignBuildingData(b).active)
        .map((b) => campaignBuildingData(b).definitionId),
    ),
  );
  for (const subHex of site.annexSubHexes.filter(
    (key) => !node.buildings.some((b) => campaignBuildingData(b).subHex === key),
  )) {
    for (const d of infra.profile.definitions.filter((item) => item.annexEligible)) {
      const limit = evaluateBuildingEligibility({
        definition: d,
        center: { role: centerData.specialty, tier: centerData.tier },
        placement: 'annex',
        requestedTier: 1,
        availablePrerequisites: prerequisites,
      }).maximumTier;
      for (let n = 1; n <= limit; n++)
        add(
          `Build ${d.name} tier ${n} at ${subHex}`,
          {
            kind: 'build',
            nodeId,
            definitionId: d.id,
            subHex,
            tier: n as BuildingTier,
            engineerUnitId: engineerFor(d.engineerRequired),
          },
          d.costs.build[n as BuildingTier]!,
        );
    }
  }
  return choices;
}

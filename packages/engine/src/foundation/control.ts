import type { World } from '../grid.ts';
import type { HexKey } from '../hex.ts';
import type { GameState, Team } from '../types.ts';
import { calculateFoundationIncome, type FoundationIncomeContribution } from './attributes.ts';

/** Retained campaign values; node supply does not gate territorial CP. */
export const TERRITORIAL_BASE_CP_GRANT = 3;
export const TERRITORIAL_CP_PER_CLAIM = 1;

export interface TerritorialNodeFact {
  id: string;
  mainHexId: HexKey;
  owner: Team | null;
}

/** Only living units establish troop presence; empty buildings are not troops. */
export interface TerritorialHolderFact {
  id: string;
  mainHexId: HexKey;
  team: Team;
  livingUnitIds: readonly string[];
}

export interface MainHexControl {
  mainHexId: HexKey;
  nodeOwner: Team | null;
  presentTeams: Team[];
  claim: Team | null;
  contested: boolean;
}

export type TerritorialControl = Readonly<Record<HexKey, MainHexControl>>;

const TEAMS: readonly Team[] = ['A', 'B'];
const validTeam = (value: unknown): value is Team => value === 'A' || value === 'B';

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: expected an ID`);
}

function requireOwner(value: unknown): asserts value is Team | null {
  if (value !== null && !validTeam(value)) throw new Error('Invalid node owner');
}

function distinctId(value: unknown, seen: Set<string>, label: string): asserts value is string {
  requireId(value, label);
  if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
  seen.add(value);
}

function projectCell(
  mainHexId: HexKey,
  nodeOwner: Team | null,
  presence: ReadonlySet<Team>,
): MainHexControl {
  const presentTeams = TEAMS.filter((team) => presence.has(team));
  const claim = nodeOwner ?? (presentTeams.length === 1 ? presentTeams[0] : null);
  const competingTeams = new Set(presentTeams);
  if (nodeOwner !== null) competingTeams.add(nodeOwner);
  return { mainHexId, nodeOwner, presentTeams, claim, contested: competingTeams.size > 1 };
}

/**
 * Projects control from current node ownership and living troops, never old tile ownership.
 * An owned node establishes claim even while opposed. Without one, only sole troop presence
 * establishes claim. Supply connectivity and adjacency are intentionally not inputs.
 * This function does not mutate persistent control, commit capture or grant income.
 */
export function projectTerritorialControl(input: {
  mainHexIds: readonly HexKey[];
  nodes: readonly TerritorialNodeFact[];
  holders: readonly TerritorialHolderFact[];
}): TerritorialControl {
  if (
    !input ||
    !Array.isArray(input.mainHexIds) ||
    !Array.isArray(input.nodes) ||
    !Array.isArray(input.holders)
  ) {
    throw new Error('Invalid territorial facts');
  }
  const mains = new Set<string>();
  for (const key of input.mainHexIds) distinctId(key, mains, 'MainHex ID');
  const nodesByMain = new Map<string, Team | null>();
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (!node) throw new Error('Invalid node fact');
    distinctId(node.id, nodeIds, 'node ID');
    requireId(node.mainHexId, 'node MainHex');
    requireOwner(node.owner);
    if (!mains.has(node.mainHexId)) throw new Error('Node references an unknown MainHex');
    if (nodesByMain.has(node.mainHexId)) throw new Error('More than one node in a MainHex');
    nodesByMain.set(node.mainHexId, node.owner);
  }
  const holderIds = new Set<string>();
  const unitIds = new Set<string>();
  const presenceByMain = new Map<string, Set<Team>>();
  for (const holder of input.holders) {
    if (!holder) throw new Error('Invalid holder fact');
    distinctId(holder.id, holderIds, 'holder ID');
    requireId(holder.mainHexId, 'holder MainHex');
    if (!mains.has(holder.mainHexId)) throw new Error('Holder references an unknown MainHex');
    if (!validTeam(holder.team)) throw new Error('Invalid holder team');
    if (!Array.isArray(holder.livingUnitIds)) throw new Error('Invalid living unit IDs');
    for (const unitId of holder.livingUnitIds) distinctId(unitId, unitIds, 'unit ID');
    if (holder.livingUnitIds.length === 0) continue;
    const presence = presenceByMain.get(holder.mainHexId) ?? new Set<Team>();
    presence.add(holder.team);
    presenceByMain.set(holder.mainHexId, presence);
  }
  return Object.fromEntries(
    [...mains]
      .sort()
      .map((key) => [
        key,
        projectCell(key, nodesByMain.get(key) ?? null, presenceByMain.get(key) ?? new Set()),
      ]),
  );
}

/**
 * Adapter for authoritative strategic holders. Explicit node facts remain separate from
 * legacy state.hexes.owner. Dead units and empty garrisons do not establish presence.
 */
export function projectGameTerritorialControl(
  state: Pick<GameState, 'armies'>,
  world: Pick<World, 'mains' | 'subByKey'>,
  nodes: readonly TerritorialNodeFact[],
): TerritorialControl {
  if (!state || !Array.isArray(state.armies)) throw new Error('Invalid strategic holders');
  if (!world || !Array.isArray(world.mains) || !(world.subByKey instanceof Map))
    throw new Error('Invalid control world');
  const allUnitIds = new Set<string>();
  const holders: TerritorialHolderFact[] = state.armies.map((holder) => {
    if (!holder || !Array.isArray(holder.units)) throw new Error('Invalid strategic holder');
    requireId(holder.pos, 'holder SubHex');
    const cell = world.subByKey.get(holder.pos);
    if (!cell || cell.main !== holder.at) throw new Error('Holder position/MainHex mismatch');
    if (holder.kind !== 'commander' && holder.kind !== 'garrison')
      throw new Error('Invalid holder kind');
    const livingUnitIds: string[] = [];
    for (const unit of holder.units) {
      if (!unit) throw new Error('Invalid strategic unit');
      distinctId(unit.id, allUnitIds, 'unit ID');
      if (typeof unit.hp !== 'number' || !Number.isFinite(unit.hp) || unit.hp < 0)
        throw new Error('Invalid unit HP');
      if (unit.hp > 0) livingUnitIds.push(unit.id);
    }
    return { id: holder.id, mainHexId: holder.at, team: holder.team, livingUnitIds };
  });
  return projectTerritorialControl({
    mainHexIds: world.mains.map((main) => main.key),
    nodes,
    holders,
  });
}

/** Shared claim count for territory income, scoring and territory-based elimination. */
export function territorialClaimCounts(control: TerritorialControl): {
  A: number;
  B: number;
  unclaimed: number;
} {
  if (!control || typeof control !== 'object' || Array.isArray(control))
    throw new Error('Invalid territorial projection');
  const counts = { A: 0, B: 0, unclaimed: 0 };
  for (const [key, cell] of Object.entries(control)) {
    requireId(key, 'MainHex ID');
    if (!cell || cell.mainHexId !== key || !Array.isArray(cell.presentTeams))
      throw new Error('Invalid MainHex control');
    requireOwner(cell.nodeOwner);
    const presence = new Set<Team>();
    for (const team of cell.presentTeams) {
      if (!validTeam(team) || presence.has(team)) throw new Error('Invalid presence teams');
      presence.add(team);
    }
    const expected = projectCell(key, cell.nodeOwner, presence);
    if (cell.claim !== expected.claim || cell.contested !== expected.contested)
      throw new Error('Control projection does not match node ownership and presence');
    const countKey = expected.claim ?? 'unclaimed';
    const count = counts[countKey] + 1;
    if (!Number.isSafeInteger(count)) throw new Error('Territorial count exceeds safe range');
    counts[countKey] = count;
  }
  return counts;
}

/** Retained 1 CP per claimed MainHex, including contested tiles with an owned node. */
export function territoryIncome(control: TerritorialControl, team: Team): number {
  if (!validTeam(team)) throw new Error('Invalid income team');
  return territorialClaimCounts(control)[team] * TERRITORIAL_CP_PER_CLAIM;
}

/**
 * Payment projection only. Building values are already modified/qualified by their evaluator;
 * exact decimal tokens pass through to the one aggregate floor. No supply rule gates territory.
 * Event timing, receipts and CP mutation belong to the campaign controller.
 */
export function calculateTerritorialIncome(
  control: TerritorialControl,
  team: Team,
  buildingContributions: readonly Omit<FoundationIncomeContribution, 'kind'>[] = [],
): ReturnType<typeof calculateFoundationIncome> {
  territoryIncome(control, team); // Validate the same projection consumed by scoring.
  if (!Array.isArray(buildingContributions)) throw new Error('Invalid building income');
  return calculateFoundationIncome({
    baseGrant: TERRITORIAL_BASE_CP_GRANT,
    contributions: [
      ...Object.values(control)
        .filter((cell) => cell.claim === team)
        .map((cell) => ({
          sourceId: `territory/${cell.mainHexId}`,
          kind: 'territory' as const,
          value: TERRITORIAL_CP_PER_CLAIM,
          active: true,
          eligible: true,
        })),
      ...buildingContributions.map((contribution) => ({
        ...contribution,
        kind: 'building' as const,
      })),
    ],
  });
}

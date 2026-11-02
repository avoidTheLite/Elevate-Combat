import { hexDistance, hexKey, neighbor, parseKey } from '../hex.ts';
import type { Team } from '../types.ts';
import {
  addFoundationAmounts,
  compareFoundationAmounts,
  foundationAmountNumber,
  foundationExactAmount,
  maxFoundationAmounts,
  multiplyFoundationAmounts,
  powerFoundationAmount,
  subtractFoundationAmounts,
} from './attributes.ts';
import type { FoundationAmount, FoundationExactAmount } from './attributes.ts';

export interface SupplyCell {
  readonly key: string;
  readonly mainHex: string;
  readonly height: number;
  readonly terrain: string;
}

export interface SupplyConnector {
  readonly id: string;
  readonly subHex: string;
  readonly owner: Team | null;
  readonly operational: boolean;
  /** Added to the base outgoing per-leg range only after reaching this connector. */
  readonly relayRangeBonus: FoundationAmount;
  readonly authority: 'home' | 'regional' | null;
}

export interface SupplyRoadSection {
  readonly id: string;
  readonly mainHex: string;
  readonly path: readonly string[];
  readonly damaged: boolean;
}

export interface SupplyBlocker {
  readonly unitId: string;
  readonly team: Team;
  readonly subHex: string;
}

/** Required explicit data; no production prices, ranges or modifiers are inferred. */
export interface SupplyProfile {
  readonly terrainCosts: Readonly<Record<string, number>>;
  readonly minimumStepCost: number;
  readonly uphillSurcharge: number;
  readonly downhillCredit: number;
  readonly maximumClimb: number;
  readonly maximumDrop: number;
  readonly roadMultiplier: number;
  readonly legRange: number;
  readonly distanceFloor: number;
  readonly distanceDecay: number;
  readonly hostileClaimFactor: number;
}

export interface SupplyLeg {
  readonly fromConnector: string;
  readonly toConnector: string;
  readonly path: readonly string[];
  readonly weightedCost: number;
  readonly exactWeightedCost: FoundationExactAmount;
  readonly rangeBudget: number;
  readonly exactRangeBudget: FoundationExactAmount;
  readonly enabledRelayIds: readonly string[];
}

export interface SupplyRoute {
  readonly authorityId: string;
  readonly path: readonly string[];
  readonly weightedCost: number;
  readonly exactWeightedCost: FoundationExactAmount;
  readonly hostileMainHexes: readonly string[];
  readonly distanceEfficiency: number;
  readonly exactDistanceEfficiency: FoundationExactAmount;
  readonly effectiveEfficiency: number;
  readonly exactEffectiveEfficiency: FoundationExactAmount;
  readonly legs: readonly SupplyLeg[];
}

export interface SupplyNodeEvaluation {
  readonly nodeId: string;
  readonly islandId: string | null;
  readonly homeConnected: boolean;
  readonly connection: 'home' | 'regional' | 'none';
  readonly activeRoute: SupplyRoute | null;
  readonly routes: readonly SupplyRoute[];
}

export interface SupplyIsland {
  readonly id: string;
  readonly nodeIds: readonly string[];
  readonly authorityIds: readonly string[];
}

export interface SupplyGraphInput {
  readonly cells: readonly SupplyCell[];
  readonly connectors: readonly SupplyConnector[];
  readonly roads: readonly SupplyRoadSection[];
  readonly blockers: readonly SupplyBlocker[];
  readonly claims: Readonly<Record<string, Team | null>>;
  readonly profile: SupplyProfile;
  readonly team: Team;
}

export interface SupplyGraphEvaluation {
  readonly team: Team;
  readonly nodes: Readonly<Record<string, SupplyNodeEvaluation>>;
  readonly islands: readonly SupplyIsland[];
  /** Directed legal links; components use their underlying undirected connectivity. */
  readonly links: readonly { readonly from: string; readonly to: string }[];
  readonly blockedCells: readonly string[];
}

const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const teamValid = (team: unknown): team is Team => team === 'A' || team === 'B';
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a nonempty supply ID');
}
function finite(value: number, positive = false): void {
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0))
    throw new Error('Supply values must be finite and nonnegative, with positive costs/ranges');
}
function coordinate(key: string): void {
  id(key);
  const h = parseKey(key);
  if (!Number.isSafeInteger(h.q) || !Number.isSafeInteger(h.r) || hexKey(h) !== key)
    throw new Error('Supply SubHex must use canonical safe integer axial coordinates');
}
function compareCell(a: string, b: string): number {
  const ah = parseKey(a);
  const bh = parseKey(b);
  return ah.q - bh.q || ah.r - bh.r;
}
export function compareSupplyPaths(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const comparison = compareCell(a[i], b[i]);
    if (comparison) return comparison;
  }
  return a.length - b.length;
}
export function compareSupplyRoutes(a: SupplyRoute, b: SupplyRoute): number {
  return (
    b.effectiveEfficiency - a.effectiveEfficiency ||
    compareFoundationAmounts(b.exactEffectiveEfficiency, a.exactEffectiveEfficiency) ||
    a.weightedCost - b.weightedCost ||
    compareFoundationAmounts(a.exactWeightedCost, b.exactWeightedCost) ||
    a.hostileMainHexes.length - b.hostileMainHexes.length ||
    compareSupplyPaths(a.path, b.path) ||
    lexical(a.authorityId, b.authorityId)
  );
}

export function validateSupplyProfile(profile: SupplyProfile): void {
  if (!profile || !profile.terrainCosts || !Object.keys(profile.terrainCosts).length)
    throw new Error('Supply terrain costs are required');
  for (const [terrain, cost] of Object.entries(profile.terrainCosts)) {
    id(terrain);
    finite(cost, true);
  }
  finite(profile.minimumStepCost, true);
  finite(profile.uphillSurcharge);
  finite(profile.downhillCredit);
  if (profile.uphillSurcharge <= profile.downhillCredit)
    throw new Error('Supply uphill surcharge must exceed downhill credit');
  finite(profile.maximumClimb);
  finite(profile.maximumDrop);
  finite(profile.roadMultiplier, true);
  finite(profile.legRange, true);
  finite(profile.distanceDecay);
  for (const factor of [profile.distanceFloor, profile.hostileClaimFactor]) {
    finite(factor);
    if (factor > 1) throw new Error('Supply factors must be at most one');
  }
  if (profile.roadMultiplier > 1) throw new Error('Roads must not increase supply cost');
}

/** Mirrors movement's climb/drop and destination-marsh conventions using an explicit profile. */
export function supplyStepCost(
  from: SupplyCell,
  to: SupplyCell,
  profile: SupplyProfile,
  operationalRoad: boolean,
): number | null {
  const cost = exactSupplyStepCost(from, to, profile, operationalRoad);
  return cost === null ? null : foundationAmountNumber(cost);
}

export function exactSupplyStepCost(
  from: SupplyCell,
  to: SupplyCell,
  profile: SupplyProfile,
  operationalRoad: boolean,
): FoundationExactAmount | null {
  const climb = to.height - from.height;
  if (climb > profile.maximumClimb || -climb > profile.maximumDrop) return null;
  const terrainCost = profile.terrainCosts[to.terrain];
  if (terrainCost === undefined) throw new Error(`Missing supply terrain cost: ${to.terrain}`);
  const raw = subtractFoundationAmounts(
    addFoundationAmounts(
      terrainCost,
      multiplyFoundationAmounts(Math.max(0, climb), profile.uphillSurcharge),
    ),
    multiplyFoundationAmounts(Math.max(0, -climb), profile.downhillCredit),
  );
  const cost = maxFoundationAmounts(
    profile.minimumStepCost,
    multiplyFoundationAmounts(raw, operationalRoad ? profile.roadMultiplier : 1),
  );
  finite(foundationAmountNumber(cost), true);
  return cost;
}

interface Prepared {
  cells: Map<string, SupplyCell>;
  connectors: SupplyConnector[];
  byCell: Map<string, SupplyConnector>;
  adjacent: Map<string, { key: string; cost: number; exactCost: FoundationExactAmount }[]>;
  blocked: Set<string>;
  hostileMain: (key: string) => string | null;
}
const edgeKey = (a: string, b: string): string => JSON.stringify([a, b].sort(compareCell));
function prepare(input: SupplyGraphInput): Prepared {
  if (!input || !teamValid(input.team)) throw new Error('Invalid supply team');
  validateSupplyProfile(input.profile);
  const cells = new Map<string, SupplyCell>();
  for (const cell of input.cells) {
    coordinate(cell.key);
    id(cell.mainHex);
    id(cell.terrain);
    if (!Number.isSafeInteger(cell.height) || cell.height < 0)
      throw new Error('Invalid supply height');
    if (cells.has(cell.key)) throw new Error('Duplicate supply cell');
    if (!Object.hasOwn(input.claims, cell.mainHex)) throw new Error('Missing territorial claim');
    const claim = input.claims[cell.mainHex];
    if (claim !== null && !teamValid(claim)) throw new Error('Invalid territorial claim');
    if (!Object.hasOwn(input.profile.terrainCosts, cell.terrain))
      throw new Error('Unknown supply terrain');
    cells.set(cell.key, cell);
  }
  const connectorIds = new Set<string>();
  const connectorCells = new Set<string>();
  for (const connector of input.connectors) {
    id(connector.id);
    if (connectorIds.has(connector.id) || connectorCells.has(connector.subHex))
      throw new Error('Duplicate supply connector ID or position');
    connectorIds.add(connector.id);
    connectorCells.add(connector.subHex);
    if (!cells.has(connector.subHex)) throw new Error('Supply connector is outside the graph');
    if (connector.owner !== null && !teamValid(connector.owner))
      throw new Error('Invalid connector owner');
    if (typeof connector.operational !== 'boolean')
      throw new Error('Invalid connector operational state');
    if (![null, 'home', 'regional'].includes(connector.authority))
      throw new Error('Invalid supply authority');
    if (compareFoundationAmounts(connector.relayRangeBonus, 0) < 0)
      throw new Error('Relay range bonus must be nonnegative');
    finite(
      foundationAmountNumber(
        addFoundationAmounts(input.profile.legRange, connector.relayRangeBonus),
      ),
      true,
    );
  }
  const blockerIds = new Set<string>();
  const blocked = new Set<string>();
  for (const blocker of input.blockers) {
    id(blocker.unitId);
    if (blockerIds.has(blocker.unitId)) throw new Error('Duplicate supply blocker unit');
    blockerIds.add(blocker.unitId);
    if (!teamValid(blocker.team) || !cells.has(blocker.subHex))
      throw new Error('Invalid physical blocker');
    if (blocker.team !== input.team) blocked.add(blocker.subHex);
  }
  const roadIds = new Set<string>();
  const roads = new Map<string, boolean>();
  for (const section of input.roads) {
    id(section.id);
    if (roadIds.has(section.id)) throw new Error('Duplicate road section');
    roadIds.add(section.id);
    if (typeof section.damaged !== 'boolean' || section.path.length === 0)
      throw new Error('Invalid road section');
    const seen = new Set<string>();
    section.path.forEach((key, index) => {
      const cell = cells.get(key);
      if (!cell || cell.mainHex !== section.mainHex || seen.has(key))
        throw new Error('Road must be a simple MainHex-local path');
      seen.add(key);
      if (index === 0) return;
      const previous = section.path[index - 1];
      if (hexDistance(parseKey(previous), parseKey(key)) !== 1)
        throw new Error('Road cells must be face adjacent');
      const edge = edgeKey(previous, key);
      if (roads.has(edge)) throw new Error('Ambiguous overlapping road edge');
      roads.set(edge, !section.damaged);
    });
  }
  const connectors = input.connectors
    .filter(
      (connector) =>
        connector.owner === input.team && connector.operational && !blocked.has(connector.subHex),
    )
    .sort((a, b) => lexical(a.id, b.id));
  const byCell = new Map(connectors.map((connector) => [connector.subHex, connector]));
  const adjacent = new Map<
    string,
    { key: string; cost: number; exactCost: FoundationExactAmount }[]
  >();
  const stepCosts = new Map<string, { cost: number; exactCost: FoundationExactAmount } | null>();
  for (const cell of cells.values()) {
    if (blocked.has(cell.key)) continue;
    const edges: { key: string; cost: number; exactCost: FoundationExactAmount }[] = [];
    for (let d = 0; d < 6; d++) {
      const key = hexKey(neighbor(parseKey(cell.key), d));
      const destination = cells.get(key);
      if (!destination || blocked.has(key)) continue;
      const road = roads.get(edgeKey(cell.key, key)) === true;
      const costKey = JSON.stringify([cell.height, destination.height, destination.terrain, road]);
      if (!stepCosts.has(costKey)) {
        const exactCost = exactSupplyStepCost(cell, destination, input.profile, road);
        stepCosts.set(
          costKey,
          exactCost === null ? null : { exactCost, cost: foundationAmountNumber(exactCost) },
        );
      }
      const cost = stepCosts.get(costKey);
      if (cost) edges.push({ key, ...cost });
    }
    adjacent.set(
      cell.key,
      edges.sort((a, b) => compareCell(a.key, b.key)),
    );
  }
  return {
    cells,
    connectors,
    byCell,
    adjacent,
    blocked,
    hostileMain: (key) => {
      const main = cells.get(key)!.mainHex;
      const claim = input.claims[main];
      return claim !== null && claim !== input.team ? main : null;
    },
  };
}

/** Validate geometry/profile/facts and adjacency without searching routes or issuing rewards. */
export function validateSupplyGraphInput(input: SupplyGraphInput): void {
  prepare(input);
}

interface Label {
  key: string;
  cost: number;
  exactCost: FoundationExactAmount;
  hostile: Set<string>;
  path: string[];
}
function dominates(a: Label, b: Label): boolean {
  const costOrder = a.cost - b.cost || compareFoundationAmounts(a.exactCost, b.exactCost);
  if (costOrder > 0 || [...a.hostile].some((key) => !b.hostile.has(key))) return false;
  return (
    costOrder < 0 || a.hostile.size < b.hostile.size || compareSupplyPaths(a.path, b.path) <= 0
  );
}

/** A binary heap avoids re-sorting every cell frontier after every single expansion. */
class Frontier<T extends Label> {
  private readonly values: T[] = [];
  get length(): number {
    return this.values.length;
  }
  private compare(a: T, b: T): number {
    return (
      a.cost - b.cost ||
      compareFoundationAmounts(a.exactCost, b.exactCost) ||
      compareSupplyPaths(a.path, b.path)
    );
  }
  push(value: T): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[parent], this.values[index]) <= 0) break;
      [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
      index = parent;
    }
  }
  pop(): T {
    const first = this.values[0];
    const last = this.values.pop()!;
    if (!this.values.length) return first;
    this.values[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.values.length && this.compare(this.values[left], this.values[smallest]) < 0)
        smallest = left;
      if (right < this.values.length && this.compare(this.values[right], this.values[smallest]) < 0)
        smallest = right;
      if (smallest === index) break;
      [this.values[index], this.values[smallest]] = [this.values[smallest], this.values[index]];
      index = smallest;
    }
    return first;
  }
}

interface LegCandidate {
  leg: SupplyLeg;
  hostile: ReadonlySet<string>;
}
type LegGraph = Map<string, Map<string, LegCandidate[]>>;
type CostAddition = (
  a: FoundationExactAmount,
  b: FoundationExactAmount,
) => { cost: number; exactCost: FoundationExactAmount };
function costAdder(): CostAddition {
  const sums = new Map<string, { cost: number; exactCost: FoundationExactAmount }>();
  return (a, b) => {
    const key = `${a.decimal}|${b.decimal}`;
    let result = sums.get(key);
    if (!result) {
      const exactCost = addFoundationAmounts(a, b);
      result = { cost: foundationAmountNumber(exactCost), exactCost };
      sums.set(key, result);
    }
    return result;
  };
}

/**
 * Cache the exact Pareto frontier for each bounded leg once, across ALL authorities.
 * A lower-cost leg with a subset of hostile MainHexes dominates for every continuation.
 * Passing another connector does not force a reset; that complete leg remains a candidate.
 */
function legFrontiers(graph: Prepared, profile: SupplyProfile, addCost: CostAddition): LegGraph {
  return new Map(
    graph.connectors.map((source) => {
      const exactBudget = addFoundationAmounts(profile.legRange, source.relayRangeBonus);
      const budget = foundationAmountNumber(exactBudget);
      const firstHostile = graph.hostileMain(source.subHex);
      const initial: Label = {
        key: source.subHex,
        cost: 0,
        exactCost: foundationExactAmount(0),
        hostile: new Set(firstHostile ? [firstHostile] : []),
        path: [source.subHex],
      };
      const labels = new Map<string, Label[]>([[source.subHex, [initial]]]);
      const frontier = new Frontier<Label>();
      frontier.push(initial);
      while (frontier.length) {
        const current = frontier.pop();
        if (!labels.get(current.key)!.includes(current)) continue;
        for (const edge of graph.adjacent.get(current.key) ?? []) {
          const { exactCost, cost } = addCost(current.exactCost, edge.exactCost);
          if (
            cost > budget ||
            (cost === budget && compareFoundationAmounts(exactCost, exactBudget) > 0)
          )
            continue;
          const hostile = new Set(current.hostile);
          const main = graph.hostileMain(edge.key);
          if (main !== null) hostile.add(main);
          const next: Label = {
            key: edge.key,
            cost,
            exactCost,
            hostile,
            path: [...current.path, edge.key],
          };
          const at = labels.get(next.key) ?? [];
          if (at.some((previous) => dominates(previous, next))) continue;
          labels.set(next.key, [...at.filter((previous) => !dominates(next, previous)), next]);
          frontier.push(next);
        }
      }
      const destinations = new Map<string, LegCandidate[]>();
      for (const target of graph.connectors) {
        if (target.id === source.id) continue;
        const paths = labels.get(target.subHex);
        if (paths)
          destinations.set(
            target.id,
            paths.map((path) => ({
              hostile: path.hostile,
              leg: {
                fromConnector: source.id,
                toConnector: target.id,
                path: path.path,
                weightedCost: path.cost,
                exactWeightedCost: path.exactCost,
                rangeBudget: budget,
                exactRangeBudget: exactBudget,
                enabledRelayIds:
                  compareFoundationAmounts(source.relayRangeBonus, 0) > 0 ? [source.id] : [],
              },
            })),
          );
      }
      return [source.id, destinations];
    }),
  );
}

interface RouteLabel extends Label {
  legs: SupplyLeg[];
}
function route(label: RouteLabel, source: SupplyConnector, profile: SupplyProfile): SupplyRoute {
  const exactDistanceEfficiency = maxFoundationAmounts(
    profile.distanceFloor,
    subtractFoundationAmounts(1, multiplyFoundationAmounts(profile.distanceDecay, label.exactCost)),
  );
  const exactEffectiveEfficiency = multiplyFoundationAmounts(
    exactDistanceEfficiency,
    powerFoundationAmount(profile.hostileClaimFactor, label.hostile.size),
  );
  const distanceEfficiency = foundationAmountNumber(exactDistanceEfficiency);
  const effectiveEfficiency = foundationAmountNumber(exactEffectiveEfficiency);
  return {
    authorityId: source.id,
    path: label.path,
    weightedCost: label.cost,
    exactWeightedCost: label.exactCost,
    hostileMainHexes: [...label.hostile].sort(lexical),
    distanceEfficiency,
    exactDistanceEfficiency,
    effectiveEfficiency,
    exactEffectiveEfficiency,
    legs: label.legs.length
      ? label.legs
      : [
          {
            fromConnector: source.id,
            toConnector: source.id,
            path: [source.subHex],
            weightedCost: 0,
            exactWeightedCost: foundationExactAmount(0),
            rangeBudget: foundationAmountNumber(
              addFoundationAmounts(profile.legRange, source.relayRangeBonus),
            ),
            exactRangeBudget: addFoundationAmounts(profile.legRange, source.relayRangeBonus),
            enabledRelayIds:
              compareFoundationAmounts(source.relayRangeBonus, 0) > 0 ? [source.id] : [],
          },
        ],
  };
}

/** Compose exact legal leg frontiers; unreachable relays never receive an initial label. */
function routesFrom(
  source: SupplyConnector,
  graph: Prepared,
  profile: SupplyProfile,
  legs: LegGraph,
  addCost: CostAddition,
): Map<string, SupplyRoute> {
  const initialHostile = graph.hostileMain(source.subHex);
  const initial: RouteLabel = {
    key: source.id,
    cost: 0,
    exactCost: foundationExactAmount(0),
    hostile: new Set(initialHostile ? [initialHostile] : []),
    path: [source.subHex],
    legs: [],
  };
  const labels = new Map<string, RouteLabel[]>([[source.id, [initial]]]);
  const frontier = new Frontier<RouteLabel>();
  frontier.push(initial);
  const best = new Map<string, SupplyRoute>();
  while (frontier.length) {
    const current = frontier.pop();
    if (!labels.get(current.key)!.includes(current)) continue;
    const candidate = route(current, source, profile);
    const previous = best.get(current.key);
    if (!previous || compareSupplyRoutes(candidate, previous) < 0) best.set(current.key, candidate);
    for (const [targetId, paths] of legs.get(current.key)!)
      for (const path of paths) {
        const { exactCost, cost } = addCost(current.exactCost, path.leg.exactWeightedCost);
        const next: RouteLabel = {
          key: targetId,
          cost,
          exactCost,
          path: [...current.path, ...path.leg.path.slice(1)],
          hostile: new Set([...current.hostile, ...path.hostile]),
          legs: [...current.legs, path.leg],
        };
        finite(next.cost);
        const at = labels.get(next.key) ?? [];
        if (at.some((previous) => dominates(previous, next))) continue;
        labels.set(next.key, [...at.filter((previous) => !dominates(next, previous)), next]);
        frontier.push(next);
      }
  }
  return best;
}

/** GAMES-ELEVATE-CAMPAIGN-UC-001/002: derive routes and legal-link islands without issuing rewards. */
export function evaluateSupplyGraph(input: SupplyGraphInput): SupplyGraphEvaluation {
  const graph = prepare(input);
  const authorities = graph.connectors.filter((connector) => connector.authority !== null);
  const addCost = costAdder();
  const legs = legFrontiers(graph, input.profile, addCost);
  const byAuthority = new Map(
    authorities.map((authority) => [
      authority.id,
      routesFrom(authority, graph, input.profile, legs, addCost),
    ]),
  );
  const links = [...legs].flatMap(([from, destinations]) =>
    [...destinations.keys()].map((to) => ({ from, to })),
  );
  const neighbors = new Map(graph.connectors.map((connector) => [connector.id, new Set<string>()]));
  for (const link of links) {
    neighbors.get(link.from)!.add(link.to);
    neighbors.get(link.to)!.add(link.from);
  }
  const islands: SupplyIsland[] = [];
  const membership = new Map<string, string>();
  for (const connector of graph.connectors) {
    if (membership.has(connector.id)) continue;
    const component = new Set([connector.id]);
    const queue = [connector.id];
    while (queue.length) {
      for (const next of neighbors.get(queue.shift()!)!) {
        if (!component.has(next)) {
          component.add(next);
          queue.push(next);
        }
      }
    }
    const nodeIds = [...component].sort(lexical);
    const islandId = JSON.stringify([input.team, nodeIds]);
    for (const nodeId of nodeIds) membership.set(nodeId, islandId);
    islands.push({
      id: islandId,
      nodeIds,
      authorityIds: authorities
        .filter((authority) => component.has(authority.id))
        .map((authority) => authority.id),
    });
  }
  const nodes = Object.fromEntries(
    input.connectors.map((connector) => {
      const routes = authorities
        .flatMap((authority) => {
          const found = byAuthority.get(authority.id)!.get(connector.id);
          return found ? [found] : [];
        })
        .sort(compareSupplyRoutes);
      const homeConnected = routes.some(
        (candidate) =>
          authorities.find((authority) => authority.id === candidate.authorityId)!.authority ===
          'home',
      );
      return [
        connector.id,
        {
          nodeId: connector.id,
          islandId: membership.get(connector.id) ?? null,
          homeConnected,
          connection: homeConnected ? 'home' : routes.length ? 'regional' : 'none',
          activeRoute: routes[0] ?? null,
          routes,
        } satisfies SupplyNodeEvaluation,
      ];
    }),
  );
  return {
    team: input.team,
    nodes,
    islands,
    links,
    blockedCells: [...graph.blocked].sort(compareCell),
  };
}

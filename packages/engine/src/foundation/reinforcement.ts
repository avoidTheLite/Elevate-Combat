import type { Team } from '../types.ts';

export interface ReinforcementGrant {
  readonly lineageId: string;
  readonly capacity: number;
  readonly spent: number;
}

export interface ReinforcementCycle {
  readonly team: Team;
  readonly ownerTurnId: string;
  readonly openedVersion: number;
  readonly grants: readonly ReinforcementGrant[];
}

export interface ReinforcementSpendRequest {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly team: Team;
  readonly ownerTurnId: string;
  readonly networkId: string;
  readonly units: number;
}

export interface ReinforcementReceipt {
  readonly request: ReinforcementSpendRequest;
  readonly resultingVersion: number;
  readonly lineageId: string;
  readonly networkRemainingBefore: number;
  readonly networkRemainingAfter: number;
}

/** The same shared state must survive graph splits, reconnection and save/load. */
export interface ReinforcementState {
  readonly version: number;
  readonly cycles: readonly ReinforcementCycle[];
  readonly receipts: readonly ReinforcementReceipt[];
}

export interface OpenReinforcementCycleRequest {
  readonly expectedVersion: number;
  readonly team: Team;
  readonly ownerTurnId: string;
  readonly grants: readonly {
    readonly lineageId: string;
    readonly capacity: number;
  }[];
}

/**
 * Trusted engine/controller snapshot, never facts supplied by a client action.
 * currentRemaining already accounts for applicable current-network spending/capacity.
 * The controller owns topology and receipt-to-current-component attribution. A network is
 * bound to one origin here; merging independent origins is deliberately not implemented.
 */
export interface ReinforcementContext {
  readonly snapshotVersion: number;
  readonly ownerTurn: { readonly team: Team; readonly id: string };
  readonly networks: readonly {
    readonly networkId: string;
    readonly lineageId: string;
    readonly currentRemaining: number;
  }[];
}

export type ReinforcementError =
  | 'invalid-state'
  | 'invalid-request'
  | 'invalid-context'
  | 'stale-version'
  | 'cycle-already-open'
  | 'cycle-not-open'
  | 'unknown-network'
  | 'unfunded-lineage'
  | 'request-conflict'
  | 'insufficient-allowance';

type Failure = { readonly ok: false; readonly code: ReinforcementError; readonly reason: string };

export type ReinforcementAllowance =
  | Failure
  | {
      readonly ok: true;
      readonly lineageId: string;
      readonly lineageRemaining: number;
      readonly networkRemaining: number;
      readonly available: number;
    };

export type OpenReinforcementCycleResult =
  | (Failure & { readonly state: ReinforcementState })
  | { readonly ok: true; readonly state: ReinforcementState };

export type ReinforcementSpendResult =
  | (Failure & { readonly state: ReinforcementState })
  | {
      readonly ok: true;
      readonly state: ReinforcementState;
      readonly replayed: boolean;
      readonly receipt: ReinforcementReceipt;
    };

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const validTeam = (value: unknown): value is Team => value === 'A' || value === 'B';
const validCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const cycleKey = (team: Team, ownerTurnId: string): string => JSON.stringify([team, ownerTurnId]);
const grantKey = (team: Team, ownerTurnId: string, lineageId: string): string =>
  JSON.stringify([team, ownerTurnId, lineageId]);

function requestValid(request: ReinforcementSpendRequest): boolean {
  return !!(
    request &&
    validId(request.requestId) &&
    validCount(request.expectedVersion) &&
    validTeam(request.team) &&
    validId(request.ownerTurnId) &&
    validId(request.networkId) &&
    validCount(request.units) &&
    request.units > 0
  );
}

function requestKey(request: ReinforcementSpendRequest): string {
  return JSON.stringify([
    request.requestId,
    request.expectedVersion,
    request.team,
    request.ownerTurnId,
    request.networkId,
    request.units,
  ]);
}

function fail(code: ReinforcementError, reason: string): Failure {
  return { ok: false, code, reason };
}

/** A fresh history only. Existing games must retain their prior state when opening a new cycle. */
export function createReinforcementState(): ReinforcementState {
  return { version: 0, cycles: [], receipts: [] };
}

/** Validates counters against every unique debit; never repairs, duplicates or resets a budget. */
export function validateReinforcementState(state: ReinforcementState): string | null {
  if (
    !state ||
    !validCount(state.version) ||
    !Array.isArray(state.cycles) ||
    !Array.isArray(state.receipts)
  ) {
    return 'Invalid reinforcement state';
  }
  const cycles = new Map<string, ReinforcementCycle>();
  const grants = new Map<string, ReinforcementGrant>();
  const versions = new Set<number>();
  for (const cycle of state.cycles) {
    if (
      !cycle ||
      !validTeam(cycle.team) ||
      !validId(cycle.ownerTurnId) ||
      !validCount(cycle.openedVersion) ||
      cycle.openedVersion === 0 ||
      cycle.openedVersion > state.version ||
      !Array.isArray(cycle.grants)
    ) {
      return 'Invalid reinforcement cycle';
    }
    const key = cycleKey(cycle.team, cycle.ownerTurnId);
    if (cycles.has(key)) return 'Duplicate reinforcement cycle';
    cycles.set(key, cycle);
    if (versions.has(cycle.openedVersion)) return 'Duplicate reinforcement version';
    versions.add(cycle.openedVersion);
    for (const grant of cycle.grants) {
      if (
        !grant ||
        !validId(grant.lineageId) ||
        !validCount(grant.capacity) ||
        !validCount(grant.spent) ||
        grant.spent > grant.capacity
      ) {
        return 'Invalid frozen reinforcement grant';
      }
      const key = grantKey(cycle.team, cycle.ownerTurnId, grant.lineageId);
      if (grants.has(key)) return 'Duplicate lineage grant';
      grants.set(key, grant);
    }
  }
  const requestIds = new Set<string>();
  const spending = new Map<string, number>();
  for (const receipt of state.receipts) {
    if (
      !receipt ||
      !requestValid(receipt.request) ||
      !validCount(receipt.resultingVersion) ||
      receipt.resultingVersion !== receipt.request.expectedVersion + 1 ||
      receipt.resultingVersion > state.version ||
      !validId(receipt.lineageId) ||
      !validCount(receipt.networkRemainingBefore) ||
      !validCount(receipt.networkRemainingAfter) ||
      receipt.networkRemainingBefore - receipt.request.units !== receipt.networkRemainingAfter
    ) {
      return 'Invalid reinforcement receipt';
    }
    if (requestIds.has(receipt.request.requestId)) return 'Duplicate reinforcement request';
    requestIds.add(receipt.request.requestId);
    if (versions.has(receipt.resultingVersion)) return 'Duplicate reinforcement version';
    versions.add(receipt.resultingVersion);
    const { team, ownerTurnId, units } = receipt.request;
    const cycle = cycles.get(cycleKey(team, ownerTurnId));
    const key = grantKey(team, ownerTurnId, receipt.lineageId);
    const grant = grants.get(key);
    const spent = (spending.get(key) ?? 0) + units;
    if (
      !cycle ||
      cycle.openedVersion >= receipt.resultingVersion ||
      !grant ||
      !validCount(spent) ||
      spent > grant.capacity
    ) {
      return 'Reinforcement receipt has no valid frozen grant';
    }
    spending.set(key, spent);
  }
  for (const [key, grant] of grants) {
    if (grant.spent !== (spending.get(key) ?? 0))
      return 'Lineage spending differs from its receipts';
  }
  return null;
}

/**
 * Explicit controller operation, with no turn scheduling. Opens all grants once for a token,
 * retaining history. Even an empty opening prevents a later HQ from adding a mid-cycle grant.
 * Capacity is whole nonnegative safe-integer units; this API never rounds or increases it.
 */
export function openReinforcementCycle(
  state: ReinforcementState,
  request: OpenReinforcementCycleRequest,
): OpenReinforcementCycleResult {
  const invalid = validateReinforcementState(state);
  if (invalid) return { ...fail('invalid-state', invalid), state };
  if (
    !request ||
    !validCount(request.expectedVersion) ||
    !validTeam(request.team) ||
    !validId(request.ownerTurnId) ||
    !Array.isArray(request.grants) ||
    Array.from(request.grants).some(
      (g) => !g || !validId(g.lineageId) || !validCount(g.capacity),
    ) ||
    new Set(request.grants.map((g) => g.lineageId)).size !== request.grants.length
  ) {
    return { ...fail('invalid-request', 'Invalid or duplicate frozen lineage grants'), state };
  }
  if (state.cycles.some((c) => c.team === request.team && c.ownerTurnId === request.ownerTurnId)) {
    return { ...fail('cycle-already-open', 'This owner-turn budget is already frozen'), state };
  }
  if (request.expectedVersion !== state.version || state.version === Number.MAX_SAFE_INTEGER) {
    return { ...fail('stale-version', 'Reinforcement version is stale or exhausted'), state };
  }
  const version = state.version + 1;
  return {
    ok: true,
    state: {
      version,
      cycles: [
        ...state.cycles,
        {
          team: request.team,
          ownerTurnId: request.ownerTurnId,
          openedVersion: version,
          grants: request.grants.map((g) => ({
            lineageId: g.lineageId,
            capacity: g.capacity,
            spent: 0,
          })),
        },
      ],
      receipts: [...state.receipts],
    },
  };
}

/** Queries the intersection of the shared frozen budget and the current network's own limit. */
export function reinforcementAllowance(
  state: ReinforcementState,
  context: ReinforcementContext,
  networkId: string,
): ReinforcementAllowance {
  const invalid = validateReinforcementState(state);
  if (invalid) return fail('invalid-state', invalid);
  if (
    !context ||
    !validCount(context.snapshotVersion) ||
    !context.ownerTurn ||
    !validTeam(context.ownerTurn.team) ||
    !validId(context.ownerTurn.id) ||
    !Array.isArray(context.networks) ||
    Array.from(context.networks).some(
      (n) =>
        !n || !validId(n.networkId) || !validId(n.lineageId) || !validCount(n.currentRemaining),
    ) ||
    new Set(context.networks.map((n) => n.networkId)).size !== context.networks.length ||
    !validId(networkId)
  ) {
    return fail('invalid-context', 'Invalid or ambiguous current-network facts');
  }
  if (context.snapshotVersion !== state.version) {
    return fail('stale-version', 'Recompute network facts for the current reinforcement version');
  }
  const cycle = state.cycles.find(
    (c) => c.team === context.ownerTurn.team && c.ownerTurnId === context.ownerTurn.id,
  );
  if (!cycle) return fail('cycle-not-open', 'This owner-turn has no frozen reinforcement budget');
  const network = context.networks.find((n) => n.networkId === networkId);
  if (!network) return fail('unknown-network', 'Network is absent from the current snapshot');
  const grant = cycle.grants.find((g) => g.lineageId === network.lineageId);
  if (!grant) return fail('unfunded-lineage', 'Lineage received no grant at this cycle opening');
  const lineageRemaining = grant.capacity - grant.spent;
  return {
    ok: true,
    lineageId: grant.lineageId,
    lineageRemaining,
    networkRemaining: network.currentRemaining,
    available: Math.min(lineageRemaining, network.currentRemaining),
  };
}

/**
 * Debits the single shared lineage record. The controller must atomically apply the returned
 * current-network delta with its deployment and refresh context before the next request.
 * Replays return the original receipt without spending; they are not current allowance queries.
 */
export function applyReinforcementSpend(
  state: ReinforcementState,
  request: ReinforcementSpendRequest,
  context: ReinforcementContext,
): ReinforcementSpendResult {
  const invalid = validateReinforcementState(state);
  if (invalid) return { ...fail('invalid-state', invalid), state };
  if (!requestValid(request))
    return { ...fail('invalid-request', 'Invalid reinforcement debit'), state };
  const prior = state.receipts.find((r) => r.request.requestId === request.requestId);
  if (prior) {
    return requestKey(prior.request) === requestKey(request)
      ? { ok: true, state, replayed: true, receipt: prior }
      : { ...fail('request-conflict', 'Request ID already belongs to a different debit'), state };
  }
  if (request.expectedVersion !== state.version || state.version === Number.MAX_SAFE_INTEGER) {
    return { ...fail('stale-version', 'Reinforcement version is stale or exhausted'), state };
  }
  const allowance = reinforcementAllowance(state, context, request.networkId);
  if (!allowance.ok) return { ...allowance, state };
  if (context.ownerTurn.team !== request.team || context.ownerTurn.id !== request.ownerTurnId) {
    return {
      ...fail('invalid-request', 'Debit must use the current authoritative owner turn'),
      state,
    };
  }
  if (request.units > allowance.available) {
    return {
      ...fail('insufficient-allowance', 'Shared lineage or current-network limit is exhausted'),
      state,
    };
  }
  const receipt: ReinforcementReceipt = {
    request: { ...request },
    resultingVersion: state.version + 1,
    lineageId: allowance.lineageId,
    networkRemainingBefore: allowance.networkRemaining,
    networkRemainingAfter: allowance.networkRemaining - request.units,
  };
  return {
    ok: true,
    replayed: false,
    receipt,
    state: {
      version: receipt.resultingVersion,
      cycles: state.cycles.map((cycle) =>
        cycle.team === request.team && cycle.ownerTurnId === request.ownerTurnId
          ? {
              ...cycle,
              grants: cycle.grants.map((grant) =>
                grant.lineageId === allowance.lineageId
                  ? { ...grant, spent: grant.spent + request.units }
                  : grant,
              ),
            }
          : cycle,
      ),
      receipts: [...state.receipts, receipt],
    },
  };
}

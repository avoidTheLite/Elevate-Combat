import type { Team } from '../types.ts';
import { validateFoundationWorkState } from './workLedger.ts';
import type { FoundationWorkState, NodeWorkSpend } from './workLedger.ts';

export type FoundationCaptureOutcome = 'capture' | 'raze';
export type FoundationCaptureData =
  | null
  | string
  | number
  | boolean
  | readonly FoundationCaptureData[]
  | { readonly [key: string]: FoundationCaptureData };

/** Definition/tier/upgrade/equipment data survives both outcomes, including inaccessible ruins. */
export interface FoundationCaptureBuilding {
  readonly id: string;
  readonly ruined: boolean;
  readonly data: FoundationCaptureData;
}

export interface FoundationCaptureNode {
  readonly id: string;
  readonly mainHex: string;
  readonly centerSubHex: string;
  readonly owner: Team | null;
  readonly buildings: readonly FoundationCaptureBuilding[];
}

/** Required profile input. There are deliberately no capture/raze price defaults. */
export interface FoundationCaptureCosts {
  readonly capture: number;
  readonly raze: number;
}

/** These are authoritative controller events, never phase flags accepted from a client action. */
export type FoundationCaptureEvent =
  | { readonly kind: 'turn-start-after-income'; readonly incomeReceiptId: string }
  | { readonly kind: 'manual-battle-end'; readonly battleId: string }
  | { readonly kind: 'strategic-movement'; readonly movementReceiptId: string };

export interface FoundationCaptureFacts {
  readonly nodeId: string;
  readonly liveGarrisonUnitIds: readonly string[];
  readonly liveCenterOccupants: readonly { readonly unitId: string; readonly team: Team }[];
  readonly liveHostileMainHexUnitIds: readonly string[];
  readonly commanders: readonly {
    readonly id: string;
    readonly team: Team;
    readonly mainHex: string;
    readonly subHex: string;
    readonly living: boolean;
  }[];
}

export interface FoundationCaptureContext {
  readonly snapshotVersion: number;
  readonly ownerTurn: { readonly team: Team; readonly id: string };
  readonly event: FoundationCaptureEvent;
  readonly costs: FoundationCaptureCosts;
  /** All eligible nodes for this event must be supplied together by the controller. */
  readonly candidates: readonly FoundationCaptureFacts[];
}

export interface FoundationCaptureBeginRequest {
  readonly requestId: string;
  readonly expectedVersion: number;
}

export interface FoundationCaptureChoiceRequest extends FoundationCaptureBeginRequest {
  readonly batchId: string;
  readonly nodeId: string;
  readonly outcome: FoundationCaptureOutcome;
}

export interface FoundationCaptureCommitRequest extends FoundationCaptureBeginRequest {
  readonly batchId: string;
}

export interface FoundationCaptureChoice {
  readonly request: FoundationCaptureChoiceRequest;
  readonly resultingVersion: number;
}

export interface FoundationCaptureBatch {
  /** The begin request ID is the stable batch ID. */
  readonly request: FoundationCaptureBeginRequest;
  readonly openedVersion: number;
  readonly team: Team;
  readonly ownerTurnId: string;
  readonly event: FoundationCaptureEvent;
  readonly costs: FoundationCaptureCosts;
  readonly candidates: readonly {
    readonly node: FoundationCaptureNode;
    readonly facts: FoundationCaptureFacts;
  }[];
  /** Append-only selection history; the latest request for each node is its current choice. */
  readonly choices: readonly FoundationCaptureChoice[];
}

export interface FoundationCaptureChange {
  readonly nodeId: string;
  readonly outcome: FoundationCaptureOutcome;
  readonly previousOwner: Team;
  readonly owner: Team | null;
  readonly cpSpent: number;
  /** Capture does not spend a building operation; Raze does not modify that ledger at all. */
  readonly buildingWindow: 'open' | 'closed' | 'unchanged';
  readonly sameCycleIncome: false;
  readonly sameCycleDeployment: false;
  readonly sameCycleResupply: false;
}

export interface FoundationCaptureReceipt {
  readonly request: FoundationCaptureCommitRequest;
  readonly resultingVersion: number;
  readonly batch: FoundationCaptureBatch;
  readonly cpSpent: number;
  readonly changes: readonly FoundationCaptureChange[];
  /** Caller recomputes effects and victory after the complete atomic result, never per choice. */
  readonly recomputeNetworkEffects: true;
}

/** JSON-saveable controller data. Troops and physical presence are deliberately not stored here. */
export interface FoundationCaptureState {
  readonly version: number;
  /** Work, capture and external controller changes share a snapshot version; gaps are legal. */
  readonly work: FoundationWorkState;
  readonly nodes: readonly FoundationCaptureNode[];
  readonly pending: FoundationCaptureBatch | null;
  readonly receipts: readonly FoundationCaptureReceipt[];
}

export type FoundationCaptureError =
  | 'invalid-state'
  | 'invalid-request'
  | 'invalid-context'
  | 'invalid-profile'
  | 'request-conflict'
  | 'stale-version'
  | 'pending-batch'
  | 'batch-not-found'
  | 'ineligible-capture'
  | 'incomplete-choices'
  | 'insufficient-cp';

type Failure = {
  readonly ok: false;
  readonly code: FoundationCaptureError;
  readonly reason: string;
};
export type FoundationCaptureResult =
  | (Failure & { readonly state: FoundationCaptureState })
  | {
      readonly ok: true;
      readonly state: FoundationCaptureState;
      readonly replayed: boolean;
      readonly batch: FoundationCaptureBatch;
      readonly receipt: FoundationCaptureReceipt | null;
    };

const validId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const validTeam = (v: unknown): v is Team => v === 'A' || v === 'B';
const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const uniqueIds = (values: readonly string[]): boolean =>
  Array.isArray(values) &&
  Array.from(values).every(validId) &&
  new Set(values).size === values.length;
const outcomeValid = (v: unknown): v is FoundationCaptureOutcome => v === 'capture' || v === 'raze';
const clone = <T>(value: T): T => structuredClone(value);

function jsonData(value: unknown, ancestors = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return Array.from(value).every((v) => jsonData(v, next));
  const proto = Object.getPrototypeOf(value);
  return (
    (proto === Object.prototype || proto === null) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && jsonData((value as Record<string, unknown>)[key], next),
    )
  );
}

function nodeValid(node: FoundationCaptureNode): boolean {
  return !!(
    node &&
    validId(node.id) &&
    validId(node.mainHex) &&
    validId(node.centerSubHex) &&
    (node.owner === null || validTeam(node.owner)) &&
    Array.isArray(node.buildings) &&
    node.buildings.length > 0 &&
    Array.from(node.buildings).every(
      (b) => b && validId(b.id) && typeof b.ruined === 'boolean' && jsonData(b.data),
    ) &&
    new Set(node.buildings.map((b) => b.id)).size === node.buildings.length
  );
}

export function validateFoundationCaptureCosts(costs: FoundationCaptureCosts): string | null {
  return costs &&
    whole(costs.capture) &&
    costs.capture > 0 &&
    whole(costs.raze) &&
    costs.raze > 0 &&
    costs.raze < costs.capture
    ? null
    : 'Capture and Raze require positive whole CP costs, with Raze cheaper than Capture';
}

function eventValid(event: FoundationCaptureEvent): boolean {
  if (!event) return false;
  if (event.kind === 'turn-start-after-income') return validId(event.incomeReceiptId);
  if (event.kind === 'manual-battle-end') return validId(event.battleId);
  return event.kind === 'strategic-movement' && validId(event.movementReceiptId);
}

function eventKey(batch: Pick<FoundationCaptureBatch, 'team' | 'ownerTurnId' | 'event'>): string {
  const e = batch.event;
  return JSON.stringify([
    batch.team,
    batch.ownerTurnId,
    e.kind,
    e.kind === 'turn-start-after-income'
      ? e.incomeReceiptId
      : e.kind === 'manual-battle-end'
        ? e.battleId
        : e.movementReceiptId,
  ]);
}

function factsValid(facts: FoundationCaptureFacts): boolean {
  return !!(
    facts &&
    validId(facts.nodeId) &&
    uniqueIds(facts.liveGarrisonUnitIds) &&
    uniqueIds(facts.liveHostileMainHexUnitIds) &&
    Array.isArray(facts.liveCenterOccupants) &&
    Array.from(facts.liveCenterOccupants).every(
      (u) => u && validId(u.unitId) && validTeam(u.team),
    ) &&
    new Set(facts.liveCenterOccupants.map((u) => u.unitId)).size ===
      facts.liveCenterOccupants.length &&
    Array.isArray(facts.commanders) &&
    Array.from(facts.commanders).every(
      (c) =>
        c &&
        validId(c.id) &&
        validTeam(c.team) &&
        validId(c.mainHex) &&
        validId(c.subHex) &&
        typeof c.living === 'boolean',
    ) &&
    new Set(facts.commanders.map((c) => c.id)).size === facts.commanders.length
  );
}

function eligible(
  node: FoundationCaptureNode,
  facts: FoundationCaptureFacts,
  team: Team,
  event: FoundationCaptureEvent,
): boolean {
  if (node.owner === null || node.owner === team || facts.liveGarrisonUnitIds.length) return false;
  if (event.kind === 'manual-battle-end') {
    // Manual final-state capture may coexist with unrelated enemy field survivors.
    return (
      facts.liveCenterOccupants.some((u) => u.team === team) &&
      facts.liveCenterOccupants.every((u) => u.team === team)
    );
  }
  return (
    facts.liveHostileMainHexUnitIds.length === 0 &&
    facts.liveCenterOccupants.every((u) => u.team === team) &&
    facts.commanders.some(
      (c) =>
        c.living &&
        c.team === team &&
        c.mainHex === node.mainHex &&
        (event.kind === 'turn-start-after-income' || c.subHex === node.centerSubHex),
    )
  );
}

const beginValid = (r: FoundationCaptureBeginRequest): boolean =>
  !!r && validId(r.requestId) && whole(r.expectedVersion);
const choiceValid = (r: FoundationCaptureChoiceRequest): boolean =>
  beginValid(r) && validId(r.batchId) && validId(r.nodeId) && outcomeValid(r.outcome);
const commitValid = (r: FoundationCaptureCommitRequest): boolean =>
  beginValid(r) && validId(r.batchId);
const requestKey = (
  r:
    FoundationCaptureBeginRequest | FoundationCaptureChoiceRequest | FoundationCaptureCommitRequest,
): string =>
  JSON.stringify([
    r.requestId,
    r.expectedVersion,
    'batchId' in r ? r.batchId : null,
    'nodeId' in r ? r.nodeId : null,
    'outcome' in r ? r.outcome : null,
  ]);

function batchValid(batch: FoundationCaptureBatch, version: number): boolean {
  if (
    !batch ||
    !beginValid(batch.request) ||
    !whole(batch.openedVersion) ||
    batch.openedVersion !== batch.request.expectedVersion + 1 ||
    batch.openedVersion > version ||
    !validTeam(batch.team) ||
    !validId(batch.ownerTurnId) ||
    !eventValid(batch.event) ||
    validateFoundationCaptureCosts(batch.costs) !== null ||
    !Array.isArray(batch.candidates) ||
    !batch.candidates.length ||
    !Array.isArray(batch.choices)
  )
    return false;
  const nodeIds = new Set<string>();
  for (const c of batch.candidates) {
    if (
      !c ||
      !nodeValid(c.node) ||
      !factsValid(c.facts) ||
      c.node.id !== c.facts.nodeId ||
      nodeIds.has(c.node.id) ||
      !eligible(c.node, c.facts, batch.team, batch.event)
    )
      return false;
    nodeIds.add(c.node.id);
  }
  let previousVersion = batch.openedVersion;
  for (const choice of batch.choices) {
    if (
      !choice ||
      !choiceValid(choice.request) ||
      !whole(choice.resultingVersion) ||
      choice.request.batchId !== batch.request.requestId ||
      !nodeIds.has(choice.request.nodeId) ||
      choice.request.expectedVersion < previousVersion ||
      choice.resultingVersion !== choice.request.expectedVersion + 1 ||
      choice.resultingVersion > version
    )
      return false;
    previousVersion = choice.resultingVersion;
  }
  return true;
}

/** Current selections in candidate order; superseded requests stay in history for idempotency. */
export function currentFoundationCaptureChoices(
  batch: FoundationCaptureBatch,
): readonly FoundationCaptureChoice[] {
  const latest = new Map<string, FoundationCaptureChoice>();
  for (const choice of batch.choices) latest.set(choice.request.nodeId, choice);
  return batch.candidates.flatMap(({ node }) => {
    const choice = latest.get(node.id);
    return choice ? [choice] : [];
  });
}

/** Checks saveable pending choices and durable history without repairing or replaying either. */
export function validateFoundationCaptureState(state: FoundationCaptureState): string | null {
  if (
    !state ||
    !whole(state.version) ||
    validateFoundationWorkState(state.work) !== null ||
    state.work.version !== state.version ||
    !Array.isArray(state.nodes) ||
    !Array.from(state.nodes).every(nodeValid) ||
    new Set(state.nodes.map((n) => n.id)).size !== state.nodes.length ||
    !Array.isArray(state.receipts) ||
    (state.pending !== null && !batchValid(state.pending, state.version))
  ) {
    return 'Invalid capture state, work ledger or pending batch';
  }
  const requestIds = new Set<string>();
  const versions = new Set(state.work.receipts.map((r) => r.resultingVersion));
  const events = new Set<string>();
  const register = (batch: FoundationCaptureBatch): boolean => {
    if (
      !batchValid(batch, state.version) ||
      requestIds.has(batch.request.requestId) ||
      versions.has(batch.openedVersion) ||
      events.has(eventKey(batch))
    )
      return false;
    requestIds.add(batch.request.requestId);
    versions.add(batch.openedVersion);
    events.add(eventKey(batch));
    for (const choice of batch.choices) {
      if (requestIds.has(choice.request.requestId) || versions.has(choice.resultingVersion))
        return false;
      requestIds.add(choice.request.requestId);
      versions.add(choice.resultingVersion);
    }
    return true;
  };
  for (const receipt of state.receipts) {
    if (
      !receipt ||
      !register(receipt.batch) ||
      !commitValid(receipt.request) ||
      receipt.request.batchId !== receipt.batch.request.requestId ||
      currentFoundationCaptureChoices(receipt.batch).length !== receipt.batch.candidates.length ||
      !whole(receipt.resultingVersion) ||
      receipt.resultingVersion !== receipt.request.expectedVersion + 1 ||
      receipt.resultingVersion > state.version ||
      receipt.request.expectedVersion < receipt.batch.choices.at(-1)!.resultingVersion ||
      requestIds.has(receipt.request.requestId) ||
      versions.has(receipt.resultingVersion) ||
      !whole(receipt.cpSpent) ||
      receipt.recomputeNetworkEffects !== true ||
      !Array.isArray(receipt.changes) ||
      receipt.changes.length !== receipt.batch.candidates.length
    ) {
      return 'Invalid or duplicate capture receipt';
    }
    requestIds.add(receipt.request.requestId);
    versions.add(receipt.resultingVersion);
    let total = 0;
    for (const [i, candidate] of receipt.batch.candidates.entries()) {
      const change = receipt.changes[i];
      const outcome = currentFoundationCaptureChoices(receipt.batch).find(
        (c: FoundationCaptureChoice) => c.request.nodeId === candidate.node.id,
      )!.request.outcome;
      const cost = receipt.batch.costs[outcome];
      if (
        !change ||
        change.nodeId !== candidate.node.id ||
        change.outcome !== outcome ||
        change.previousOwner !== candidate.node.owner ||
        change.owner !== (outcome === 'capture' ? receipt.batch.team : null) ||
        change.cpSpent !== cost ||
        change.sameCycleIncome !== false ||
        change.sameCycleDeployment !== false ||
        change.sameCycleResupply !== false ||
        (outcome === 'raze'
          ? change.buildingWindow !== 'unchanged'
          : receipt.batch.event.kind === 'turn-start-after-income'
            ? !['open', 'closed'].includes(change.buildingWindow)
            : change.buildingWindow !== 'closed')
      ) {
        return 'Capture receipt differs from its frozen choices';
      }
      total += cost;
    }
    if (!whole(total) || total !== receipt.cpSpent)
      return 'Capture receipt has an invalid CP total';
  }
  if (state.pending && !register(state.pending)) return 'Duplicate pending capture batch';
  return null;
}

function failure(
  state: FoundationCaptureState,
  code: FoundationCaptureError,
  reason: string,
): FoundationCaptureResult {
  return { ok: false, code, reason, state };
}

function batches(state: FoundationCaptureState): readonly FoundationCaptureBatch[] {
  return [...state.receipts.map((r) => r.batch), ...(state.pending ? [state.pending] : [])];
}

function requestUsed(state: FoundationCaptureState, id: string): boolean {
  return (
    state.receipts.some((r) => r.request.requestId === id) ||
    batches(state).some(
      (b) => b.request.requestId === id || b.choices.some((c) => c.request.requestId === id),
    )
  );
}

function fresh(state: FoundationCaptureState, expectedVersion: number): boolean {
  return state.version === expectedVersion && state.version < Number.MAX_SAFE_INTEGER;
}

/**
 * Freeze the complete eligible set after the authoritative event. For a start-turn event the
 * controller must provide a real completed income receipt; this API never schedules income,
 * infers an acquisition phase, performs auto-resolve, or grants recruitment/resupply.
 */
export function beginFoundationCapture(
  state: FoundationCaptureState,
  request: FoundationCaptureBeginRequest,
  context: FoundationCaptureContext,
): FoundationCaptureResult {
  const invalid = validateFoundationCaptureState(state);
  if (invalid) return failure(state, 'invalid-state', invalid);
  if (!beginValid(request))
    return failure(state, 'invalid-request', 'Invalid capture begin request');
  const prior = batches(state).find((b) => b.request.requestId === request.requestId);
  if (prior)
    return requestKey(prior.request) === requestKey(request)
      ? {
          ok: true,
          state,
          replayed: true,
          batch: prior,
          receipt:
            state.receipts.find((r) => r.batch.request.requestId === request.requestId) ?? null,
        }
      : failure(state, 'request-conflict', 'Batch ID belongs to another request');
  if (requestUsed(state, request.requestId))
    return failure(state, 'request-conflict', 'Request ID is already used');
  if (!fresh(state, request.expectedVersion))
    return failure(state, 'stale-version', 'Capture snapshot is stale or exhausted');
  if (state.pending)
    return failure(state, 'pending-batch', 'Resolve the existing complete capture set first');
  if (
    !context ||
    context.snapshotVersion !== state.version ||
    !context.ownerTurn ||
    !validTeam(context.ownerTurn.team) ||
    !validId(context.ownerTurn.id) ||
    !eventValid(context.event) ||
    !Array.isArray(context.candidates) ||
    !context.candidates.length ||
    !Array.from(context.candidates).every(factsValid) ||
    new Set(context.candidates.map((c) => c.nodeId)).size !== context.candidates.length
  ) {
    return failure(state, 'invalid-context', 'Invalid authoritative phase or capture evidence');
  }
  const invalidCosts = validateFoundationCaptureCosts(context.costs);
  if (invalidCosts) return failure(state, 'invalid-profile', invalidCosts);
  const event = {
    team: context.ownerTurn.team,
    ownerTurnId: context.ownerTurn.id,
    event: context.event,
  };
  if (batches(state).some((b) => eventKey(b) === eventKey(event))) {
    return failure(state, 'request-conflict', 'This event already opened its capture set');
  }
  const candidates: FoundationCaptureBatch['candidates'][number][] = [];
  for (const facts of context.candidates) {
    const node = state.nodes.find((n) => n.id === facts.nodeId);
    if (!node || !eligible(node, facts, context.ownerTurn.team, context.event)) {
      return failure(
        state,
        'ineligible-capture',
        'Final occupants or strategic clearance do not permit capture',
      );
    }
    candidates.push({ node: clone(node), facts: clone(facts) });
  }
  const version = state.version + 1;
  const batch: FoundationCaptureBatch = {
    request: { ...request },
    openedVersion: version,
    ...event,
    event: clone(context.event),
    costs: { ...context.costs },
    candidates,
    choices: [],
  };
  return {
    ok: true,
    replayed: false,
    batch,
    receipt: null,
    state: { ...state, version, work: { ...state.work, version }, pending: batch },
  };
}

/**
 * Append or revise a pending selection with a new request ID. Earlier requests remain replayable
 * without rolling back a newer selection. Nothing transfers and no CP is spent before commit.
 */
export function chooseFoundationCapture(
  state: FoundationCaptureState,
  request: FoundationCaptureChoiceRequest,
): FoundationCaptureResult {
  const invalid = validateFoundationCaptureState(state);
  if (invalid) return failure(state, 'invalid-state', invalid);
  if (!choiceValid(request))
    return failure(state, 'invalid-request', 'Invalid Capture/Raze choice');
  const saved = batches(state)
    .flatMap((b) => b.choices)
    .find((c) => c.request.requestId === request.requestId);
  if (saved) {
    if (requestKey(saved.request) !== requestKey(request))
      return failure(state, 'request-conflict', 'Choice ID belongs to another request');
    const batch = batches(state).find((b) => b.request.requestId === request.batchId)!;
    return {
      ok: true,
      state,
      replayed: true,
      batch,
      receipt: state.receipts.find((r) => r.batch.request.requestId === request.batchId) ?? null,
    };
  }
  if (requestUsed(state, request.requestId))
    return failure(state, 'request-conflict', 'Request ID is already used');
  if (!fresh(state, request.expectedVersion))
    return failure(state, 'stale-version', 'Capture choice snapshot is stale or exhausted');
  const batch = state.pending;
  if (!batch || batch.request.requestId !== request.batchId)
    return failure(state, 'batch-not-found', 'No matching pending capture batch');
  if (!batch.candidates.some((c) => c.node.id === request.nodeId))
    return failure(state, 'invalid-request', 'Node is not in the frozen eligible set');
  const version = state.version + 1;
  const updated = {
    ...batch,
    choices: [...batch.choices, { request: { ...request }, resultingVersion: version }],
  };
  return {
    ok: true,
    replayed: false,
    batch: updated,
    receipt: null,
    state: { ...state, version, work: { ...state.work, version }, pending: updated },
  };
}

/**
 * Commit all choices and their summed CP together. A failure, including insufficient CP,
 * retains the entire pending state unchanged. There is no implicit skip, debt or defer policy.
 * The caller then recomputes network/control projections and victory before strategic resume.
 */
export function commitFoundationCapture(
  state: FoundationCaptureState,
  request: FoundationCaptureCommitRequest,
  context: {
    readonly snapshotVersion: number;
    readonly ownerTurn: { readonly team: Team; readonly id: string };
  },
): FoundationCaptureResult {
  const invalid = validateFoundationCaptureState(state);
  if (invalid) return failure(state, 'invalid-state', invalid);
  if (!commitValid(request))
    return failure(state, 'invalid-request', 'Invalid capture commit request');
  const prior = state.receipts.find((r) => r.request.requestId === request.requestId);
  if (prior)
    return requestKey(prior.request) === requestKey(request)
      ? { ok: true, state, replayed: true, batch: prior.batch, receipt: prior }
      : failure(state, 'request-conflict', 'Commit ID belongs to another request');
  if (requestUsed(state, request.requestId))
    return failure(state, 'request-conflict', 'Request ID is already used');
  if (!fresh(state, request.expectedVersion))
    return failure(state, 'stale-version', 'Capture commit snapshot is stale or exhausted');
  const batch = state.pending;
  if (!batch || batch.request.requestId !== request.batchId)
    return failure(state, 'batch-not-found', 'No matching pending capture batch');
  if (
    !context ||
    context.snapshotVersion !== state.version ||
    !context.ownerTurn ||
    context.ownerTurn.team !== batch.team ||
    context.ownerTurn.id !== batch.ownerTurnId
  ) {
    return failure(
      state,
      'invalid-context',
      'Commit must retain the authoritative acquisition owner-turn',
    );
  }
  const selections = currentFoundationCaptureChoices(batch);
  if (selections.length !== batch.candidates.length)
    return failure(
      state,
      'incomplete-choices',
      'Every eligible node requires its own Capture/Raze choice',
    );
  for (const candidate of batch.candidates) {
    const current = state.nodes.find((n) => n.id === candidate.node.id);
    if (JSON.stringify(current) !== JSON.stringify(candidate.node))
      return failure(state, 'stale-version', 'Node changed after capture eligibility was frozen');
  }
  const cpSpent = selections.reduce((sum, c) => sum + batch.costs[c.request.outcome], 0);
  if (!whole(cpSpent) || cpSpent > state.work.commandPoints[batch.team])
    return failure(state, 'insufficient-cp', 'Complete Capture/Raze set exceeds available CP');
  let nodeSpending = [...state.work.nodeSpending];
  const changes: FoundationCaptureChange[] = [];
  const replacements = new Map<string, FoundationCaptureNode>();
  for (const candidate of batch.candidates) {
    const node = candidate.node;
    const outcome = selections.find((c) => c.request.nodeId === node.id)!.request.outcome;
    let buildingWindow: FoundationCaptureChange['buildingWindow'] = 'unchanged';
    if (outcome === 'capture') {
      const existing = nodeSpending.find(
        (s) => s.nodeId === node.id && s.team === batch.team && s.ownerTurnId === batch.ownerTurnId,
      );
      const record: NodeWorkSpend = existing ?? {
        nodeId: node.id,
        team: batch.team,
        ownerTurnId: batch.ownerTurnId,
        ordinarySpent: false,
        operationCount: 0,
        activationClosed: false,
        activationRepairSpent: false,
      };
      // Never erase spending or reopen a previously closed window under the same cycle token.
      buildingWindow =
        batch.event.kind === 'turn-start-after-income' && record.buildingWindow !== 'closed'
          ? 'open'
          : 'closed';
      nodeSpending = [...nodeSpending.filter((s) => s !== existing), { ...record, buildingWindow }];
    }
    replacements.set(node.id, {
      ...clone(node),
      owner: outcome === 'capture' ? batch.team : null,
      buildings: node.buildings.map((b) => ({
        ...clone(b),
        ruined: outcome === 'raze' || b.ruined,
      })),
    });
    changes.push({
      nodeId: node.id,
      outcome,
      previousOwner: node.owner!,
      owner: outcome === 'capture' ? batch.team : null,
      cpSpent: batch.costs[outcome],
      buildingWindow,
      sameCycleIncome: false,
      sameCycleDeployment: false,
      sameCycleResupply: false,
    });
  }
  const version = state.version + 1;
  const receipt: FoundationCaptureReceipt = {
    request: { ...request },
    resultingVersion: version,
    batch: clone(batch),
    cpSpent,
    changes,
    recomputeNetworkEffects: true,
  };
  return {
    ok: true,
    replayed: false,
    batch: receipt.batch,
    receipt,
    state: {
      ...state,
      version,
      pending: null,
      nodes: state.nodes.map((n) => replacements.get(n.id) ?? n),
      work: {
        ...state.work,
        version,
        commandPoints: {
          ...state.work.commandPoints,
          [batch.team]: state.work.commandPoints[batch.team] - cpSpent,
        },
        nodeSpending,
      },
      receipts: [...state.receipts, receipt],
    },
  };
}

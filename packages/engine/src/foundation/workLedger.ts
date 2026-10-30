import type { Army, Team } from '../types.ts';
import { unitType } from '../units.ts';

/** Capture/Raze, activation and owner-turn transitions have separate integration policies. */
export type FoundationWorkKind = 'build' | 'upgrade' | 'repair-building' | 'repair-road';

export interface NodeWorkSpend {
  readonly nodeId: string;
  readonly team: Team;
  readonly ownerTurnId: string;
  readonly ordinarySpent: boolean;
  readonly operationCount: number;
  readonly activationClosed: boolean;
  readonly activationRepairSpent: boolean;
}

export interface EngineerWorkSpend {
  readonly unitId: string;
  readonly team: Team;
  readonly ownerTurnId: string;
  readonly receiptId: string;
}

export interface FoundationWorkRequest {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly ownerTurnId: string;
  readonly team: Team;
  readonly kind: FoundationWorkKind;
  readonly targetId: string;
  readonly engineerUnitId: string | null;
}

export interface FoundationWorkReceipt {
  readonly request: FoundationWorkRequest;
  readonly resultingVersion: number;
  readonly cpSpent: number;
  readonly nodeId: string | null;
  readonly nodeOperationsSpent: 0 | 1;
  readonly allowance: 'ordinary' | 'engineer';
  readonly engineerUnitId: string | null;
  readonly activationRepair: boolean;
}

export interface FoundationWorkState {
  readonly version: number;
  /** This spending primitive accepts whole, safely representable CP only; it never rounds. */
  readonly commandPoints: Readonly<Record<Team, number>>;
  readonly nodeSpending: readonly NodeWorkSpend[];
  readonly engineerSpending: readonly EngineerWorkSpend[];
  readonly receipts: readonly FoundationWorkReceipt[];
}

/** Authoritative engine facts, not flags copied from a client action. */
export interface FoundationWorkNode {
  readonly id: string;
  readonly mainHex: string;
  readonly owner: Team | null;
}

type WorkTargetBase = {
  readonly id: string;
  /** Explicit whole CP cost in [0, Number.MAX_SAFE_INTEGER]; fractional pricing is unsupported. */
  readonly cpCost: number;
};

export type FoundationWorkTarget = WorkTargetBase &
  (
    | {
        readonly kind: 'build' | 'upgrade';
        readonly nodeId: string;
        readonly engineerRequired: boolean;
      }
    | { readonly kind: 'repair-building'; readonly nodeId: string }
    | { readonly kind: 'repair-road'; readonly mainHex: string }
  );

export interface FoundationWorkContext {
  readonly ownerTurn: { readonly team: Team; readonly id: string };
  readonly nodes: readonly FoundationWorkNode[];
  readonly targets: readonly FoundationWorkTarget[];
  readonly holders: readonly Readonly<
    Pick<Army, 'id' | 'team' | 'kind' | 'at'> & {
      units: readonly Readonly<Army['units'][number]>[];
    }
  >[];
}

export type FoundationWorkError =
  | 'invalid-state'
  | 'invalid-request'
  | 'invalid-context'
  | 'request-conflict'
  | 'stale-version'
  | 'unknown-target'
  | 'not-owner'
  | 'activation-closed'
  | 'activation-repair-spent'
  | 'node-limit'
  | 'engineer-required'
  | 'ineligible-engineer'
  | 'engineer-spent'
  | 'insufficient-cp';

type WorkFailure = {
  readonly ok: false;
  readonly code: FoundationWorkError;
  readonly reason: string;
};

export type FoundationWorkEvaluation =
  | WorkFailure
  | {
      readonly ok: true;
      readonly replayed: true;
      readonly receipt: FoundationWorkReceipt;
    }
  | {
      readonly ok: true;
      readonly replayed: false;
      readonly receipt: FoundationWorkReceipt;
      readonly nodeSpend: NodeWorkSpend | null;
      readonly engineerSpend: EngineerWorkSpend | null;
    };

export type FoundationWorkResult =
  | (WorkFailure & { readonly state: FoundationWorkState })
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly state: FoundationWorkState;
      readonly receipt: FoundationWorkReceipt;
    };

const KINDS: readonly string[] = ['build', 'upgrade', 'repair-building', 'repair-road'];
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const validTeam = (value: unknown): value is Team => value === 'A' || value === 'B';
const validHitPoints = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validCommandPoints = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const validVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function requestValid(request: FoundationWorkRequest): boolean {
  return !!(
    request &&
    validId(request.requestId) &&
    validVersion(request.expectedVersion) &&
    validId(request.ownerTurnId) &&
    validTeam(request.team) &&
    KINDS.includes(request.kind) &&
    validId(request.targetId) &&
    (request.engineerUnitId === null || validId(request.engineerUnitId))
  );
}

function requestKey(request: FoundationWorkRequest): string {
  return JSON.stringify([
    request.requestId,
    request.expectedVersion,
    request.ownerTurnId,
    request.team,
    request.kind,
    request.targetId,
    request.engineerUnitId,
  ]);
}

function spendKey(spend: { nodeId: string; team: Team; ownerTurnId: string }): string {
  return JSON.stringify([spend.nodeId, spend.team, spend.ownerTurnId]);
}

function engineerKey(spend: { unitId: string; team: Team; ownerTurnId: string }): string {
  return JSON.stringify([spend.unitId, spend.team, spend.ownerTurnId]);
}

/** Checks durable counters and their receipts; it never repairs or resets them. */
export function validateFoundationWorkState(state: FoundationWorkState): string | null {
  if (
    !state ||
    !validVersion(state.version) ||
    !state.commandPoints ||
    !validCommandPoints(state.commandPoints.A) ||
    !validCommandPoints(state.commandPoints.B) ||
    !Array.isArray(state.nodeSpending) ||
    !Array.isArray(state.engineerSpending) ||
    !Array.isArray(state.receipts)
  ) {
    return 'Invalid work ledger or CP balance';
  }
  const nodes = new Map<string, NodeWorkSpend>();
  for (const spend of state.nodeSpending) {
    if (
      !spend ||
      !validId(spend.nodeId) ||
      !validTeam(spend.team) ||
      !validId(spend.ownerTurnId) ||
      !Number.isInteger(spend.operationCount) ||
      spend.operationCount < 0 ||
      spend.operationCount > 2 ||
      typeof spend.ordinarySpent !== 'boolean' ||
      typeof spend.activationClosed !== 'boolean' ||
      typeof spend.activationRepairSpent !== 'boolean' ||
      ((spend.ordinarySpent || spend.activationRepairSpent) && spend.operationCount === 0) ||
      (spend.activationRepairSpent && !spend.activationClosed)
    ) {
      return 'Invalid node work record';
    }
    const key = spendKey(spend);
    if (nodes.has(key)) return 'Duplicate node work record';
    nodes.set(key, spend);
  }
  const engineers = new Map<string, EngineerWorkSpend>();
  for (const spend of state.engineerSpending) {
    if (
      !spend ||
      !validId(spend.unitId) ||
      !validTeam(spend.team) ||
      !validId(spend.ownerTurnId) ||
      !validId(spend.receiptId)
    ) {
      return 'Invalid engineer work record';
    }
    const key = engineerKey(spend);
    if (engineers.has(key)) return 'Duplicate engineer work record';
    engineers.set(key, spend);
  }
  const requests = new Set<string>();
  const receiptVersions = new Set<number>();
  const counted = new Map<string, number>();
  const ordinary = new Set<string>();
  for (const receipt of state.receipts) {
    if (
      !receipt ||
      !requestValid(receipt.request) ||
      !validVersion(receipt.resultingVersion) ||
      receipt.resultingVersion !== receipt.request.expectedVersion + 1 ||
      receipt.resultingVersion > state.version ||
      !validCommandPoints(receipt.cpSpent) ||
      (receipt.nodeId !== null && !validId(receipt.nodeId)) ||
      ![0, 1].includes(receipt.nodeOperationsSpent) ||
      !['ordinary', 'engineer'].includes(receipt.allowance) ||
      (receipt.engineerUnitId !== null && !validId(receipt.engineerUnitId)) ||
      typeof receipt.activationRepair !== 'boolean' ||
      (receipt.allowance === 'engineer') !== (receipt.engineerUnitId !== null) ||
      (receipt.allowance === 'engineer' &&
        receipt.engineerUnitId !== receipt.request.engineerUnitId) ||
      ((receipt.request.kind === 'repair-road' || receipt.request.kind === 'repair-building') &&
        receipt.allowance !== 'engineer') ||
      (receipt.activationRepair && receipt.request.kind !== 'repair-building') ||
      (receipt.request.kind === 'repair-road') !== (receipt.nodeId === null) ||
      receipt.nodeOperationsSpent !== (receipt.nodeId === null ? 0 : 1)
    ) {
      return 'Invalid work receipt';
    }
    if (requests.has(receipt.request.requestId)) return 'Duplicate work receipt';
    requests.add(receipt.request.requestId);
    if (receiptVersions.has(receipt.resultingVersion)) return 'Duplicate work receipt version';
    receiptVersions.add(receipt.resultingVersion);
    if (receipt.engineerUnitId !== null) {
      const spend = engineers.get(
        engineerKey({ ...receipt.request, unitId: receipt.engineerUnitId }),
      );
      if (!spend || spend.receiptId !== receipt.request.requestId) {
        return 'Engineer receipt has lost its spending record';
      }
    }
    if (receipt.nodeId !== null) {
      const key = spendKey({ ...receipt.request, nodeId: receipt.nodeId });
      const spend = nodes.get(key);
      const count = (counted.get(key) ?? 0) + 1;
      counted.set(key, count);
      if (!spend || spend.operationCount < count) return 'Node receipt has lost its work count';
      if (receipt.allowance === 'ordinary') {
        if (!spend.ordinarySpent || ordinary.has(key)) return 'Invalid ordinary allowance receipts';
        ordinary.add(key);
      }
      if (receipt.activationRepair && !spend.activationRepairSpent) {
        return 'Activation repair receipt has lost its spending record';
      }
    }
  }
  return null;
}

function contextValid(context: FoundationWorkContext): boolean {
  if (
    !context ||
    !context.ownerTurn ||
    !validTeam(context.ownerTurn.team) ||
    !validId(context.ownerTurn.id) ||
    !Array.isArray(context.nodes) ||
    !Array.isArray(context.targets) ||
    !Array.isArray(context.holders)
  ) {
    return false;
  }
  const nodeIds = new Set<string>();
  for (const node of context.nodes) {
    if (
      !node ||
      !validId(node.id) ||
      nodeIds.has(node.id) ||
      !validId(node.mainHex) ||
      (node.owner !== null && !validTeam(node.owner))
    ) {
      return false;
    }
    nodeIds.add(node.id);
  }
  const targetIds = new Set<string>();
  for (const target of context.targets) {
    if (
      !target ||
      !validId(target.id) ||
      !KINDS.includes(target.kind) ||
      !validCommandPoints(target.cpCost)
    ) {
      return false;
    }
    const key = JSON.stringify([target.kind, target.id]);
    if (targetIds.has(key)) return false;
    targetIds.add(key);
    if (target.kind === 'repair-road') {
      if (!validId(target.mainHex)) return false;
    } else {
      if (!validId(target.nodeId) || !nodeIds.has(target.nodeId)) return false;
      if (
        (target.kind === 'build' || target.kind === 'upgrade') &&
        typeof target.engineerRequired !== 'boolean'
      ) {
        return false;
      }
    }
  }
  const holderIds = new Set<string>();
  const unitIds = new Set<string>();
  for (const holder of context.holders) {
    if (
      !holder ||
      !validId(holder.id) ||
      holderIds.has(holder.id) ||
      !validTeam(holder.team) ||
      !['commander', 'garrison'].includes(holder.kind) ||
      !validId(holder.at) ||
      !Array.isArray(holder.units)
    ) {
      return false;
    }
    holderIds.add(holder.id);
    for (const unit of holder.units) {
      if (
        !unit ||
        !validId(unit.id) ||
        unitIds.has(unit.id) ||
        !validId(unit.typeId) ||
        !validHitPoints(unit.hp)
      ) {
        return false;
      }
      unitIds.add(unit.id);
    }
  }
  return true;
}

function fail(code: FoundationWorkError, reason: string): WorkFailure {
  return { ok: false, code, reason };
}

/**
 * Plans spending only. The caller supplies a trusted current definition/holder snapshot and
 * separately validates slots, tier, damage and other game legality before committing both.
 * The version must cover that snapshot. This function never starts or refreshes a turn.
 * Evaluate and apply inside the game's same `withRules` scope, as for tactical engineer work.
 * CP balances and costs must be nonnegative safe integers, ensuring exact deduction without
 * silently rounding a configured price. Fractional work pricing needs a separate policy/API.
 */
export function evaluateFoundationWork(
  state: FoundationWorkState,
  request: FoundationWorkRequest,
  context: FoundationWorkContext,
): FoundationWorkEvaluation {
  const invalidState = validateFoundationWorkState(state);
  if (invalidState) return fail('invalid-state', invalidState);
  if (!requestValid(request)) return fail('invalid-request', 'Malformed work request');
  const prior = state.receipts.find((r) => r.request.requestId === request.requestId);
  if (prior) {
    return requestKey(prior.request) === requestKey(request)
      ? { ok: true, replayed: true, receipt: prior }
      : fail('request-conflict', 'Request ID already belongs to different work');
  }
  if (request.expectedVersion !== state.version || state.version === Number.MAX_SAFE_INTEGER) {
    return fail('stale-version', 'Work snapshot version is stale or exhausted');
  }
  if (!contextValid(context)) return fail('invalid-context', 'Invalid or ambiguous work facts');
  if (request.team !== context.ownerTurn.team || request.ownerTurnId !== context.ownerTurn.id) {
    return fail('invalid-request', 'Work must use the current authoritative owner turn');
  }
  const target = context.targets.find((t) => t.id === request.targetId && t.kind === request.kind);
  if (!target)
    return fail('unknown-target', 'Work target is not in the current definition snapshot');
  const node =
    target.kind === 'repair-road' ? null : context.nodes.find((n) => n.id === target.nodeId)!;
  if (node && node.owner !== request.team)
    return fail('not-owner', 'Node is not controlled by team');
  const previous = node
    ? (state.nodeSpending.find(
        (s) =>
          s.nodeId === node.id && s.team === request.team && s.ownerTurnId === request.ownerTurnId,
      ) ?? {
        nodeId: node.id,
        team: request.team,
        ownerTurnId: request.ownerTurnId,
        ordinarySpent: false,
        operationCount: 0,
        activationClosed: false,
        activationRepairSpent: false,
      })
    : null;
  if (previous) {
    if (previous.activationClosed && request.kind !== 'repair-building') {
      return fail('activation-closed', 'Activation permits repairs only for the rest of this turn');
    }
    if (previous.activationClosed && previous.activationRepairSpent) {
      return fail('activation-repair-spent', 'Post-activation building repair is already spent');
    }
    if (previous.operationCount >= 2) return fail('node-limit', 'Node has used its two operations');
  }
  const needsEngineer =
    target.kind === 'repair-road' ||
    target.kind === 'repair-building' ||
    target.engineerRequired ||
    previous!.ordinarySpent;
  const mainHex = target.kind === 'repair-road' ? target.mainHex : node!.mainHex;
  let engineerSpend: EngineerWorkSpend | null = null;
  if (request.engineerUnitId !== null) {
    const holder = context.holders.find((h) =>
      h.units.some((u) => u.id === request.engineerUnitId),
    );
    const unit = holder?.units.find((u) => u.id === request.engineerUnitId);
    let engineerType = false;
    try {
      engineerType = !!unit && unitType(unit.typeId).engineer === true;
    } catch {
      // Unknown roster entries cannot qualify as engineers.
    }
    if (
      !holder ||
      !unit ||
      !engineerType ||
      unit.hp <= 0 ||
      holder.team !== request.team ||
      holder.at !== mainHex
    ) {
      return fail('ineligible-engineer', 'Engineer must be living, friendly and in this MainHex');
    }
    if (needsEngineer) {
      engineerSpend = {
        unitId: unit.id,
        team: request.team,
        ownerTurnId: request.ownerTurnId,
        receiptId: request.requestId,
      };
      if (state.engineerSpending.some((s) => engineerKey(s) === engineerKey(engineerSpend!))) {
        return fail('engineer-spent', 'Engineer has used its strategic action for this owner turn');
      }
    }
  } else if (needsEngineer) {
    return fail('engineer-required', 'Work needs an eligible engineer with an unused action');
  }
  if (state.commandPoints[request.team] < target.cpCost) {
    return fail('insufficient-cp', 'Not enough command points');
  }
  const activationRepair = !!previous?.activationClosed;
  return {
    ok: true,
    replayed: false,
    receipt: {
      request: { ...request },
      resultingVersion: state.version + 1,
      cpSpent: target.cpCost,
      nodeId: node?.id ?? null,
      nodeOperationsSpent: node ? 1 : 0,
      allowance: needsEngineer ? 'engineer' : 'ordinary',
      engineerUnitId: engineerSpend?.unitId ?? null,
      activationRepair,
    },
    nodeSpend: previous
      ? {
          ...previous,
          ordinarySpent: previous.ordinarySpent || !needsEngineer,
          operationCount: previous.operationCount + 1,
          activationRepairSpent: previous.activationRepairSpent || activationRepair,
        }
      : null,
    engineerSpend,
  };
}

/** Applies the same pure evaluation atomically to CP and ledger data; never mutates inputs. */
export function applyFoundationWork(
  state: FoundationWorkState,
  request: FoundationWorkRequest,
  context: FoundationWorkContext,
): FoundationWorkResult {
  const result = evaluateFoundationWork(state, request, context);
  if (!result.ok) return { ...result, state };
  if (result.replayed) return { ...result, state };
  const nodeSpend = result.nodeSpend;
  return {
    ok: true,
    replayed: false,
    receipt: result.receipt,
    state: {
      version: result.receipt.resultingVersion,
      commandPoints: {
        ...state.commandPoints,
        [request.team]: state.commandPoints[request.team] - result.receipt.cpSpent,
      },
      nodeSpending: nodeSpend
        ? [...state.nodeSpending.filter((s) => spendKey(s) !== spendKey(nodeSpend)), nodeSpend]
        : [...state.nodeSpending],
      engineerSpending: result.engineerSpend
        ? [...state.engineerSpending, result.engineerSpend]
        : [...state.engineerSpending],
      receipts: [...state.receipts, result.receipt],
    },
  };
}

import { parseKey } from '../hex.ts';
import type { Team } from '../types.ts';

export type FreeShotTrigger = 'strategic-after-income' | 'tactical-after-deployment';

/** Trusted engine facts; this controller does not calculate range, LOS or damage. */
export interface FreeShotActor {
  readonly id: string;
  readonly team: Team;
  readonly subHex: string;
  readonly alive: boolean;
  readonly kind: 'stationed-unit' | 'unit' | 'commander';
  /** Normal tactical actions must be preserved by the free-shot adapter. */
  readonly normalActions: {
    readonly mp: number;
    readonly acted: boolean;
    readonly moved: boolean;
  } | null;
}

export interface FreeShotFrame {
  readonly revision: number;
  readonly rngState: number;
  readonly actors: readonly FreeShotActor[];
  readonly legalTargets: readonly { readonly shooterId: string; readonly targetId: string }[];
}

export interface OpenFreeShotCycleRequest {
  readonly expectedVersion: number;
  readonly team: Team;
  readonly ownerCycleId: string;
}

export interface BeginFreeShotBoundaryRequest {
  readonly expectedVersion: number;
  readonly boundaryId: string;
  readonly trigger: FreeShotTrigger;
  /** Strategic owner boundary; tactical boundaries include both owners. */
  readonly strategicOwner: Team | null;
}

export interface SelectFreeShotTargetRequest {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly boundaryId: string;
  readonly team: Team;
  readonly ownerCycleId: string;
  readonly shooterId: string;
  readonly targetId: string;
}

export interface ResolveFreeShotRequest {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly selectionId: string;
}

export interface FreeShotQueueEntry {
  readonly unitId: string;
  readonly team: Team;
  readonly ownerCycleId: string;
  readonly subHex: string;
}

export interface FreeShotBoundary {
  readonly request: BeginFreeShotBoundaryRequest;
  readonly initialFrame: FreeShotFrame;
  readonly queue: readonly FreeShotQueueEntry[];
  readonly openedVersion: number;
  readonly completedVersion: number | null;
}

export interface FreeShotSelection {
  readonly request: SelectFreeShotTargetRequest;
  readonly resultingVersion: number;
}

export interface FreeShotReceipt {
  readonly request: ResolveFreeShotRequest;
  readonly resultingVersion: number;
  readonly boundaryId: string;
  readonly trigger: FreeShotTrigger;
  readonly team: Team;
  readonly ownerCycleId: string;
  readonly shooterId: string;
  readonly targetId: string;
  readonly outcomeId: string;
  readonly rngBefore: number;
  readonly rngAfter: number;
  readonly frameBefore: number;
  readonly frameAfter: number;
  readonly outcomeFrame: FreeShotFrame;
}

/** Retain this history; opening another boundary is never an allowance reset. */
export interface FreeShotState {
  readonly version: number;
  readonly cycles: readonly {
    readonly request: OpenFreeShotCycleRequest;
    readonly openedVersion: number;
  }[];
  readonly boundaries: readonly FreeShotBoundary[];
  readonly selections: readonly FreeShotSelection[];
  readonly receipts: readonly FreeShotReceipt[];
  readonly pending: {
    readonly boundaryId: string;
    readonly cursor: number;
    readonly selectionId: string | null;
    readonly frame: FreeShotFrame;
  } | null;
}

export type FreeShotError =
  | 'invalid-state'
  | 'invalid-request'
  | 'invalid-frame'
  | 'stale-version'
  | 'request-conflict'
  | 'pending-boundary'
  | 'cycle-not-open'
  | 'no-pending-boundary'
  | 'selection-pending'
  | 'wrong-shooter'
  | 'illegal-target'
  | 'no-selection'
  | 'adapter-failed'
  | 'invalid-outcome';

type Failure = { readonly ok: false; readonly code: FreeShotError; readonly reason: string };
export type FreeShotResult =
  | (Failure & { readonly state: FreeShotState })
  | {
      readonly ok: true;
      readonly state: FreeShotState;
      readonly replayed: boolean;
      readonly receipt: FreeShotReceipt | null;
      /** New live facts to commit with state; null on replay prevents reapplying an old outcome. */
      readonly frame: FreeShotFrame | null;
    };

export type FreeShotPrompt =
  | Failure
  | { readonly ok: true; readonly status: 'complete' }
  | {
      readonly ok: true;
      readonly status: 'choose-target' | 'selected';
      readonly boundaryId: string;
      readonly trigger: FreeShotTrigger;
      readonly team: Team;
      readonly ownerCycleId: string;
      readonly shooterId: string;
      readonly targetIds: readonly string[];
      readonly selection: FreeShotSelection | null;
    };

export type FreeShotAdapter = (input: {
  readonly frame: FreeShotFrame;
  readonly trigger: FreeShotTrigger;
  readonly selection: FreeShotSelection;
  readonly shooter: FreeShotActor;
  readonly target: FreeShotActor;
}) =>
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly outcomeId: string;
      readonly frame: FreeShotFrame;
    };

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const team = (value: unknown): value is Team => value === 'A' || value === 'B';
const rng = (value: unknown): value is number => count(value) && value <= 0xffffffff;
const trigger = (value: unknown): value is FreeShotTrigger =>
  value === 'strategic-after-income' || value === 'tactical-after-deployment';
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function coordinate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^-?\d+,-?\d+$/.test(value)) return false;
  const parsed = parseKey(value);
  return (
    Number.isSafeInteger(parsed.q) &&
    Number.isSafeInteger(parsed.r) &&
    `${parsed.q},${parsed.r}` === value
  );
}

function dense<T>(value: unknown, valid: (item: T) => boolean): value is readonly T[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++)
    if (!Object.hasOwn(value, i) || !valid(value[i])) return false;
  return true;
}

function actionsValid(value: FreeShotActor['normalActions']): boolean {
  return (
    value === null ||
    !!(
      object(value) &&
      typeof value.mp === 'number' &&
      Number.isFinite(value.mp) &&
      value.mp >= 0 &&
      typeof value.acted === 'boolean' &&
      typeof value.moved === 'boolean'
    )
  );
}

function cycleValid(value: OpenFreeShotCycleRequest): boolean {
  return !!(
    value &&
    count(value.expectedVersion) &&
    team(value.team) &&
    validId(value.ownerCycleId)
  );
}
function boundaryValid(value: BeginFreeShotBoundaryRequest): boolean {
  return !!(
    value &&
    count(value.expectedVersion) &&
    validId(value.boundaryId) &&
    trigger(value.trigger) &&
    (value.trigger === 'strategic-after-income'
      ? team(value.strategicOwner)
      : value.strategicOwner === null)
  );
}
function selectionValid(value: SelectFreeShotTargetRequest): boolean {
  return !!(
    value &&
    validId(value.requestId) &&
    count(value.expectedVersion) &&
    validId(value.boundaryId) &&
    team(value.team) &&
    validId(value.ownerCycleId) &&
    validId(value.shooterId) &&
    validId(value.targetId)
  );
}
function resolutionValid(value: ResolveFreeShotRequest): boolean {
  return !!(
    value &&
    validId(value.requestId) &&
    count(value.expectedVersion) &&
    validId(value.selectionId)
  );
}
function cycleKey(value: Pick<OpenFreeShotCycleRequest, 'team' | 'ownerCycleId'>): string {
  return JSON.stringify([value.team, value.ownerCycleId]);
}
function spentKey(value: Pick<FreeShotReceipt, 'team' | 'ownerCycleId' | 'shooterId'>): string {
  return JSON.stringify([value.team, value.ownerCycleId, value.shooterId]);
}
function cycleRequestKey(value: OpenFreeShotCycleRequest): string {
  return JSON.stringify([value.expectedVersion, value.team, value.ownerCycleId]);
}
function boundaryRequestKey(value: BeginFreeShotBoundaryRequest): string {
  return JSON.stringify([
    value.expectedVersion,
    value.boundaryId,
    value.trigger,
    value.strategicOwner,
  ]);
}
function selectionKey(value: SelectFreeShotTargetRequest): string {
  return JSON.stringify([
    value.requestId,
    value.expectedVersion,
    value.boundaryId,
    value.team,
    value.ownerCycleId,
    value.shooterId,
    value.targetId,
  ]);
}
function resolutionKey(value: ResolveFreeShotRequest): string {
  return JSON.stringify([value.requestId, value.expectedVersion, value.selectionId]);
}
function actorOrder(a: { subHex: string; id: string }, b: { subHex: string; id: string }): number {
  const ac = parseKey(a.subHex);
  const bc = parseKey(b.subHex);
  return ac.q - bc.q || ac.r - bc.r || lexical(a.id, b.id);
}

/** Plain JSON facts only; dead references may remain, but they are never eligible. */
export function validateFreeShotFrame(frame: FreeShotFrame): string | null {
  if (
    !frame ||
    !count(frame.revision) ||
    !rng(frame.rngState) ||
    !dense<FreeShotActor>(
      frame.actors,
      (a) =>
        !!(
          a &&
          validId(a.id) &&
          team(a.team) &&
          coordinate(a.subHex) &&
          typeof a.alive === 'boolean' &&
          ['stationed-unit', 'unit', 'commander'].includes(a.kind) &&
          actionsValid(a.normalActions)
        ),
    ) ||
    !dense<FreeShotFrame['legalTargets'][number]>(
      frame.legalTargets,
      (p) => !!(p && validId(p.shooterId) && validId(p.targetId)),
    )
  )
    return 'Invalid free-shot frame';
  const actors = new Map(frame.actors.map((a) => [a.id, a]));
  if (actors.size !== frame.actors.length) return 'Duplicate free-shot actor';
  const pairs = new Set<string>();
  for (const pair of frame.legalTargets) {
    const shooter = actors.get(pair.shooterId);
    const targetActor = actors.get(pair.targetId);
    const key = JSON.stringify([pair.shooterId, pair.targetId]);
    if (
      !shooter ||
      !targetActor ||
      shooter.kind !== 'stationed-unit' ||
      shooter.team === targetActor.team ||
      pairs.has(key)
    )
      return 'Invalid or duplicate target fact';
    pairs.add(key);
  }
  return null;
}

function frameKey(frame: FreeShotFrame): string {
  return JSON.stringify([
    frame.revision,
    frame.rngState,
    [...frame.actors]
      .sort((a, b) => lexical(a.id, b.id))
      .map((a) => [
        a.id,
        a.team,
        a.subHex,
        a.alive,
        a.kind,
        a.normalActions === null
          ? null
          : [a.normalActions.mp, a.normalActions.acted, a.normalActions.moved],
      ]),
    frame.legalTargets
      .map((p) => [p.shooterId, p.targetId])
      .sort((a, b) => lexical(JSON.stringify(a), JSON.stringify(b))),
  ]);
}

function copyFrame(frame: FreeShotFrame): FreeShotFrame {
  return {
    revision: frame.revision,
    rngState: frame.rngState,
    actors: frame.actors.map((a) => ({
      ...a,
      normalActions: a.normalActions === null ? null : { ...a.normalActions },
    })),
    legalTargets: frame.legalTargets.map((p) => ({ ...p })),
  };
}
function frozenFrame(frame: FreeShotFrame): FreeShotFrame {
  const clone = copyFrame(frame);
  for (const a of clone.actors) {
    if (a.normalActions !== null) Object.freeze(a.normalActions);
    Object.freeze(a);
  }
  for (const p of clone.legalTargets) Object.freeze(p);
  Object.freeze(clone.actors);
  Object.freeze(clone.legalTargets);
  return Object.freeze(clone);
}
function latestCycle(
  state: FreeShotState,
  owner: Team,
): FreeShotState['cycles'][number] | undefined {
  return state.cycles
    .filter((c) => c.request.team === owner)
    .sort((a, b) => b.openedVersion - a.openedVersion)[0];
}
function normalActionsKey(value: FreeShotActor['normalActions']): string {
  return JSON.stringify(value === null ? null : [value.mp, value.acted, value.moved]);
}
function frameTransitionValid(before: FreeShotFrame, after: FreeShotFrame): boolean {
  return (
    validateFreeShotFrame(after) === null &&
    after.revision === before.revision + 1 &&
    after.actors.length === before.actors.length &&
    before.actors.every((a) => {
      const next = after.actors.find((n) => n.id === a.id);
      return (
        !!next &&
        next.team === a.team &&
        next.kind === a.kind &&
        next.subHex === a.subHex &&
        (a.alive || !next.alive) &&
        normalActionsKey(a.normalActions) === normalActionsKey(next.normalActions)
      );
    })
  );
}
function nextShooterIndex(
  queue: readonly FreeShotQueueEntry[],
  start: number,
  frame: FreeShotFrame,
  boundaryTrigger: FreeShotTrigger,
  spent: ReadonlySet<string>,
): number {
  let cursor = start;
  while (cursor < queue.length) {
    const q = queue[cursor];
    const actor = frame.actors.find((a) => a.id === q.unitId);
    if (
      actor?.alive &&
      actor.kind === 'stationed-unit' &&
      !spent.has(spentKey({ ...q, shooterId: q.unitId })) &&
      targets(frame, q.unitId, boundaryTrigger).length
    )
      break;
    cursor += 1;
  }
  return cursor;
}
function copyReceipt(receipt: FreeShotReceipt): FreeShotReceipt {
  return {
    ...receipt,
    request: { ...receipt.request },
    outcomeFrame: copyFrame(receipt.outcomeFrame),
  };
}
function targets(
  frame: FreeShotFrame,
  shooterId: string,
  boundaryTrigger: FreeShotTrigger,
): FreeShotActor[] {
  const shooter = frame.actors.find((a) => a.id === shooterId);
  if (!shooter?.alive || shooter.kind !== 'stationed-unit') return [];
  const allowed = new Set(
    frame.legalTargets.filter((p) => p.shooterId === shooterId).map((p) => p.targetId),
  );
  return frame.actors
    .filter(
      (a) =>
        a.alive &&
        a.team !== shooter.team &&
        allowed.has(a.id) &&
        (boundaryTrigger === 'strategic-after-income'
          ? a.kind === 'commander'
          : a.kind !== 'commander'),
    )
    .sort(actorOrder);
}

/** Receipt/counter validation only; root session validation must bind these facts to game state. */
export function validateFreeShotState(state: FreeShotState): string | null {
  if (
    !state ||
    !count(state.version) ||
    !dense<FreeShotState['cycles'][number]>(
      state.cycles,
      (c) => !!(c && cycleValid(c.request) && count(c.openedVersion)),
    ) ||
    !dense<FreeShotBoundary>(
      state.boundaries,
      (b) =>
        !!(
          b &&
          boundaryValid(b.request) &&
          validateFreeShotFrame(b.initialFrame) === null &&
          count(b.openedVersion) &&
          (b.completedVersion === null || count(b.completedVersion)) &&
          dense<FreeShotQueueEntry>(
            b.queue,
            (q) =>
              !!(
                q &&
                validId(q.unitId) &&
                team(q.team) &&
                validId(q.ownerCycleId) &&
                coordinate(q.subHex)
              ),
          )
        ),
    ) ||
    !dense<FreeShotSelection>(
      state.selections,
      (s) => !!(s && selectionValid(s.request) && count(s.resultingVersion)),
    ) ||
    !dense<FreeShotReceipt>(
      state.receipts,
      (r) =>
        !!(
          r &&
          resolutionValid(r.request) &&
          count(r.resultingVersion) &&
          validId(r.boundaryId) &&
          trigger(r.trigger) &&
          team(r.team) &&
          validId(r.ownerCycleId) &&
          validId(r.shooterId) &&
          validId(r.targetId) &&
          validId(r.outcomeId) &&
          rng(r.rngBefore) &&
          rng(r.rngAfter) &&
          count(r.frameBefore) &&
          count(r.frameAfter) &&
          validateFreeShotFrame(r.outcomeFrame) === null
        ),
    )
  )
    return 'Invalid free-shot history';
  const versions = new Set<number>();
  const addVersion = (opened: number, expected: number): boolean => {
    if (opened < 1 || opened > state.version || opened !== expected + 1 || versions.has(opened))
      return false;
    versions.add(opened);
    return true;
  };
  const cycles = new Map<string, FreeShotState['cycles'][number]>();
  for (const c of state.cycles) {
    if (cycles.has(cycleKey(c.request)) || !addVersion(c.openedVersion, c.request.expectedVersion))
      return 'Invalid or duplicate owner cycle';
    cycles.set(cycleKey(c.request), c);
  }
  const boundaries = new Map<string, FreeShotBoundary>();
  for (const b of state.boundaries) {
    if (
      boundaries.has(b.request.boundaryId) ||
      !addVersion(b.openedVersion, b.request.expectedVersion) ||
      (b.completedVersion !== null &&
        (b.completedVersion < b.openedVersion || b.completedVersion > state.version))
    )
      return 'Invalid or duplicate boundary';
    const initialShooters = b.initialFrame.actors
      .filter(
        (a) =>
          a.alive &&
          a.kind === 'stationed-unit' &&
          (b.request.strategicOwner === null || a.team === b.request.strategicOwner),
      )
      .sort(actorOrder);
    if (initialShooters.length !== b.queue.length) return 'Queue differs from opening actors';
    const units = new Set<string>();
    for (let i = 0; i < b.queue.length; i++) {
      const q = b.queue[i];
      const actor = initialShooters[i];
      const cycle = cycles.get(cycleKey(q));
      const latestAtBoundary = state.cycles
        .filter((c) => c.request.team === q.team && c.openedVersion < b.openedVersion)
        .sort((a, z) => z.openedVersion - a.openedVersion)[0];
      if (
        units.has(q.unitId) ||
        !cycle ||
        cycle.openedVersion >= b.openedVersion ||
        latestAtBoundary !== cycle ||
        actor.id !== q.unitId ||
        actor.team !== q.team ||
        actor.subHex !== q.subHex ||
        (b.request.strategicOwner !== null && b.request.strategicOwner !== q.team)
      )
        return 'Invalid queue owner or cycle';
      if (
        i &&
        actorOrder(
          { id: b.queue[i - 1].unitId, subHex: b.queue[i - 1].subHex },
          { id: q.unitId, subHex: q.subHex },
        ) >= 0
      )
        return 'Unsorted free-shot queue';
      units.add(q.unitId);
    }
    boundaries.set(b.request.boundaryId, b);
  }
  const selections = new Map<string, FreeShotSelection>();
  for (const s of state.selections) {
    const b = boundaries.get(s.request.boundaryId);
    const q = b?.queue.find((a) => a.unitId === s.request.shooterId);
    if (
      selections.has(s.request.requestId) ||
      !addVersion(s.resultingVersion, s.request.expectedVersion) ||
      !b ||
      !q ||
      s.resultingVersion <= b.openedVersion ||
      q.team !== s.request.team ||
      q.ownerCycleId !== s.request.ownerCycleId
    )
      return 'Invalid or duplicate target selection';
    selections.set(s.request.requestId, s);
  }
  const shots = new Set<string>();
  const outcomeIds = new Set<string>();
  const resolved = new Set<string>();
  const selected = new Set<string>();
  for (const r of state.receipts) {
    const s = selections.get(r.request.selectionId);
    const b = boundaries.get(r.boundaryId);
    if (
      resolved.has(r.request.requestId) ||
      selected.has(r.request.selectionId) ||
      shots.has(spentKey(r)) ||
      outcomeIds.has(r.outcomeId) ||
      !addVersion(r.resultingVersion, r.request.expectedVersion) ||
      !s ||
      !b ||
      r.resultingVersion <= s.resultingVersion ||
      r.frameAfter !== r.frameBefore + 1 ||
      r.trigger !== b.request.trigger ||
      r.boundaryId !== s.request.boundaryId ||
      r.team !== s.request.team ||
      r.ownerCycleId !== s.request.ownerCycleId ||
      r.shooterId !== s.request.shooterId ||
      r.targetId !== s.request.targetId
    )
      return 'Invalid or duplicate shot receipt';
    resolved.add(r.request.requestId);
    selected.add(r.request.selectionId);
    shots.add(spentKey(r));
    outcomeIds.add(r.outcomeId);
  }
  // Reconstruct each sequential boundary. A saved pending frame is not an
  // independent RNG cursor or board snapshot that can drift from its receipts.
  for (const b of state.boundaries) {
    const boundaryShots = state.receipts
      .filter((r) => r.boundaryId === b.request.boundaryId)
      .sort((a, z) => a.resultingVersion - z.resultingVersion);
    const priorSpent = new Set(
      state.receipts.filter((r) => r.resultingVersion < b.openedVersion).map(spentKey),
    );
    let frame = b.initialFrame;
    let lastVersion = b.openedVersion;
    let cursor = nextShooterIndex(b.queue, 0, frame, b.request.trigger, priorSpent);
    for (const r of boundaryShots) {
      const selection = selections.get(r.request.selectionId)!;
      const q = b.queue[cursor];
      if (
        !q ||
        q.unitId !== r.shooterId ||
        q.team !== r.team ||
        q.ownerCycleId !== r.ownerCycleId ||
        selection.resultingVersion !== lastVersion + 1 ||
        r.resultingVersion !== selection.resultingVersion + 1 ||
        r.frameBefore !== frame.revision ||
        r.rngBefore !== frame.rngState ||
        r.frameAfter !== r.outcomeFrame.revision ||
        r.rngAfter !== r.outcomeFrame.rngState ||
        !frameTransitionValid(frame, r.outcomeFrame) ||
        !targets(frame, q.unitId, b.request.trigger).some((a) => a.id === r.targetId)
      )
        return 'Broken sequential outcome chain';
      frame = r.outcomeFrame;
      lastVersion = r.resultingVersion;
      priorSpent.add(spentKey(r));
      cursor = nextShooterIndex(b.queue, cursor + 1, frame, b.request.trigger, priorSpent);
    }
    if (b.completedVersion !== null) {
      if (cursor !== b.queue.length || b.completedVersion !== lastVersion)
        return 'Boundary completion differs from its final outcome';
    } else {
      const pending = state.pending;
      if (
        !pending ||
        pending.boundaryId !== b.request.boundaryId ||
        pending.cursor !== cursor ||
        validateFreeShotFrame(pending.frame) !== null ||
        frameKey(pending.frame) !== frameKey(frame)
      )
        return 'Pending frame differs from its outcome chain';
      const selectedVersion =
        pending.selectionId === null
          ? lastVersion
          : selections.get(pending.selectionId)?.resultingVersion;
      if (
        selectedVersion !== state.version ||
        (pending.selectionId !== null && selectedVersion !== lastVersion + 1)
      )
        return 'Pending selection differs from its outcome chain';
    }
  }
  if (versions.size !== state.version) return 'Incomplete free-shot version history';
  const unfinished = state.boundaries.filter((b) => b.completedVersion === null);
  if (state.pending === null)
    return unfinished.length
      ? 'Missing pending free-shot queue'
      : state.selections.some((s) => !selected.has(s.request.requestId))
        ? 'Unattached target selection'
        : null;
  const p = state.pending;
  if (
    !object(p) ||
    !validId(p.boundaryId) ||
    !count(p.cursor) ||
    (p.selectionId !== null && !validId(p.selectionId)) ||
    validateFreeShotFrame(p.frame) !== null
  )
    return 'Invalid pending free-shot queue';
  const b = boundaries.get(p.boundaryId);
  if (
    !b ||
    unfinished.length !== 1 ||
    unfinished[0] !== b ||
    p.cursor >= b.queue.length ||
    state.cycles.some((c) => c.openedVersion > b.openedVersion)
  )
    return 'Invalid pending boundary/cursor';
  const q = b.queue[p.cursor];
  const shooter = p.frame.actors.find((a) => a.id === q.unitId);
  if (
    !shooter ||
    !shooter.alive ||
    shooter.kind !== 'stationed-unit' ||
    shooter.team !== q.team ||
    shooter.subHex !== q.subHex ||
    latestCycle(state, q.team)?.request.ownerCycleId !== q.ownerCycleId ||
    shots.has(spentKey({ ...q, shooterId: q.unitId })) ||
    !targets(p.frame, q.unitId, b.request.trigger).length
  )
    return 'Pending queue must point to a live eligible shooter';
  if (p.selectionId !== null) {
    const s = selections.get(p.selectionId);
    if (
      !s ||
      selected.has(p.selectionId) ||
      s.request.boundaryId !== p.boundaryId ||
      s.request.shooterId !== q.unitId ||
      !targets(p.frame, q.unitId, b.request.trigger).some((a) => a.id === s.request.targetId)
    )
      return 'Invalid pending target selection';
  }
  if (
    state.selections.some(
      (s) => !selected.has(s.request.requestId) && s.request.requestId !== p.selectionId,
    )
  )
    return 'Unattached target selection';
  return null;
}

export function createFreeShotState(): FreeShotState {
  return { version: 0, cycles: [], boundaries: [], selections: [], receipts: [], pending: null };
}
function fail(state: FreeShotState, code: FreeShotError, reason: string): FreeShotResult {
  return { ok: false, state, code, reason };
}
function success(
  state: FreeShotState,
  replayed = false,
  receipt: FreeShotReceipt | null = null,
  frame: FreeShotFrame | null = null,
): FreeShotResult {
  return { ok: true, state, replayed, receipt, frame };
}
function checked(state: FreeShotState): FreeShotResult | null {
  const error = validateFreeShotState(state);
  return error ? fail(state, 'invalid-state', error) : null;
}
function current(state: FreeShotState, expected: number): FreeShotResult | null {
  if (state.version !== expected) return fail(state, 'stale-version', 'Free-shot state changed');
  return state.version === Number.MAX_SAFE_INTEGER
    ? fail(state, 'invalid-state', 'Free-shot version exhausted')
    : null;
}

/** Called only at an explicit owner strategic-cycle boundary, before shot checks. */
export function openFreeShotCycle(
  state: FreeShotState,
  request: OpenFreeShotCycleRequest,
): FreeShotResult {
  const invalid = checked(state);
  if (invalid) return invalid;
  if (!cycleValid(request)) return fail(state, 'invalid-request', 'Invalid owner cycle request');
  const prior = state.cycles.find((c) => cycleKey(c.request) === cycleKey(request));
  if (prior)
    return cycleRequestKey(prior.request) === cycleRequestKey(request)
      ? success(state, true)
      : fail(state, 'request-conflict', 'Owner cycle already exists');
  const stale = current(state, request.expectedVersion);
  if (stale) return stale;
  if (state.pending !== null)
    return fail(state, 'pending-boundary', 'Finish pending shots before opening a new owner cycle');
  const version = state.version + 1;
  return success({
    ...state,
    version,
    cycles: [...state.cycles, { request: { ...request }, openedVersion: version }],
  });
}

function advance(state: FreeShotState): FreeShotState {
  if (state.pending === null || state.pending.selectionId !== null) return state;
  const p = state.pending;
  const b = state.boundaries.find((a) => a.request.boundaryId === p.boundaryId)!;
  const cursor = nextShooterIndex(
    b.queue,
    p.cursor,
    p.frame,
    b.request.trigger,
    new Set(state.receipts.map(spentKey)),
  );
  if (cursor < b.queue.length) return { ...state, pending: { ...p, cursor } };
  return {
    ...state,
    pending: null,
    boundaries: state.boundaries.map((a) =>
      a === b ? { ...a, completedVersion: state.version } : a,
    ),
  };
}

/** Does not reset allowances. Root orchestration guarantees the named phase boundary. */
export function beginFreeShotBoundary(
  state: FreeShotState,
  request: BeginFreeShotBoundaryRequest,
  frame: FreeShotFrame,
): FreeShotResult {
  const invalid = checked(state);
  if (invalid) return invalid;
  if (!boundaryValid(request))
    return fail(state, 'invalid-request', 'Invalid shot boundary request');
  const frameError = validateFreeShotFrame(frame);
  if (frameError) return fail(state, 'invalid-frame', frameError);
  const prior = state.boundaries.find((b) => b.request.boundaryId === request.boundaryId);
  if (prior)
    return boundaryRequestKey(prior.request) === boundaryRequestKey(request) &&
      frameKey(prior.initialFrame) === frameKey(frame)
      ? success(state, true)
      : fail(state, 'request-conflict', 'Boundary ID has different facts');
  const stale = current(state, request.expectedVersion);
  if (stale) return stale;
  if (state.pending !== null)
    return fail(state, 'pending-boundary', 'Finish pending shots before starting another boundary');
  const shooters = frame.actors
    .filter(
      (a) =>
        a.alive &&
        a.kind === 'stationed-unit' &&
        (request.strategicOwner === null || a.team === request.strategicOwner),
    )
    .sort(actorOrder);
  if (shooters.some((a) => !latestCycle(state, a.team)))
    return fail(state, 'cycle-not-open', 'Every shooter needs an explicitly opened owner cycle');
  const queue = shooters.map((a) => ({
    unitId: a.id,
    team: a.team,
    subHex: a.subHex,
    ownerCycleId: latestCycle(state, a.team)!.request.ownerCycleId,
  }));
  const version = state.version + 1;
  const boundary: FreeShotBoundary = {
    request: { ...request },
    initialFrame: copyFrame(frame),
    queue,
    openedVersion: version,
    completedVersion: null,
  };
  return success(
    advance({
      ...state,
      version,
      boundaries: [...state.boundaries, boundary],
      pending: {
        boundaryId: request.boundaryId,
        cursor: 0,
        selectionId: null,
        frame: copyFrame(frame),
      },
    }),
  );
}

export function getFreeShotPrompt(state: FreeShotState): FreeShotPrompt {
  const error = validateFreeShotState(state);
  if (error) return { ok: false, code: 'invalid-state', reason: error };
  if (state.pending === null) return { ok: true, status: 'complete' };
  const p = state.pending;
  const b = state.boundaries.find((a) => a.request.boundaryId === p.boundaryId)!;
  const q = b.queue[p.cursor];
  const selection = state.selections.find((s) => s.request.requestId === p.selectionId) ?? null;
  return {
    ok: true,
    status: selection === null ? 'choose-target' : 'selected',
    boundaryId: p.boundaryId,
    trigger: b.request.trigger,
    team: q.team,
    ownerCycleId: q.ownerCycleId,
    shooterId: q.unitId,
    targetIds: targets(p.frame, q.unitId, b.request.trigger).map((a) => a.id),
    selection: selection === null ? null : { ...selection, request: { ...selection.request } },
  };
}

/** No pass/defer operation: a legal shot waits for an explicit owner/AI target command. */
export function selectFreeShotTarget(
  state: FreeShotState,
  request: SelectFreeShotTargetRequest,
): FreeShotResult {
  const invalid = checked(state);
  if (invalid) return invalid;
  if (!selectionValid(request)) return fail(state, 'invalid-request', 'Invalid target command');
  const prior = state.selections.find((s) => s.request.requestId === request.requestId);
  if (prior)
    return selectionKey(prior.request) === selectionKey(request)
      ? success(state, true)
      : fail(state, 'request-conflict', 'Selection request ID changed');
  const stale = current(state, request.expectedVersion);
  if (stale) return stale;
  const p = state.pending;
  if (p === null || p.boundaryId !== request.boundaryId)
    return fail(state, 'no-pending-boundary', 'No matching pending boundary');
  if (p.selectionId !== null)
    return fail(state, 'selection-pending', 'Resolve the selected shot first');
  const b = state.boundaries.find((a) => a.request.boundaryId === p.boundaryId)!;
  const q = b.queue[p.cursor];
  if (
    q.unitId !== request.shooterId ||
    q.team !== request.team ||
    q.ownerCycleId !== request.ownerCycleId
  )
    return fail(state, 'wrong-shooter', 'Only the current shooter owner may choose its target');
  if (!targets(p.frame, q.unitId, b.request.trigger).some((a) => a.id === request.targetId))
    return fail(state, 'illegal-target', 'Selected target is not alive and eligible');
  const version = state.version + 1;
  return success({
    ...state,
    version,
    selections: [...state.selections, { request: { ...request }, resultingVersion: version }],
    pending: { ...p, selectionId: request.requestId },
  });
}

/** Atomically accepts one existing-combat outcome; adapter failures spend nothing. */
export function resolveSelectedFreeShot(
  state: FreeShotState,
  request: ResolveFreeShotRequest,
  adapter: FreeShotAdapter,
): FreeShotResult {
  const invalid = checked(state);
  if (invalid) return invalid;
  if (!resolutionValid(request))
    return fail(state, 'invalid-request', 'Invalid resolution request');
  const prior = state.receipts.find((r) => r.request.requestId === request.requestId);
  if (prior)
    return resolutionKey(prior.request) === resolutionKey(request)
      ? success(state, true, copyReceipt(prior))
      : fail(state, 'request-conflict', 'Resolution request ID changed');
  const stale = current(state, request.expectedVersion);
  if (stale) return stale;
  const p = state.pending;
  if (p === null || p.selectionId !== request.selectionId)
    return fail(state, 'no-selection', 'No matching pending selection');
  const selection = state.selections.find((s) => s.request.requestId === p.selectionId)!;
  const b = state.boundaries.find((a) => a.request.boundaryId === p.boundaryId)!;
  const shooter = p.frame.actors.find((a) => a.id === selection.request.shooterId)!;
  const target = targets(p.frame, shooter.id, b.request.trigger).find(
    (a) => a.id === selection.request.targetId,
  );
  if (!shooter.alive || !target)
    return fail(state, 'illegal-target', 'Shooter or selected target is no longer eligible');
  let outcome: Extract<ReturnType<FreeShotAdapter>, { readonly ok: true }>;
  try {
    const frame = frozenFrame(p.frame);
    const frozenSelection = Object.freeze({
      ...selection,
      request: Object.freeze({ ...selection.request }),
    });
    const attempted = adapter(
      Object.freeze({
        frame,
        trigger: b.request.trigger,
        selection: frozenSelection,
        shooter: frame.actors.find((a) => a.id === shooter.id)!,
        target: frame.actors.find((a) => a.id === target.id)!,
      }),
    );
    if (!attempted || attempted.ok !== true)
      return fail(state, 'adapter-failed', 'Combat adapter did not produce a successful shot');
    outcome = attempted;
    const frameError = validateFreeShotFrame(outcome.frame);
    if (
      !validId(outcome.outcomeId) ||
      frameError ||
      outcome.frame.revision !== p.frame.revision + 1 ||
      state.receipts.some((r) => r.outcomeId === outcome.outcomeId) ||
      outcome.frame.actors.length !== p.frame.actors.length
    )
      return fail(state, 'invalid-outcome', 'Invalid or duplicate combat outcome');
    for (const before of p.frame.actors) {
      const after = outcome.frame.actors.find((a) => a.id === before.id);
      if (
        !after ||
        after.team !== before.team ||
        after.kind !== before.kind ||
        after.subHex !== before.subHex ||
        (!before.alive && after.alive) ||
        normalActionsKey(after.normalActions) !== normalActionsKey(before.normalActions)
      )
        return fail(
          state,
          'invalid-outcome',
          'Free shots cannot move actors, revive them or spend normal actions',
        );
    }
  } catch {
    return fail(state, 'adapter-failed', 'Combat adapter failed; the pending shot remains unspent');
  }
  const version = state.version + 1;
  const receipt: FreeShotReceipt = {
    request: { ...request },
    resultingVersion: version,
    boundaryId: p.boundaryId,
    trigger: b.request.trigger,
    team: selection.request.team,
    ownerCycleId: selection.request.ownerCycleId,
    shooterId: shooter.id,
    targetId: target.id,
    outcomeId: outcome.outcomeId,
    rngBefore: p.frame.rngState,
    rngAfter: outcome.frame.rngState,
    frameBefore: p.frame.revision,
    frameAfter: outcome.frame.revision,
    outcomeFrame: copyFrame(outcome.frame),
  };
  return success(
    advance({
      ...state,
      version,
      receipts: [...state.receipts, receipt],
      pending: { ...p, cursor: p.cursor + 1, selectionId: null, frame: copyFrame(outcome.frame) },
    }),
    false,
    copyReceipt(receipt),
    copyFrame(outcome.frame),
  );
}

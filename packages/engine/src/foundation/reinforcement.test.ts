import { describe, expect, it } from 'vitest';
import {
  applyReinforcementSpend,
  createReinforcementState,
  openReinforcementCycle,
  reinforcementAllowance,
  validateReinforcementState,
} from './reinforcement.ts';
import type {
  OpenReinforcementCycleRequest,
  ReinforcementContext,
  ReinforcementError,
  ReinforcementSpendRequest,
  ReinforcementState,
} from './reinforcement.ts';

function open(
  state = createReinforcementState(),
  overrides: Partial<OpenReinforcementCycleRequest> = {},
): ReinforcementState {
  const result = openReinforcementCycle(state, {
    expectedVersion: state.version,
    team: 'A',
    ownerTurnId: 'A-turn-1',
    grants: [{ lineageId: 'origin', capacity: 10 }],
    ...overrides,
  });
  if (!result.ok) throw new Error(result.reason);
  expect(validateReinforcementState(result.state)).toBeNull();
  return result.state;
}

function facts(
  state: ReinforcementState,
  networks: ReinforcementContext['networks'] = [
    { networkId: 'whole', lineageId: 'origin', currentRemaining: 10 },
  ],
): ReinforcementContext {
  return {
    snapshotVersion: state.version,
    ownerTurn: { team: 'A', id: 'A-turn-1' },
    networks,
  };
}

function request(
  state: ReinforcementState,
  overrides: Partial<ReinforcementSpendRequest> = {},
): ReinforcementSpendRequest {
  return {
    requestId: `debit-${state.version}`,
    expectedVersion: state.version,
    team: 'A',
    ownerTurnId: 'A-turn-1',
    networkId: 'whole',
    units: 6,
    ...overrides,
  };
}

function spend(
  state: ReinforcementState,
  overrides: Partial<ReinforcementSpendRequest> = {},
  context = facts(state),
): ReinforcementState {
  const result = applyReinforcementSpend(state, request(state, overrides), context);
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  expect(validateReinforcementState(result.state)).toBeNull();
  return result.state;
}

function rejects(
  state: ReinforcementState,
  overrides: Partial<ReinforcementSpendRequest>,
  code: ReinforcementError,
  context = facts(state),
): void {
  const before = JSON.stringify(state);
  const result = applyReinforcementSpend(state, request(state, overrides), context);
  expect(result).toMatchObject({ ok: false, code });
  expect(result.state).toBe(state);
  expect(JSON.stringify(state)).toBe(before);
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: shared reinforcement lineage budget', () => {
  it('shares the original remaining four across both descendants of a 10-budget/6-spend network', () => {
    const original = spend(open());
    const split = facts(original, [
      { networkId: 'child-a', lineageId: 'origin', currentRemaining: 10 },
      { networkId: 'child-b', lineageId: 'origin', currentRemaining: 10 },
    ]);
    expect(reinforcementAllowance(original, split, 'child-a')).toMatchObject({
      ok: true,
      available: 4,
      lineageRemaining: 4,
    });
    expect(reinforcementAllowance(original, split, 'child-b')).toMatchObject({ available: 4 });
    const childA = spend(original, { networkId: 'child-a', units: 3 }, split);
    const refreshed = facts(childA, [
      { networkId: 'child-a', lineageId: 'origin', currentRemaining: 7 },
      { networkId: 'child-b', lineageId: 'origin', currentRemaining: 10 },
    ]);
    expect(reinforcementAllowance(childA, refreshed, 'child-b')).toMatchObject({ available: 1 });
    rejects(childA, { networkId: 'child-b', units: 2 }, 'insufficient-allowance', refreshed);
    const exhausted = spend(childA, { networkId: 'child-b', units: 1 }, refreshed);
    expect(exhausted.cycles[0].grants).toEqual([{ lineageId: 'origin', capacity: 10, spent: 10 }]);
    expect(exhausted.cycles).toHaveLength(1);
  });

  it('intersects shared remaining with the current network remaining instead of granting extra capacity', () => {
    const state = spend(open());
    const localLimit = facts(state, [
      { networkId: 'child-a', lineageId: 'origin', currentRemaining: 2 },
    ]);
    expect(reinforcementAllowance(state, localLimit, 'child-a')).toMatchObject({
      lineageRemaining: 4,
      networkRemaining: 2,
      available: 2,
    });
    rejects(state, { networkId: 'child-a', units: 3 }, 'insufficient-allowance', localLimit);
    const result = applyReinforcementSpend(
      state,
      request(state, { networkId: 'child-a', units: 2 }),
      localLimit,
    );
    expect(result).toMatchObject({
      ok: true,
      receipt: { networkRemainingBefore: 2, networkRemainingAfter: 0 },
    });
  });

  it('a capacity drop can close availability without undoing prior expenditure', () => {
    const state = spend(open());
    const before = JSON.stringify(state);
    const reduced = facts(state, [
      { networkId: 'whole', lineageId: 'origin', currentRemaining: 0 },
    ]);
    expect(reinforcementAllowance(state, reduced, 'whole')).toMatchObject({
      lineageRemaining: 4,
      available: 0,
    });
    rejects(state, { units: 1 }, 'insufficient-allowance', reduced);
    expect(state.cycles[0].grants[0].spent).toBe(6);
    expect(JSON.stringify(state)).toBe(before);
    // This API debits budgets only; it neither receives nor removes already-deployed units.
  });

  it('rejects a stale competing child debit and an accidentally reused network snapshot', () => {
    const state = spend(open());
    const context = facts(state, [
      { networkId: 'a', lineageId: 'origin', currentRemaining: 10 },
      { networkId: 'b', lineageId: 'origin', currentRemaining: 10 },
    ]);
    const racing = request(state, { requestId: 'racing-b', networkId: 'b', units: 3 });
    const winner = spend(state, { networkId: 'a', units: 3 }, context);
    expect(applyReinforcementSpend(winner, racing, context)).toMatchObject({
      ok: false,
      code: 'stale-version',
      state: winner,
    });
    rejects(winner, { networkId: 'b', units: 1 }, 'stale-version', context);
    rejects(winner, { networkId: 'b', units: 3 }, 'insufficient-allowance', {
      ...context,
      snapshotVersion: winner.version,
    });
  });

  it('reconnection and JSON reload retain one origin and do not replay a debit', () => {
    const start = open();
    const originalRequest = request(start);
    const state = spend(start);
    const restored: ReinforcementState = JSON.parse(JSON.stringify(state));
    const reconnected = facts(restored, [
      { networkId: 'reconnected', lineageId: 'origin', currentRemaining: 30 },
    ]);
    expect(reinforcementAllowance(restored, reconnected, 'reconnected')).toMatchObject({
      available: 4,
    });
    const replayed = applyReinforcementSpend(restored, originalRequest, reconnected);
    expect(replayed).toMatchObject({ ok: true, replayed: true, receipt: restored.receipts[0] });
    expect(replayed.state).toBe(restored);
    expect(restored.cycles[0].grants).toHaveLength(1);
    rejects(restored, { ...originalRequest, units: 1 }, 'request-conflict', reconnected);
  });

  it('freezes grants for the whole cycle and admits additional HQ capacity only at an explicit next opening', () => {
    const spent = spend(open());
    const attemptedIncrease = openReinforcementCycle(spent, {
      expectedVersion: spent.version,
      team: 'A',
      ownerTurnId: 'A-turn-1',
      grants: [{ lineageId: 'origin', capacity: 20 }],
    });
    expect(attemptedIncrease).toMatchObject({
      ok: false,
      code: 'cycle-already-open',
      state: spent,
    });
    expect(
      reinforcementAllowance(
        spent,
        facts(spent, [{ networkId: 'whole', lineageId: 'origin', currentRemaining: 20 }]),
        'whole',
      ),
    ).toMatchObject({ available: 4 });
    const next = open(spent, {
      ownerTurnId: 'A-turn-2',
      grants: [{ lineageId: 'origin', capacity: 20 }],
    });
    expect(next.cycles).toHaveLength(2);
    expect(next.cycles[0]).toEqual(spent.cycles[0]);
    expect(next.receipts).toEqual(spent.receipts);
    expect(
      reinforcementAllowance(
        next,
        {
          ...facts(next),
          ownerTurn: { team: 'A', id: 'A-turn-2' },
          networks: [{ networkId: 'whole', lineageId: 'origin', currentRemaining: 20 }],
        },
        'whole',
      ),
    ).toMatchObject({ available: 20 });
  });

  it('an initially empty cycle cannot be reopened to add a newly eligible HQ', () => {
    const empty = open(createReinforcementState(), { grants: [] });
    const reopened = openReinforcementCycle(empty, {
      expectedVersion: empty.version,
      team: 'A',
      ownerTurnId: 'A-turn-1',
      grants: [{ lineageId: 'new-hq', capacity: 10 }],
    });
    expect(reopened).toMatchObject({ ok: false, code: 'cycle-already-open', state: empty });
    expect(
      reinforcementAllowance(
        empty,
        facts(empty, [{ networkId: 'new-network', lineageId: 'new-hq', currentRemaining: 10 }]),
        'new-network',
      ),
    ).toMatchObject({ ok: false, code: 'unfunded-lineage' });
  });

  it('does not combine independent origins when a controller binds a reconnected network', () => {
    const state = spend(
      open(createReinforcementState(), {
        grants: [
          { lineageId: 'origin', capacity: 10 },
          { lineageId: 'independent', capacity: 30 },
        ],
      }),
    );
    const connected = facts(state, [
      { networkId: 'joined', lineageId: 'origin', currentRemaining: 40 },
    ]);
    expect(reinforcementAllowance(state, connected, 'joined')).toMatchObject({ available: 4 });
    expect(state.cycles[0].grants[1].spent).toBe(0);
    expect(
      reinforcementAllowance(
        state,
        {
          ...connected,
          networks: [
            { ...connected.networks[0], lineageId: ['origin', 'independent'] as unknown as string },
          ],
        },
        'joined',
      ),
    ).toMatchObject({ ok: false, code: 'invalid-context' });
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e20])(
    'rejects invalid debit amount %s without spending',
    (units) => rejects(open(), { units }, 'invalid-request'),
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e20])(
    'rejects invalid grant and current-network count %s',
    (capacity) => {
      const initial = createReinforcementState();
      expect(
        openReinforcementCycle(initial, {
          expectedVersion: 0,
          team: 'A',
          ownerTurnId: 'A-turn-1',
          grants: [{ lineageId: 'origin', capacity }],
        }),
      ).toMatchObject({ ok: false, code: 'invalid-request', state: initial });
      const state = open();
      rejects(
        state,
        { units: 1 },
        'invalid-context',
        facts(state, [{ networkId: 'whole', lineageId: 'origin', currentRemaining: capacity }]),
      );
    },
  );

  it('deducts safe-integer unit counts exactly at the representable upper boundary', () => {
    const state = open(createReinforcementState(), {
      grants: [{ lineageId: 'origin', capacity: Number.MAX_SAFE_INTEGER }],
    });
    const after = spend(
      state,
      { units: 1 },
      facts(state, [
        { networkId: 'whole', lineageId: 'origin', currentRemaining: Number.MAX_SAFE_INTEGER },
      ]),
    );
    expect(after.cycles[0].grants[0].capacity - after.cycles[0].grants[0].spent).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    expect(after.receipts[0].networkRemainingAfter).toBe(Number.MAX_SAFE_INTEGER - 1);
  });

  it('rejects duplicate grants, duplicate network handles and a forged current-turn token', () => {
    const initial = createReinforcementState();
    expect(
      openReinforcementCycle(initial, {
        expectedVersion: 0,
        team: 'A',
        ownerTurnId: 'A-turn-1',
        grants: [
          { lineageId: 'origin', capacity: 10 },
          { lineageId: 'origin', capacity: 20 },
        ],
      }),
    ).toMatchObject({ ok: false, code: 'invalid-request', state: initial });
    const state = open();
    const context = facts(state);
    rejects(state, {}, 'invalid-context', {
      ...context,
      networks: [...context.networks, ...context.networks],
    });
    rejects(state, { ownerTurnId: 'forged-turn' }, 'invalid-request');
    rejects(state, { team: 'B' }, 'invalid-request');
  });

  it.each([1, 3])('rejects sparse opening-grant arrays of length %s without mutation', (length) => {
    const state = createReinforcementState();
    const grants = new Array<OpenReinforcementCycleRequest['grants'][number]>(length);
    if (length > 1) grants[1] = { lineageId: 'origin', capacity: 10 };
    const inputKeys = Object.keys(grants);
    const before = JSON.stringify(state);
    const result = openReinforcementCycle(state, {
      expectedVersion: 0,
      team: 'A',
      ownerTurnId: 'A-turn-1',
      grants,
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(result.state).toBe(state);
    expect(Object.keys(grants)).toEqual(inputKeys);
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([1, 3])(
    'rejects sparse network snapshots of length %s without throwing or spending',
    (length) => {
      const state = open();
      const networks = new Array<ReinforcementContext['networks'][number]>(length);
      if (length > 1)
        networks[1] = { networkId: 'whole', lineageId: 'origin', currentRemaining: 10 };
      const context = facts(state, networks);
      const inputKeys = Object.keys(networks);
      expect(reinforcementAllowance(state, context, 'whole')).toMatchObject({
        ok: false,
        code: 'invalid-context',
      });
      rejects(state, { units: 1 }, 'invalid-context', context);
      expect(Object.keys(networks)).toEqual(inputKeys);
    },
  );

  it('rejects receipt deletion, counter reset and duplicate receipts or versions after reload', () => {
    const state = spend(open());
    rejects({ ...state, receipts: [] }, { units: 1 }, 'invalid-state');
    rejects(
      {
        ...state,
        cycles: [{ ...state.cycles[0], grants: [{ ...state.cycles[0].grants[0], spent: 0 }] }],
      },
      { units: 1 },
      'invalid-state',
    );
    rejects(
      { ...state, receipts: [...state.receipts, state.receipts[0]] },
      { units: 1 },
      'invalid-state',
    );
    rejects(
      {
        ...state,
        receipts: [
          ...state.receipts,
          {
            ...state.receipts[0],
            request: { ...state.receipts[0].request, requestId: 'another-id' },
          },
        ],
      },
      { units: 1 },
      'invalid-state',
    );
  });

  it('rejects stale cycle openings while preserving prior history and input references', () => {
    const state = open();
    const before = JSON.stringify(state);
    expect(
      openReinforcementCycle(state, {
        expectedVersion: 0,
        team: 'A',
        ownerTurnId: 'A-turn-2',
        grants: [],
      }),
    ).toMatchObject({ ok: false, code: 'stale-version', state });
    const context = facts(state);
    const action = request(state);
    const actionBefore = JSON.stringify({ context, action });
    applyReinforcementSpend(state, action, context);
    expect(JSON.stringify({ context, action })).toBe(actionBefore);
    expect(JSON.stringify(state)).toBe(before);
  });
});

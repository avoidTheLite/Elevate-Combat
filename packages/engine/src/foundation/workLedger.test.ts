import { describe, expect, it } from 'vitest';
import { withRules } from '../rules.ts';
import {
  applyFoundationWork,
  evaluateFoundationWork,
  validateFoundationWorkState,
} from './workLedger.ts';
import type {
  FoundationWorkContext,
  FoundationWorkError,
  FoundationWorkRequest,
  FoundationWorkState,
  NodeWorkSpend,
} from './workLedger.ts';

function initial(): FoundationWorkState {
  return {
    version: 0,
    commandPoints: { A: 30, B: 20 },
    nodeSpending: [],
    engineerSpending: [],
    receipts: [],
  };
}

function facts(): FoundationWorkContext {
  return {
    ownerTurn: { team: 'A', id: 'A-turn-1' },
    nodes: [
      { id: 'node', mainHex: 'main', owner: 'A' },
      { id: 'other-node', mainHex: 'main', owner: 'A' },
    ],
    targets: [
      { id: 'annex-1', kind: 'build', nodeId: 'node', cpCost: 3, engineerRequired: false },
      { id: 'annex-2', kind: 'build', nodeId: 'node', cpCost: 3, engineerRequired: false },
      { id: 'annex-3', kind: 'build', nodeId: 'node', cpCost: 3, engineerRequired: false },
      { id: 'center', kind: 'upgrade', nodeId: 'node', cpCost: 5, engineerRequired: true },
      { id: 'specialty', kind: 'build', nodeId: 'node', cpCost: 5, engineerRequired: true },
      { id: 'ruined-annex', kind: 'repair-building', nodeId: 'node', cpCost: 2 },
      { id: 'ruined-center', kind: 'repair-building', nodeId: 'node', cpCost: 2 },
      { id: 'road', kind: 'repair-road', mainHex: 'main', cpCost: 2 },
      { id: 'other-annex', kind: 'build', nodeId: 'other-node', cpCost: 3, engineerRequired: true },
    ],
    holders: [
      {
        id: 'commander',
        team: 'A',
        kind: 'commander',
        at: 'main',
        units: [1, 2, 3].map((n) => ({
          id: `engineer-${n}`,
          typeId: 'ww2_engineer',
          hp: 10,
          label: `Engineer ${n}`,
        })),
      },
    ],
  };
}

function request(
  state: FoundationWorkState,
  overrides: Partial<FoundationWorkRequest> = {},
): FoundationWorkRequest {
  return {
    requestId: `request-${state.version}`,
    expectedVersion: state.version,
    ownerTurnId: 'A-turn-1',
    team: 'A',
    kind: 'build',
    targetId: 'annex-1',
    engineerUnitId: null,
    ...overrides,
  };
}

function apply(
  state: FoundationWorkState,
  overrides: Partial<FoundationWorkRequest> = {},
  context = facts(),
): FoundationWorkState {
  const result = applyFoundationWork(state, request(state, overrides), context);
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  expect(validateFoundationWorkState(result.state)).toBeNull();
  return result.state;
}

function rejects(
  state: FoundationWorkState,
  overrides: Partial<FoundationWorkRequest>,
  code: FoundationWorkError,
  context = facts(),
): void {
  const before = JSON.stringify(state);
  const result = applyFoundationWork(state, request(state, overrides), context);
  expect(result).toMatchObject({ ok: false, code });
  expect(result.state).toBe(state);
  expect(JSON.stringify(state)).toBe(before);
}

function activation(state = initial()): FoundationWorkState {
  const spend: NodeWorkSpend = {
    nodeId: 'node',
    team: 'A',
    ownerTurnId: 'A-turn-1',
    ordinarySpent: false,
    operationCount: 0,
    activationClosed: true,
    activationRepairSpent: false,
  };
  return { ...state, nodeSpending: [spend] };
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: foundation work accounting', () => {
  it('requires an engineer for a second ordinary build and caps building work at two', () => {
    let state = apply(initial());
    expect(state.commandPoints).toEqual({ A: 27, B: 20 });
    expect(state.nodeSpending[0]).toMatchObject({ ordinarySpent: true, operationCount: 1 });
    rejects(state, { targetId: 'annex-2' }, 'engineer-required');
    state = apply(state, { targetId: 'annex-2', engineerUnitId: 'engineer-1' });
    expect(state.nodeSpending[0].operationCount).toBe(2);
    expect(state.engineerSpending).toHaveLength(1);
    rejects(state, { targetId: 'annex-3', engineerUnitId: 'engineer-2' }, 'node-limit');
    state = apply(state, { kind: 'repair-road', targetId: 'road', engineerUnitId: 'engineer-2' });
    expect(state.nodeSpending[0].operationCount).toBe(2);
    expect(state.commandPoints.A).toBe(22);
    expect(state.receipts.at(-1)).toMatchObject({ nodeId: null, nodeOperationsSpent: 0 });
  });

  it('leaves ordinary allowance available after an engineer-required center upgrade', () => {
    const upgraded = apply(initial(), {
      kind: 'upgrade',
      targetId: 'center',
      engineerUnitId: 'engineer-1',
    });
    expect(upgraded.nodeSpending[0]).toMatchObject({ ordinarySpent: false, operationCount: 1 });
    const built = apply(upgraded);
    expect(built.nodeSpending[0]).toMatchObject({ ordinarySpent: true, operationCount: 2 });
    expect(built.engineerSpending).toHaveLength(1);
  });

  it('requires an engineer for specialty work even with an unused ordinary allowance', () => {
    rejects(initial(), { targetId: 'specialty' }, 'engineer-required');
    const built = apply(initial(), { targetId: 'specialty', engineerUnitId: 'engineer-1' });
    expect(built.nodeSpending[0].ordinarySpent).toBe(false);
  });

  it('uses ordinary allowance first even when an engineer is supplied for ordinary work', () => {
    const built = apply(initial(), { engineerUnitId: 'engineer-1' });
    expect(built.receipts[0]).toMatchObject({ allowance: 'ordinary', engineerUnitId: null });
    expect(built.engineerSpending).toEqual([]);
  });

  it('allows either repair order and charges engineer plus node operation for each', () => {
    for (const order of [
      ['ruined-annex', 'ruined-center'],
      ['ruined-center', 'ruined-annex'],
    ]) {
      let state = initial();
      for (const [i, targetId] of order.entries()) {
        state = apply(state, {
          kind: 'repair-building',
          targetId,
          engineerUnitId: `engineer-${i + 1}`,
        });
      }
      expect(state.nodeSpending[0]).toMatchObject({ ordinarySpent: false, operationCount: 2 });
      expect(state.commandPoints.A).toBe(26);
    }
    // Building effects and the operational-center gate are evaluated outside this ledger.
  });

  it('allows only one engineer repair after activation and no build or upgrade', () => {
    const start = activation();
    rejects(start, {}, 'activation-closed');
    rejects(
      start,
      { kind: 'upgrade', targetId: 'center', engineerUnitId: 'engineer-1' },
      'activation-closed',
    );
    rejects(start, { kind: 'repair-building', targetId: 'ruined-annex' }, 'engineer-required');
    const repaired = apply(start, {
      kind: 'repair-building',
      targetId: 'ruined-annex',
      engineerUnitId: 'engineer-1',
    });
    expect(repaired.nodeSpending[0]).toMatchObject({
      activationClosed: true,
      activationRepairSpent: true,
      operationCount: 1,
    });
    rejects(
      repaired,
      { kind: 'repair-building', targetId: 'ruined-center', engineerUnitId: 'engineer-2' },
      'activation-repair-spent',
    );
    const road = apply(repaired, {
      kind: 'repair-road',
      targetId: 'road',
      engineerUnitId: 'engineer-2',
    });
    expect(road.nodeSpending).toEqual(repaired.nodeSpending);
  });

  it('accepts a living garrisoned engineer in the MainHex without node-local coordinates', () => {
    const context = facts();
    const garrison: FoundationWorkContext = {
      ...context,
      holders: [{ ...context.holders[0], id: 'tile-garrison', kind: 'garrison' }],
    };
    expect(
      apply(
        initial(),
        { kind: 'upgrade', targetId: 'center', engineerUnitId: 'engineer-1' },
        garrison,
      ).engineerSpending[0].unitId,
    ).toBe('engineer-1');
  });

  it('honors a rules override disabling engineer status and restores the normal scope', () => {
    const work: Partial<FoundationWorkRequest> = {
      kind: 'upgrade',
      targetId: 'center',
      engineerUnitId: 'engineer-1',
    };
    withRules({ units: { ww2_engineer: { engineer: false } } }, () => {
      rejects(initial(), work, 'ineligible-engineer');
    });
    expect(apply(initial(), work).engineerSpending[0].unitId).toBe('engineer-1');
  });

  it('honors a rules override granting engineer status to an existing unit type', () => {
    const context = facts();
    const ordinaryUnitContext: FoundationWorkContext = {
      ...context,
      holders: [
        {
          ...context.holders[0],
          units: [{ ...context.holders[0].units[0], typeId: 'ww2_rifle_infantry' }],
        },
      ],
    };
    const work: Partial<FoundationWorkRequest> = {
      kind: 'upgrade',
      targetId: 'center',
      engineerUnitId: 'engineer-1',
    };
    rejects(initial(), work, 'ineligible-engineer', ordinaryUnitContext);
    withRules({ units: { ww2_rifle_infantry: { engineer: true } } }, () => {
      expect(apply(initial(), work, ordinaryUnitContext).engineerSpending[0].unitId).toBe(
        'engineer-1',
      );
    });
    rejects(initial(), work, 'ineligible-engineer', ordinaryUnitContext);
  });

  it.each(['enemy', 'dead', 'adjacent', 'non-engineer', 'missing'] as const)(
    'refuses a selected %s engineer without any spend',
    (invalid) => {
      const context = facts();
      const holder = context.holders[0];
      const unit = holder.units[0];
      const invalidHolder = {
        ...holder,
        team: invalid === 'enemy' ? ('B' as const) : holder.team,
        at: invalid === 'adjacent' ? 'neighbor-main' : holder.at,
        units:
          invalid === 'missing'
            ? []
            : [
                {
                  ...unit,
                  hp: invalid === 'dead' ? 0 : unit.hp,
                  typeId: invalid === 'non-engineer' ? 'ww2_rifle_infantry' : unit.typeId,
                },
              ],
      };
      rejects(
        initial(),
        { kind: 'upgrade', targetId: 'center', engineerUnitId: 'engineer-1' },
        'ineligible-engineer',
        { ...context, holders: [invalidHolder] },
      );
    },
  );

  it('retains engineer spending across holder transfer, different node work and JSON round-trip', () => {
    const spent = apply(initial(), { targetId: 'specialty', engineerUnitId: 'engineer-1' });
    const restored: FoundationWorkState = JSON.parse(JSON.stringify(spent));
    const context = facts();
    const reassigned: FoundationWorkContext = {
      ...context,
      holders: [{ ...context.holders[0], id: 'new-garrison', kind: 'garrison' }],
    };
    rejects(
      restored,
      { targetId: 'other-annex', engineerUnitId: 'engineer-1' },
      'engineer-spent',
      reassigned,
    );
    rejects(
      restored,
      { kind: 'repair-road', targetId: 'road', engineerUnitId: 'engineer-1' },
      'engineer-spent',
      reassigned,
    );
  });

  it('retains node spending after losing and regaining control in the same owner turn', () => {
    const first = apply(initial());
    const spent = apply(first, { targetId: 'annex-2', engineerUnitId: 'engineer-1' });
    const context = facts();
    const enemyOwned = { ...context, nodes: [{ ...context.nodes[0], owner: 'B' as const }] };
    // Retain the full node registry to keep all target definitions valid.
    rejects(spent, { targetId: 'annex-3' }, 'not-owner', {
      ...enemyOwned,
      nodes: [enemyOwned.nodes[0], context.nodes[1]],
    });
    rejects(
      JSON.parse(JSON.stringify(spent)),
      { targetId: 'annex-3', engineerUnitId: 'engineer-2' },
      'node-limit',
      context,
    );
  });

  it('does not let a request invent a fresh turn token to replenish actions', () => {
    const spent = apply(initial(), { targetId: 'specialty', engineerUnitId: 'engineer-1' });
    rejects(
      spent,
      {
        ownerTurnId: 'invented-turn',
        kind: 'repair-road',
        targetId: 'road',
        engineerUnitId: 'engineer-1',
      },
      'invalid-request',
    );
  });

  it('replays the original receipt once without applying CP or actions again', () => {
    const start = initial();
    const original = request(start, { targetId: 'specialty', engineerUnitId: 'engineer-1' });
    const first = applyFoundationWork(start, original, facts());
    if (!first.ok) throw new Error(first.reason);
    const restored: FoundationWorkState = JSON.parse(JSON.stringify(first.state));
    const replayed = applyFoundationWork(restored, original, facts());
    expect(replayed).toMatchObject({ ok: true, replayed: true, receipt: first.receipt });
    expect(replayed.state).toBe(restored);
    rejects(restored, { requestId: original.requestId, targetId: 'annex-2' }, 'request-conflict');
  });

  it('rejects stale versions, unaffordable work and unknown targets atomically', () => {
    const state = apply(initial());
    rejects(state, { expectedVersion: 0, requestId: 'stale' }, 'stale-version');
    rejects({ ...initial(), commandPoints: { A: 2, B: 20 } }, {}, 'insufficient-cp');
    rejects(initial(), { targetId: 'missing' }, 'unknown-target');
  });

  it('rejects malformed facts and corrupted durable records instead of refreshing them', () => {
    const context = facts();
    rejects(initial(), {}, 'invalid-context', {
      ...context,
      holders: [context.holders[0], { ...context.holders[0], id: 'duplicate-units' }],
    });
    rejects(initial(), {}, 'invalid-context', {
      ...context,
      targets: [{ ...context.targets[0], cpCost: Number.NaN }],
    });
    const spent = apply(initial(), { targetId: 'specialty', engineerUnitId: 'engineer-1' });
    rejects({ ...spent, engineerSpending: [] }, {}, 'invalid-state');
    rejects(
      { ...spent, nodeSpending: [{ ...spent.nodeSpending[0], operationCount: 0 }] },
      {},
      'invalid-state',
    );
  });

  it('rejects spent node allowances with a zero operation count even without receipts', () => {
    const base = activation().nodeSpending[0];
    for (const spend of [
      { ...base, activationClosed: false, ordinarySpent: true },
      { ...base, activationRepairSpent: true },
    ]) {
      const corrupt: FoundationWorkState = { ...initial(), nodeSpending: [spend] };
      expect(validateFoundationWorkState(corrupt)).toBe('Invalid node work record');
      rejects(corrupt, {}, 'invalid-state');
    }
  });

  it('requires exact whole CP and rejects huge balances or costs instead of recording a no-op spend', () => {
    const context = facts();
    const costOne: FoundationWorkContext = {
      ...context,
      targets: [{ ...context.targets[0], cpCost: 1 }],
    };
    const maximum: FoundationWorkState = {
      ...initial(),
      commandPoints: { A: Number.MAX_SAFE_INTEGER, B: 0 },
    };
    const charged = apply(maximum, {}, costOne);
    expect(charged.commandPoints.A).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(maximum.commandPoints.A - charged.commandPoints.A).toBe(1);
    expect(charged.receipts[0].cpSpent).toBe(1);
    rejects({ ...initial(), commandPoints: { A: 1e20, B: 0 } }, {}, 'invalid-state');
    rejects(initial(), {}, 'invalid-context', {
      ...context,
      targets: [{ ...context.targets[0], cpCost: 1e20 }],
    });
    rejects(initial(), {}, 'invalid-context', {
      ...context,
      targets: [{ ...context.targets[0], cpCost: 0.1 }],
    });
  });

  it('explicitly rejects .9 and .1 CP prices without silently rounding either', () => {
    const state: FoundationWorkState = { ...initial(), commandPoints: { A: 1, B: 0 } };
    const context = facts();
    for (const cpCost of [0.9, 0.1]) {
      rejects(
        state,
        { kind: 'repair-road', targetId: 'road', engineerUnitId: 'engineer-1' },
        'invalid-context',
        {
          ...context,
          targets: [{ id: 'road', kind: 'repair-road', mainHex: 'main', cpCost }],
        },
      );
    }
    rejects({ ...state, commandPoints: { A: 0.1, B: 0 } }, {}, 'invalid-state');
    const spent = apply(initial());
    rejects({ ...spent, receipts: [{ ...spent.receipts[0], cpSpent: 0.9 }] }, {}, 'invalid-state');
  });

  it('keeps positive fractional HP separate from whole-CP validation', () => {
    const context = facts();
    const lowHp: FoundationWorkContext = {
      ...context,
      holders: [
        {
          ...context.holders[0],
          units: [{ ...context.holders[0].units[0], hp: 0.25 }],
        },
      ],
    };
    expect(
      apply(
        initial(),
        { kind: 'repair-road', targetId: 'road', engineerUnitId: 'engineer-1' },
        lowHp,
      ).engineerSpending[0].unitId,
    ).toBe('engineer-1');
  });

  it('rejects distinct receipts claiming one version while allowing external version gaps', () => {
    const first = apply(initial());
    // Other engine changes can advance the shared state version without spending work.
    const externallyAdvanced: FoundationWorkState = { ...first, version: 3 };
    const second = apply(externallyAdvanced, {
      targetId: 'annex-2',
      engineerUnitId: 'engineer-1',
    });
    expect(second.receipts.map((receipt) => receipt.resultingVersion)).toEqual([1, 4]);
    expect(validateFoundationWorkState(second)).toBeNull();
    const conflictingVersion: FoundationWorkState = {
      ...second,
      receipts: [
        second.receipts[0],
        {
          ...second.receipts[1],
          request: { ...second.receipts[1].request, expectedVersion: 0 },
          resultingVersion: 1,
        },
      ],
    };
    expect(validateFoundationWorkState(conflictingVersion)).toBe('Duplicate work receipt version');
    rejects(conflictingVersion, { targetId: 'annex-3' }, 'invalid-state');
  });

  it('does not mutate state, requests or trusted facts when evaluating or applying', () => {
    const start = initial();
    const context = facts();
    const action = request(start, { targetId: 'specialty', engineerUnitId: 'engineer-1' });
    const before = JSON.stringify({ start, context, action });
    const planned = evaluateFoundationWork(start, action, context);
    expect(planned).toMatchObject({ ok: true, replayed: false });
    const result = applyFoundationWork(start, action, context);
    expect(result.ok).toBe(true);
    expect(JSON.stringify({ start, context, action })).toBe(before);
  });

  it('does not expose Capture/Raze or turn-transition policies as accepted work kinds', () => {
    for (const kind of ['capture', 'raze', 'activate']) {
      rejects(initial(), { kind: kind as FoundationWorkRequest['kind'] }, 'invalid-request');
    }
  });

  it('defaults legacy work records to open and validates explicit acquisition windows', () => {
    const legacy = activation();
    const open = {
      ...legacy,
      nodeSpending: [{ ...legacy.nodeSpending[0], activationClosed: false }],
    };
    expect(apply(open).nodeSpending[0]).toMatchObject({ ordinarySpent: true, operationCount: 1 });
    expect(
      validateFoundationWorkState({
        ...open,
        nodeSpending: [{ ...open.nodeSpending[0], buildingWindow: 'closed' }],
      }),
    ).toBeNull();
    const corrupt = {
      ...open,
      nodeSpending: [{ ...open.nodeSpending[0], buildingWindow: 'later' }],
    } as unknown as FoundationWorkState;
    expect(validateFoundationWorkState(corrupt)).toBe('Invalid node work record');
    rejects(corrupt, {}, 'invalid-state');
  });
});

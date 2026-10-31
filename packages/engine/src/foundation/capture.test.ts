import { describe, expect, it } from 'vitest';
import {
  beginFoundationCapture,
  chooseFoundationCapture,
  commitFoundationCapture,
  currentFoundationCaptureChoices,
  validateFoundationCaptureCosts,
  validateFoundationCaptureState,
} from './capture.ts';
import type {
  FoundationCaptureContext,
  FoundationCaptureEvent,
  FoundationCaptureFacts,
  FoundationCaptureNode,
  FoundationCaptureOutcome,
  FoundationCaptureResult,
  FoundationCaptureState,
} from './capture.ts';
import { applyFoundationWork, validateFoundationWorkState } from './workLedger.ts';
import type { FoundationWorkContext } from './workLedger.ts';

const TURN = { team: 'A' as const, id: 'A-turn-1' };

function initial(): FoundationCaptureState {
  return {
    version: 0,
    work: {
      version: 0,
      commandPoints: { A: 40, B: 17 },
      nodeSpending: [],
      engineerSpending: [],
      receipts: [],
    },
    nodes: ['node-1', 'node-2'].map<FoundationCaptureNode>((id) => ({
      id,
      mainHex: `main-${id}`,
      centerSubHex: `center-${id}`,
      owner: 'B',
      buildings: [
        {
          id: `${id}-center`,
          ruined: false,
          data: { role: 'military', tier: 2, upgrades: ['signal'], equipment: ['retained-gear'] },
        },
        {
          id: `${id}-annex`,
          ruined: true,
          data: { role: 'barracks', tier: 1, upgrades: [], equipment: [] },
        },
      ],
    })),
    pending: null,
    receipts: [],
  };
}

function facts(nodeId = 'node-1'): FoundationCaptureFacts {
  return {
    nodeId,
    liveGarrisonUnitIds: [],
    liveCenterOccupants: [{ unitId: `attacker-${nodeId}`, team: 'A' }],
    liveHostileMainHexUnitIds: [],
    commanders: [
      {
        id: `commander-${nodeId}`,
        team: 'A',
        mainHex: `main-${nodeId}`,
        subHex: `center-${nodeId}`,
        living: true,
      },
    ],
  };
}

function context(
  state: FoundationCaptureState,
  event: FoundationCaptureEvent = { kind: 'turn-start-after-income', incomeReceiptId: 'income-1' },
  candidates = [facts()],
): FoundationCaptureContext {
  return {
    snapshotVersion: state.version,
    ownerTurn: TURN,
    event,
    costs: { capture: 7, raze: 3 },
    candidates,
  };
}

function success(result: FoundationCaptureResult): FoundationCaptureState {
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  expect(validateFoundationCaptureState(result.state)).toBeNull();
  return result.state;
}

function begin(state = initial(), ctx = context(state)): FoundationCaptureState {
  return success(
    beginFoundationCapture(state, { requestId: 'batch', expectedVersion: state.version }, ctx),
  );
}

function choose(
  state: FoundationCaptureState,
  nodeId = 'node-1',
  outcome: FoundationCaptureOutcome = 'capture',
): FoundationCaptureState {
  return success(
    chooseFoundationCapture(state, {
      requestId: `choose-${nodeId}`,
      expectedVersion: state.version,
      batchId: 'batch',
      nodeId,
      outcome,
    }),
  );
}

function commit(state: FoundationCaptureState): FoundationCaptureResult {
  return commitFoundationCapture(
    state,
    { requestId: 'commit', expectedVersion: state.version, batchId: 'batch' },
    { snapshotVersion: state.version, ownerTurn: TURN },
  );
}

function captured(event: FoundationCaptureEvent): FoundationCaptureState {
  const state = initial();
  return success(commit(choose(begin(state, context(state, event)))));
}

function workContext(state: FoundationCaptureState): FoundationWorkContext {
  return {
    ownerTurn: TURN,
    nodes: state.nodes,
    targets: [
      { id: 'annex-1', kind: 'build', nodeId: 'node-1', engineerRequired: false, cpCost: 1 },
      { id: 'annex-2', kind: 'build', nodeId: 'node-1', engineerRequired: false, cpCost: 1 },
      { id: 'center', kind: 'upgrade', nodeId: 'node-1', engineerRequired: true, cpCost: 1 },
      { id: 'ruins', kind: 'repair-building', nodeId: 'node-1', cpCost: 1 },
      { id: 'road', kind: 'repair-road', mainHex: 'main-node-1', cpCost: 1 },
    ],
    holders: [
      {
        id: 'engineers',
        team: 'A',
        kind: 'commander',
        at: 'main-node-1',
        units: [1, 2].map((n) => ({
          id: `engineer-${n}`,
          typeId: 'ww2_engineer',
          hp: 10,
          label: 'Engineer',
        })),
      },
    ],
  };
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: atomic Capture/Raze controller', () => {
  it('grants an unspent building window after income without issuing income or deployment', () => {
    const state = captured({ kind: 'turn-start-after-income', incomeReceiptId: 'income-1' });
    expect(state.work.commandPoints).toEqual({ A: 33, B: 17 });
    expect(state.nodes[0].owner).toBe('A');
    expect(state.nodes[0].buildings).toEqual(initial().nodes[0].buildings);
    expect(state.work.nodeSpending[0]).toEqual({
      nodeId: 'node-1',
      team: 'A',
      ownerTurnId: TURN.id,
      ordinarySpent: false,
      operationCount: 0,
      activationClosed: false,
      activationRepairSpent: false,
      buildingWindow: 'open',
    });
    expect(state.work.engineerSpending).toEqual([]);
    expect(state.work.receipts).toEqual([]);
    expect(state.receipts[0]).toMatchObject({
      cpSpent: 7,
      recomputeNetworkEffects: true,
      changes: [
        {
          buildingWindow: 'open',
          sameCycleIncome: false,
          sameCycleDeployment: false,
          sameCycleResupply: false,
        },
      ],
    });

    let work = state.work;
    for (const [i, targetId] of ['annex-1', 'annex-2'].entries()) {
      const result = applyFoundationWork(
        work,
        {
          requestId: `build-${i}`,
          expectedVersion: work.version,
          ownerTurnId: TURN.id,
          team: 'A',
          kind: 'build',
          targetId,
          engineerUnitId: i === 0 ? null : 'engineer-1',
        },
        workContext(state),
      );
      if (!result.ok) throw new Error(result.reason);
      work = result.state;
    }
    expect(work.nodeSpending[0]).toMatchObject({ ordinarySpent: true, operationCount: 2 });
    const third = applyFoundationWork(
      work,
      {
        requestId: 'third',
        expectedVersion: work.version,
        ownerTurnId: TURN.id,
        team: 'A',
        kind: 'build',
        targetId: 'annex-1',
        engineerUnitId: 'engineer-2',
      },
      workContext(state),
    );
    expect(third).toMatchObject({ ok: false, code: 'node-limit' });
  });

  it.each([
    { kind: 'manual-battle-end', battleId: 'battle-1' },
    { kind: 'strategic-movement', movementReceiptId: 'movement-1' },
  ] as const)(
    'closes late-capture building work for $kind, while preserving outside-cap road repair',
    (event) => {
      const state = captured(event);
      expect(state.work.nodeSpending[0]).toMatchObject({
        ordinarySpent: false,
        operationCount: 0,
        buildingWindow: 'closed',
      });
      expect(validateFoundationWorkState(state.work)).toBeNull();
      for (const [kind, targetId] of [
        ['build', 'annex-1'],
        ['upgrade', 'center'],
        ['repair-building', 'ruins'],
      ] as const) {
        const result = applyFoundationWork(
          state.work,
          {
            requestId: `blocked-${kind}`,
            expectedVersion: state.version,
            ownerTurnId: TURN.id,
            team: 'A',
            kind,
            targetId,
            engineerUnitId: 'engineer-1',
          },
          workContext(state),
        );
        expect(result).toMatchObject({ ok: false, code: 'building-window-closed' });
        expect(result.state).toBe(state.work);
      }
      const road = applyFoundationWork(
        state.work,
        {
          requestId: 'road',
          expectedVersion: state.version,
          ownerTurnId: TURN.id,
          team: 'A',
          kind: 'repair-road',
          targetId: 'road',
          engineerUnitId: 'engineer-1',
        },
        workContext(state),
      );
      expect(road).toMatchObject({ ok: true, state: { commandPoints: { A: 32 } } });
      expect(state.receipts[0].changes[0]).toMatchObject({
        sameCycleIncome: false,
        sameCycleDeployment: false,
        sameCycleResupply: false,
        buildingWindow: 'closed',
      });
    },
  );

  it('commits independent Capture and Raze together, summing CP without node operations', () => {
    const original = initial();
    const ctx = context(original, { kind: 'manual-battle-end', battleId: 'battle-1' }, [
      facts(),
      facts('node-2'),
    ]);
    const before = JSON.stringify({ original, ctx });
    let state = begin(original, ctx);
    state = choose(state);
    const incomplete = commit(state);
    expect(incomplete).toMatchObject({ ok: false, code: 'incomplete-choices' });
    expect(incomplete.state).toBe(state);
    expect(state.nodes.map((n) => n.owner)).toEqual(['B', 'B']);
    expect(state.work.commandPoints.A).toBe(40);
    state = choose(state, 'node-2', 'raze');
    const result = commit(state);
    state = success(result);
    expect(state.work.commandPoints).toEqual({ A: 30, B: 17 });
    expect(state.nodes.map((n) => n.owner)).toEqual(['A', null]);
    expect(state.nodes[0].buildings).toEqual(original.nodes[0].buildings);
    expect(state.nodes[1].buildings.every((b) => b.ruined)).toBe(true);
    expect(state.nodes[1].buildings.map((b) => b.data)).toEqual(
      original.nodes[1].buildings.map((b) => b.data),
    );
    expect(state.work.nodeSpending).toHaveLength(1);
    expect(state.work.nodeSpending[0]).toMatchObject({
      nodeId: 'node-1',
      operationCount: 0,
      ordinarySpent: false,
    });
    expect(state.receipts[0].changes[1]).toMatchObject({
      outcome: 'raze',
      buildingWindow: 'unchanged',
      owner: null,
      cpSpent: 3,
    });
    expect(JSON.stringify({ original, ctx })).toBe(before);
  });

  it('leaves Raze outside exhausted node/engineer work limits and preserves all prior receipts', () => {
    const source = initial();
    const work = {
      ...source.work,
      nodeSpending: [
        {
          nodeId: 'node-1',
          team: 'A' as const,
          ownerTurnId: TURN.id,
          operationCount: 2,
          ordinarySpent: true,
          activationClosed: false,
          activationRepairSpent: false,
          buildingWindow: 'closed' as const,
        },
      ],
      engineerSpending: [
        { unitId: 'engineer-1', team: 'A' as const, ownerTurnId: TURN.id, receiptId: 'old-spend' },
      ],
    };
    const state = success(commit(choose(begin({ ...source, work }), 'node-1', 'raze')));
    expect(state.work.nodeSpending).toEqual(work.nodeSpending);
    expect(state.work.engineerSpending).toEqual(work.engineerSpending);
    expect(state.nodes[0].owner).toBeNull();
    expect(state.work.commandPoints.A).toBe(37);
  });

  it('never resets current or historical work counts on acquisition', () => {
    const source = initial();
    const previous = {
      nodeId: 'node-1',
      team: 'A' as const,
      ownerTurnId: TURN.id,
      operationCount: 1,
      ordinarySpent: true,
      activationClosed: false,
      activationRepairSpent: false,
    };
    const historical = { ...previous, ownerTurnId: 'A-turn-0', operationCount: 2 };
    const before = { ...source, work: { ...source.work, nodeSpending: [historical, previous] } };
    const state = success(
      commit(
        choose(begin(before, context(before, { kind: 'manual-battle-end', battleId: 'battle-1' }))),
      ),
    );
    expect(state.work.nodeSpending).toEqual([
      historical,
      { ...previous, buildingWindow: 'closed' },
    ]);
    expect(state.work.engineerSpending).toEqual(before.work.engineerSpending);
    expect(validateFoundationWorkState(state.work)).toBeNull();
  });

  it('does not reopen an already closed same-cycle work window through a repeated acquisition', () => {
    const source = initial();
    const spend = {
      nodeId: 'node-1',
      team: 'A' as const,
      ownerTurnId: TURN.id,
      operationCount: 0,
      ordinarySpent: false,
      activationClosed: false,
      activationRepairSpent: false,
      buildingWindow: 'closed' as const,
    };
    const state = success(
      commit(choose(begin({ ...source, work: { ...source.work, nodeSpending: [spend] } }))),
    );
    expect(state.work.nodeSpending).toEqual([spend]);
    expect(state.receipts[0].changes[0].buildingWindow).toBe('closed');
  });

  it('keeps all pending choices through JSON reload before and after completion', () => {
    const source = initial();
    const ctx = context(source, { kind: 'manual-battle-end', battleId: 'battle-1' }, [
      facts(),
      facts('node-2'),
    ]);
    let state = choose(begin(source, ctx));
    state = JSON.parse(JSON.stringify(state)) as FoundationCaptureState;
    expect(validateFoundationCaptureState(state)).toBeNull();
    expect(commit(state)).toMatchObject({ ok: false, code: 'incomplete-choices' });
    state = choose(state, 'node-2', 'raze');
    state = JSON.parse(JSON.stringify(state)) as FoundationCaptureState;
    state = success(commit(state));
    expect(state.pending).toBeNull();
    expect(state.receipts[0].batch.choices.map((c) => c.request.outcome)).toEqual([
      'capture',
      'raze',
    ]);
  });

  it('replays begin/choice/commit IDs without spending or reissuing phase benefits', () => {
    const source = initial();
    const ctx = context(source);
    let state = begin(source, ctx);
    const choiceRequest = {
      requestId: 'choose-node-1',
      expectedVersion: state.version,
      batchId: 'batch',
      nodeId: 'node-1',
      outcome: 'capture' as const,
    };
    state = success(chooseFoundationCapture(state, choiceRequest));
    const commitRequest = { requestId: 'commit', expectedVersion: state.version, batchId: 'batch' };
    state = success(
      commitFoundationCapture(state, commitRequest, {
        snapshotVersion: state.version,
        ownerTurn: TURN,
      }),
    );
    for (const result of [
      beginFoundationCapture(state, { requestId: 'batch', expectedVersion: 0 }, ctx),
      chooseFoundationCapture(state, choiceRequest),
      commitFoundationCapture(state, commitRequest, { snapshotVersion: 0, ownerTurn: TURN }),
    ]) {
      expect(result).toMatchObject({ ok: true, replayed: true });
      expect(result.state).toBe(state);
    }
    expect(state.work.commandPoints.A).toBe(33);
    expect(state.receipts).toHaveLength(1);
    expect(state.work.nodeSpending).toHaveLength(1);
    expect(
      beginFoundationCapture(
        state,
        { requestId: 'batch', expectedVersion: state.version },
        context(state),
      ),
    ).toMatchObject({ ok: false, code: 'request-conflict' });
  });

  it('fails unaffordable complete choices atomically without inventing debt, defer or skip', () => {
    const source = initial();
    const poor = { ...source, work: { ...source.work, commandPoints: { A: 2, B: 17 } } };
    let state = begin(poor, context(poor, undefined, [facts(), facts('node-2')]));
    state = choose(choose(state), 'node-2', 'raze');
    const before = JSON.stringify(state);
    const result = commit(state);
    expect(result).toMatchObject({ ok: false, code: 'insufficient-cp' });
    expect(result.state).toBe(state);
    expect(JSON.stringify(state)).toBe(before);
    expect(state.nodes.map((n) => n.owner)).toEqual(['B', 'B']);
    expect(state.pending?.choices).toHaveLength(2);
    expect(state.work.commandPoints.A).toBe(2);
  });

  it('lets an unaffordable Capture change to Raze without old-request replay rolling it back', () => {
    const source = initial();
    const poor = { ...source, work: { ...source.work, commandPoints: { A: 5, B: 17 } } };
    let state = begin(poor);
    const captureRequest = {
      requestId: 'capture-choice',
      expectedVersion: state.version,
      batchId: 'batch',
      nodeId: 'node-1',
      outcome: 'capture' as const,
    };
    state = success(chooseFoundationCapture(state, captureRequest));
    expect(commit(state)).toMatchObject({ ok: false, code: 'insufficient-cp', state });
    expect(state.work.commandPoints.A).toBe(5);

    const razeRequest = {
      ...captureRequest,
      requestId: 'revised-raze-choice',
      expectedVersion: state.version,
      outcome: 'raze' as const,
    };
    state = success(chooseFoundationCapture(state, razeRequest));
    expect(state.pending!.choices.map((c) => c.request.outcome)).toEqual(['capture', 'raze']);
    expect(currentFoundationCaptureChoices(state.pending!).map((c) => c.request.outcome)).toEqual([
      'raze',
    ]);
    for (const request of [captureRequest, razeRequest]) {
      const replay = chooseFoundationCapture(state, request);
      expect(replay).toMatchObject({ ok: true, replayed: true });
      expect(replay.state).toBe(state);
      expect(
        currentFoundationCaptureChoices(replay.ok ? replay.batch : state.pending!)[0].request
          .outcome,
      ).toBe('raze');
    }
    expect(chooseFoundationCapture(state, { ...captureRequest, outcome: 'raze' })).toMatchObject({
      ok: false,
      code: 'request-conflict',
    });

    state = JSON.parse(JSON.stringify(state)) as FoundationCaptureState;
    expect(validateFoundationCaptureState(state)).toBeNull();
    state = success(commit(state));
    expect(state.work.commandPoints.A).toBe(2);
    expect(state.nodes[0].owner).toBeNull();
    expect(state.receipts[0].cpSpent).toBe(3);
    expect(state.receipts[0].batch.choices).toHaveLength(2);
    expect(state.receipts[0].changes[0]).toMatchObject({ outcome: 'raze', cpSpent: 3 });
    expect(state.work.nodeSpending).toEqual([]);
    const committedReplay = chooseFoundationCapture(state, captureRequest);
    expect(committedReplay).toMatchObject({ ok: true, replayed: true });
    expect(committedReplay.state).toBe(state);
    expect(
      chooseFoundationCapture(state, {
        ...razeRequest,
        requestId: 'too-late',
        expectedVersion: state.version,
      }),
    ).toMatchObject({ ok: false, code: 'batch-not-found' });
  });

  it('counts current independent selections, validates their history and prices only final choices', () => {
    const source = initial();
    let state = begin(source, context(source, undefined, [facts(), facts('node-2')]));
    state = choose(state);
    state = success(
      chooseFoundationCapture(state, {
        requestId: 'revise-node-1',
        expectedVersion: state.version,
        batchId: 'batch',
        nodeId: 'node-1',
        outcome: 'raze',
      }),
    );
    // Two requests for one node do not answer the second independent choice.
    expect(state.pending!.choices).toHaveLength(2);
    expect(currentFoundationCaptureChoices(state.pending!)).toHaveLength(1);
    expect(commit(state)).toMatchObject({ ok: false, code: 'incomplete-choices' });
    const reversed = {
      ...state,
      pending: { ...state.pending!, choices: [...state.pending!.choices].reverse() },
    };
    expect(validateFoundationCaptureState(reversed)).not.toBeNull();
    const duplicate = {
      ...state,
      pending: {
        ...state.pending!,
        choices: [
          state.pending!.choices[0],
          {
            ...state.pending!.choices[1],
            request: {
              ...state.pending!.choices[1].request,
              requestId: state.pending!.choices[0].request.requestId,
            },
          },
        ],
      },
    };
    expect(validateFoundationCaptureState(duplicate)).not.toBeNull();

    state = choose(state, 'node-2');
    state = success(commit(state));
    expect(state.work.commandPoints.A).toBe(30);
    expect(state.nodes.map((n) => n.owner)).toEqual([null, 'A']);
    expect(state.receipts[0].changes.map((c) => c.outcome)).toEqual(['raze', 'capture']);
    expect(
      validateFoundationCaptureState(JSON.parse(JSON.stringify(state)) as FoundationCaptureState),
    ).toBeNull();
    expect(
      validateFoundationCaptureState({
        ...state,
        receipts: [
          {
            ...state.receipts[0],
            changes: [
              { ...state.receipts[0].changes[0], outcome: 'capture', cpSpent: 7, owner: 'A' },
              state.receipts[0].changes[1],
            ],
          },
        ],
      }),
    ).not.toBeNull();
  });

  it('requires explicit positive safe whole prices and a cheaper Raze price', () => {
    for (const costs of [
      { capture: 0, raze: 0 },
      { capture: 7, raze: 7 },
      { capture: 3, raze: 7 },
      { capture: 7.1, raze: 3 },
      { capture: 7, raze: -1 },
      { capture: Infinity, raze: 3 },
      { capture: Number.MAX_SAFE_INTEGER + 1, raze: 3 },
    ]) {
      expect(validateFoundationCaptureCosts(costs)).not.toBeNull();
      const source = initial();
      const result = beginFoundationCapture(
        source,
        { requestId: 'batch', expectedVersion: 0 },
        { ...context(source), costs },
      );
      expect(result).toMatchObject({ ok: false, code: 'invalid-profile' });
      expect(result.state).toBe(source);
    }
    expect(validateFoundationCaptureCosts({ capture: 7, raze: 3 })).toBeNull();
    const source = initial();
    const missing = { ...context(source), costs: undefined } as unknown as FoundationCaptureContext;
    expect(
      beginFoundationCapture(source, { requestId: 'batch', expectedVersion: 0 }, missing),
    ).toMatchObject({ ok: false, code: 'invalid-profile' });
  });

  it('keeps manual final-center eligibility independent of unrelated hostile survivors or a winner label', () => {
    const source = initial();
    const manual = context(source, { kind: 'manual-battle-end', battleId: 'battle-1' }, [
      { ...facts(), liveHostileMainHexUnitIds: ['unrelated-survivor'], commanders: [] },
    ]);
    expect(
      beginFoundationCapture(source, { requestId: 'batch', expectedVersion: 0 }, manual),
    ).toMatchObject({ ok: true });
    for (const evidence of [
      { ...facts(), liveCenterOccupants: [] },
      { ...facts(), liveGarrisonUnitIds: ['defender'] },
      { ...facts(), liveCenterOccupants: [{ unitId: 'enemy', team: 'B' as const }] },
    ]) {
      expect(
        beginFoundationCapture(
          source,
          { requestId: 'batch', expectedVersion: 0 },
          { ...manual, candidates: [evidence] },
        ),
      ).toMatchObject({ ok: false, code: 'ineligible-capture' });
    }
  });

  it('uses start-turn MainHex presence versus later exact center, rejecting contested strategic takeovers', () => {
    const source = initial();
    const elsewhere = {
      ...facts(),
      liveCenterOccupants: [],
      commanders: [{ ...facts().commanders[0], subHex: 'other-subhex' }],
    };
    const start = context(source, undefined, [elsewhere]);
    expect(
      beginFoundationCapture(source, { requestId: 'batch', expectedVersion: 0 }, start),
    ).toMatchObject({ ok: true });
    const later = {
      ...start,
      event: { kind: 'strategic-movement' as const, movementReceiptId: 'move-1' },
    };
    expect(
      beginFoundationCapture(source, { requestId: 'batch', expectedVersion: 0 }, later),
    ).toMatchObject({ ok: false, code: 'ineligible-capture' });
    for (const event of [start.event, later.event]) {
      const contested = context(source, event, [
        { ...facts(), liveHostileMainHexUnitIds: ['enemy-away-from-center'] },
      ]);
      expect(
        beginFoundationCapture(source, { requestId: 'batch', expectedVersion: 0 }, contested),
      ).toMatchObject({ ok: false, code: 'ineligible-capture' });
    }
    for (const commander of [
      { ...facts().commanders[0], living: false },
      { ...facts().commanders[0], team: 'B' as const },
      { ...facts().commanders[0], mainHex: 'other-main' },
    ]) {
      expect(
        beginFoundationCapture(
          source,
          { requestId: 'batch', expectedVersion: 0 },
          { ...start, candidates: [{ ...facts(), commanders: [commander] }] },
        ),
      ).toMatchObject({ ok: false, code: 'ineligible-capture' });
    }
  });

  it('rejects invalid phase proof, auto-resolve, stale context and mismatched commit owner-turn', () => {
    const source = initial();
    for (const event of [
      { kind: 'turn-start-before-income', incomeReceiptId: 'not-paid' },
      { kind: 'turn-start-after-income', incomeReceiptId: '' },
      { kind: 'auto-resolve', battleId: 'auto' },
    ]) {
      const invalid = { ...context(source), event } as unknown as FoundationCaptureContext;
      expect(
        beginFoundationCapture(source, { requestId: 'batch', expectedVersion: 0 }, invalid),
      ).toMatchObject({ ok: false, code: 'invalid-context' });
    }
    expect(
      beginFoundationCapture(
        source,
        { requestId: 'batch', expectedVersion: 0 },
        { ...context(source), snapshotVersion: 2 },
      ),
    ).toMatchObject({ ok: false, code: 'invalid-context' });
    const state = choose(begin());
    const request = { requestId: 'commit', expectedVersion: state.version, batchId: 'batch' };
    expect(
      commitFoundationCapture(state, request, {
        snapshotVersion: state.version,
        ownerTurn: { team: 'B', id: TURN.id },
      }),
    ).toMatchObject({ ok: false, code: 'invalid-context' });
    expect(
      commitFoundationCapture(state, request, {
        snapshotVersion: state.version,
        ownerTurn: { ...TURN, id: 'A-turn-2' },
      }),
    ).toMatchObject({ ok: false, code: 'invalid-context' });
  });

  it('rejects stale snapshots, conflicting request IDs and altered node data without partial mutation', () => {
    let state = begin();
    expect(
      chooseFoundationCapture(state, {
        requestId: 'stale',
        expectedVersion: 0,
        batchId: 'batch',
        nodeId: 'node-1',
        outcome: 'capture',
      }),
    ).toMatchObject({ ok: false, code: 'stale-version' });
    state = choose(state);
    expect(
      chooseFoundationCapture(state, {
        requestId: 'choose-node-1',
        expectedVersion: state.version,
        batchId: 'batch',
        nodeId: 'node-1',
        outcome: 'raze',
      }),
    ).toMatchObject({ ok: false, code: 'request-conflict' });
    const changed = {
      ...state,
      nodes: state.nodes.map((n, i) => (i === 0 ? { ...n, owner: null } : n)),
    };
    const result = commit(changed);
    expect(result).toMatchObject({ ok: false, code: 'stale-version' });
    expect(result.state).toBe(changed);
  });

  it('validates saved receipts and rejects clock skew, tampered costs and invalid pending evidence', () => {
    const state = captured({ kind: 'turn-start-after-income', incomeReceiptId: 'income-1' });
    expect(
      validateFoundationCaptureState({
        ...state,
        work: { ...state.work, version: state.version + 1 },
      }),
    ).not.toBeNull();
    expect(
      validateFoundationCaptureState({
        ...state,
        receipts: [{ ...state.receipts[0], cpSpent: 1 }],
      }),
    ).not.toBeNull();
    const pending = begin();
    const damaged = {
      ...pending,
      pending: {
        ...pending.pending!,
        candidates: [
          {
            ...pending.pending!.candidates[0],
            facts: { ...facts(), liveGarrisonUnitIds: ['survivor'] },
          },
        ],
      },
    };
    expect(validateFoundationCaptureState(damaged)).not.toBeNull();
    expect(commit(damaged)).toMatchObject({ ok: false, code: 'invalid-state' });
  });
});

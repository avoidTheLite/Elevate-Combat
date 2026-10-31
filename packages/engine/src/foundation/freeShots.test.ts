import { describe, expect, it, vi } from 'vitest';
import { resolveAttack } from '../combat.ts';
import { flatBattle, mkUnit, scriptedRng } from '../testBattle.ts';
import type { Battle } from '../types.ts';
import {
  beginFreeShotBoundary,
  createFreeShotState,
  getFreeShotPrompt,
  openFreeShotCycle,
  resolveSelectedFreeShot,
  selectFreeShotTarget,
  validateFreeShotFrame,
  validateFreeShotState,
} from './freeShots.ts';
import type {
  BeginFreeShotBoundaryRequest,
  FreeShotActor,
  FreeShotAdapter,
  FreeShotFrame,
  FreeShotResult,
  FreeShotState,
  ResolveFreeShotRequest,
  SelectFreeShotTargetRequest,
} from './freeShots.ts';

function actor(
  id: string,
  team: 'A' | 'B',
  subHex: string,
  kind: FreeShotActor['kind'] = 'unit',
): FreeShotActor {
  return {
    id,
    team,
    subHex,
    kind,
    alive: true,
    normalActions: { mp: 4, acted: false, moved: false },
  };
}
function frame(
  actors: readonly FreeShotActor[] = [
    actor('guard', 'A', '0,0', 'stationed-unit'),
    actor('commander', 'B', '1,0', 'commander'),
    actor('enemy', 'B', '2,0'),
  ],
  legalTargets: FreeShotFrame['legalTargets'] = [
    { shooterId: 'guard', targetId: 'commander' },
    { shooterId: 'guard', targetId: 'enemy' },
  ],
): FreeShotFrame {
  return { revision: 0, rngState: 0, actors, legalTargets };
}
function stateOf(result: FreeShotResult): FreeShotState {
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  expect(validateFreeShotState(result.state)).toBeNull();
  return result.state;
}
function opened(): FreeShotState {
  let state = stateOf(
    openFreeShotCycle(createFreeShotState(), { expectedVersion: 0, team: 'A', ownerCycleId: 'A1' }),
  );
  state = stateOf(
    openFreeShotCycle(state, { expectedVersion: state.version, team: 'B', ownerCycleId: 'B1' }),
  );
  return state;
}
function boundaryRequest(
  state: FreeShotState,
  id = 'battle',
  strategic = false,
): BeginFreeShotBoundaryRequest {
  return {
    expectedVersion: state.version,
    boundaryId: id,
    trigger: strategic ? 'strategic-after-income' : 'tactical-after-deployment',
    strategicOwner: strategic ? 'A' : null,
  };
}
function begin(
  snapshot = frame(),
  id = 'battle',
  strategic = false,
  state = opened(),
): FreeShotState {
  return stateOf(beginFreeShotBoundary(state, boundaryRequest(state, id, strategic), snapshot));
}
function selectionRequest(
  state: FreeShotState,
  targetId: string,
  requestId = 'selection',
): SelectFreeShotTargetRequest {
  const prompt = getFreeShotPrompt(state);
  if (!prompt.ok || prompt.status === 'complete') throw new Error('Expected a free-shot prompt');
  return {
    requestId,
    expectedVersion: state.version,
    boundaryId: prompt.boundaryId,
    team: prompt.team,
    ownerCycleId: prompt.ownerCycleId,
    shooterId: prompt.shooterId,
    targetId,
  };
}
function choose(state: FreeShotState, targetId: string, id = 'selection'): FreeShotState {
  return stateOf(selectFreeShotTarget(state, selectionRequest(state, targetId, id)));
}
function resolveRequest(state: FreeShotState, requestId = 'resolution'): ResolveFreeShotRequest {
  if (!state.pending?.selectionId) throw new Error('Expected a selected target');
  return { requestId, expectedVersion: state.version, selectionId: state.pending.selectionId };
}
function outcome(kill: readonly string[] = []): FreeShotAdapter {
  return ({ frame: snapshot, selection }) => ({
    ok: true,
    outcomeId: `outcome-${selection.request.requestId}`,
    frame: {
      ...structuredClone(snapshot),
      revision: snapshot.revision + 1,
      rngState: (snapshot.rngState + 1) >>> 0,
      actors: snapshot.actors.map((a) => ({
        ...a,
        normalActions: a.normalActions === null ? null : { ...a.normalActions },
        alive: a.alive && !kill.includes(a.id),
      })),
    },
  });
}
function failure(result: FreeShotResult, input: FreeShotState, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected rejection');
  expect(result.code).toBe(code);
  expect(result.state).toBe(input);
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: sequential garrison free shots', () => {
  it('waits for an explicit owner-selected target rather than choosing a commander or troop', () => {
    const initial = begin();
    const before = JSON.stringify(initial);
    const prompt = getFreeShotPrompt(initial);
    expect(prompt).toMatchObject({
      ok: true,
      status: 'choose-target',
      shooterId: 'guard',
      targetIds: ['enemy'],
    });
    expect(initial.receipts).toHaveLength(0);
    expect(initial.pending?.selectionId).toBeNull();
    expect(JSON.stringify(initial)).toBe(before);
    const selected = choose(initial, 'enemy');
    expect(getFreeShotPrompt(selected)).toMatchObject({
      status: 'selected',
      selection: { request: { targetId: 'enemy' } },
    });
    expect(selected.receipts).toHaveLength(0);
  });

  it('filters strategic targets to enemy commanders and preserves the explicit choice', () => {
    const initial = begin(frame(), 'owner-start', true);
    expect(getFreeShotPrompt(initial)).toMatchObject({ targetIds: ['commander'] });
    failure(
      selectFreeShotTarget(initial, selectionRequest(initial, 'enemy')),
      initial,
      'illegal-target',
    );
    const selected = choose(initial, 'commander');
    const command = resolveRequest(selected);
    const result = resolveSelectedFreeShot(selected, command, outcome());
    const final = stateOf(result);
    expect(final.receipts[0]).toMatchObject({
      targetId: 'commander',
      trigger: 'strategic-after-income',
      ownerCycleId: 'A1',
    });
  });

  it('orders shooters by numeric SubHex q/r, then ID, independent of incoming array order', () => {
    const guards = [
      actor('ten', 'A', '10,0', 'stationed-unit'),
      actor('two-z', 'A', '2,0', 'stationed-unit'),
      actor('minus', 'A', '-2,0', 'stationed-unit'),
      actor('two-a', 'A', '2,0', 'stationed-unit'),
      actor('row', 'A', '2,-1', 'stationed-unit'),
    ];
    const target = actor('enemy', 'B', '12,0');
    const pairs = guards.map((g) => ({ shooterId: g.id, targetId: target.id }));
    const first = begin(frame([...guards, target], pairs));
    const second = begin(frame([target, ...guards].reverse(), [...pairs].reverse()));
    const expected = ['minus', 'row', 'two-a', 'two-z', 'ten'];
    expect(first.boundaries[0].queue.map((q) => q.unitId)).toEqual(expected);
    expect(second.boundaries[0].queue).toEqual(first.boundaries[0].queue);
  });

  it('revalidates live targets after every shot and lets the next owner select another legal target', () => {
    const snapshot = frame(
      [
        actor('g1', 'A', '0,0', 'stationed-unit'),
        actor('g2', 'A', '1,0', 'stationed-unit'),
        actor('e1', 'B', '2,0'),
        actor('e2', 'B', '3,0'),
      ],
      ['g1', 'g2'].flatMap((shooterId) =>
        ['e1', 'e2'].map((targetId) => ({ shooterId, targetId })),
      ),
    );
    let state = choose(begin(snapshot), 'e1', 's1');
    state = stateOf(resolveSelectedFreeShot(state, resolveRequest(state, 'r1'), outcome(['e1'])));
    expect(getFreeShotPrompt(state)).toMatchObject({
      status: 'choose-target',
      shooterId: 'g2',
      targetIds: ['e2'],
    });
    failure(
      selectFreeShotTarget(state, selectionRequest(state, 'e1', 's2-dead')),
      state,
      'illegal-target',
    );
    state = choose(state, 'e2', 's2');
    state = stateOf(resolveSelectedFreeShot(state, resolveRequest(state, 'r2'), outcome(['e2'])));
    expect(state.pending).toBeNull();
    expect(state.receipts.map((r) => r.targetId)).toEqual(['e1', 'e2']);
  });

  it('skips a later shooter killed by an earlier sequential shot without spending its allowance', () => {
    const snapshot = frame(
      [actor('first', 'A', '-1,0', 'stationed-unit'), actor('later', 'B', '0,0', 'stationed-unit')],
      [
        { shooterId: 'first', targetId: 'later' },
        { shooterId: 'later', targetId: 'first' },
      ],
    );
    const chosen = choose(begin(snapshot), 'later');
    const result = resolveSelectedFreeShot(chosen, resolveRequest(chosen), outcome(['later']));
    const state = stateOf(result);
    expect(state.pending).toBeNull();
    expect(state.receipts.map((r) => r.shooterId)).toEqual(['first']);
    expect(result.ok && result.frame?.actors.find((a) => a.id === 'later')?.alive).toBe(false);
  });

  it('shares one owner-cycle allowance between strategic and tactical triggers through reload', () => {
    const snapshot = frame();
    let selected = choose(begin(snapshot, 'strategic', true), 'commander');
    const result = resolveSelectedFreeShot(selected, resolveRequest(selected), outcome());
    const spent = stateOf(result);
    if (!result.ok || !result.frame) throw new Error('Expected updated frame');
    const restored: FreeShotState = JSON.parse(JSON.stringify(spent));
    const battle = begin(result.frame, 'tactical', false, restored);
    expect(battle.pending).toBeNull();
    expect(battle.receipts).toHaveLength(1);
    const fresh = stateOf(
      openFreeShotCycle(battle, { expectedVersion: battle.version, team: 'A', ownerCycleId: 'A2' }),
    );
    selected = begin(result.frame, 'next-owner', true, fresh);
    expect(getFreeShotPrompt(selected)).toMatchObject({
      status: 'choose-target',
      ownerCycleId: 'A2',
    });
  });

  it('does not spend a no-target allowance and can use it at a later boundary in the same cycle', () => {
    const empty = begin(frame(frame().actors, []));
    expect(empty.pending).toBeNull();
    expect(empty.receipts).toHaveLength(0);
    const later = begin(frame(), 'next-battle', false, JSON.parse(JSON.stringify(empty)));
    expect(getFreeShotPrompt(later)).toMatchObject({ status: 'choose-target', ownerCycleId: 'A1' });
  });

  it('preserves pending selection, cursor, RNG and outcome receipts through JSON save/load and replay', () => {
    const selected = choose(begin(), 'enemy');
    const restored: FreeShotState = JSON.parse(JSON.stringify(selected));
    expect(getFreeShotPrompt(restored)).toEqual(getFreeShotPrompt(selected));
    const request = resolveRequest(restored);
    const resolver = vi.fn(outcome(['enemy']));
    const result = resolveSelectedFreeShot(restored, request, resolver);
    const state = stateOf(result);
    const saved: FreeShotState = JSON.parse(JSON.stringify(state));
    const replay = resolveSelectedFreeShot(saved, request, resolver);
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      frame: null,
      receipt: { outcomeId: 'outcome-selection', rngBefore: 0, rngAfter: 1 },
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(saved.receipts).toHaveLength(1);
  });

  it('does not replay old cycle-opening commands as a reset after a newer cycle begins', () => {
    let state = opened();
    const old = state.cycles[0].request;
    state = stateOf(
      openFreeShotCycle(state, { expectedVersion: state.version, team: 'A', ownerCycleId: 'A2' }),
    );
    const replay = openFreeShotCycle(state, old);
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(replay.state).toBe(state);
    expect(replay.state.cycles).toHaveLength(3);
    failure(
      openFreeShotCycle(state, { ...old, expectedVersion: state.version }),
      state,
      'request-conflict',
    );
  });

  it('replays boundary/selection commands without resetting their current progress', () => {
    const original = opened();
    const snapshot = frame();
    const request = boundaryRequest(original);
    const started = stateOf(beginFreeShotBoundary(original, request, snapshot));
    const selection = selectionRequest(started, 'enemy');
    const selected = stateOf(selectFreeShotTarget(started, selection));
    expect(beginFreeShotBoundary(selected, request, structuredClone(snapshot))).toMatchObject({
      ok: true,
      replayed: true,
      state: selected,
    });
    expect(selectFreeShotTarget(selected, selection)).toMatchObject({
      ok: true,
      replayed: true,
      state: selected,
    });
    failure(
      beginFreeShotBoundary(selected, request, { ...snapshot, rngState: 2 }),
      selected,
      'request-conflict',
    );
    failure(
      selectFreeShotTarget(selected, { ...selection, targetId: 'commander' }),
      selected,
      'request-conflict',
    );
  });

  it('rejects stale, out-of-range, wrong-owner and wrong-shooter selections without changing targets or actions', () => {
    const state = begin(frame([...frame().actors, actor('far', 'B', '20,0')]));
    const request = selectionRequest(state, 'enemy');
    const original = JSON.stringify(state);
    failure(
      selectFreeShotTarget(state, { ...request, expectedVersion: state.version - 1 }),
      state,
      'stale-version',
    );
    failure(selectFreeShotTarget(state, { ...request, targetId: 'far' }), state, 'illegal-target');
    failure(selectFreeShotTarget(state, { ...request, team: 'B' }), state, 'wrong-shooter');
    failure(
      selectFreeShotTarget(state, { ...request, shooterId: 'enemy' }),
      state,
      'wrong-shooter',
    );
    failure(
      selectFreeShotTarget(state, { ...request, ownerCycleId: 'A2' }),
      state,
      'wrong-shooter',
    );
    expect(JSON.stringify(state)).toBe(original);
  });

  it('requires explicit cycles and finishes a pending boundary before another boundary/cycle', () => {
    const empty = createFreeShotState();
    failure(beginFreeShotBoundary(empty, boundaryRequest(empty), frame()), empty, 'cycle-not-open');
    const state = begin();
    failure(
      openFreeShotCycle(state, { expectedVersion: state.version, team: 'A', ownerCycleId: 'A2' }),
      state,
      'pending-boundary',
    );
    failure(
      beginFreeShotBoundary(state, boundaryRequest(state, 'other'), frame()),
      state,
      'pending-boundary',
    );
    const selected = choose(state, 'enemy');
    failure(
      selectFreeShotTarget(selected, selectionRequest(selected, 'enemy', 'other-selection')),
      selected,
      'selection-pending',
    );
  });

  it('ignores initially dead garrisons and dead target facts instead of granting a shot', () => {
    const deadGuard = { ...actor('dead', 'A', '-1,0', 'stationed-unit'), alive: false };
    const deadEnemy = { ...actor('enemy', 'B', '2,0'), alive: false };
    const state = begin(
      frame(
        [deadGuard, actor('guard', 'A', '0,0', 'stationed-unit'), deadEnemy],
        [{ shooterId: 'guard', targetId: 'enemy' }],
      ),
    );
    expect(state.pending).toBeNull();
    expect(state.receipts).toHaveLength(0);
    expect(state.boundaries[0].queue.map((q) => q.unitId)).toEqual(['guard']);
  });

  it('freezes a detached input snapshot and leaves the selected shot available on adapter failure', () => {
    const state = choose(begin(), 'enemy');
    const request = resolveRequest(state);
    const original = JSON.stringify(state);
    const broken: FreeShotAdapter = ({ frame: snapshot }) => {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.actors[0].normalActions)).toBe(true);
      (snapshot.actors[0] as unknown as { alive: boolean }).alive = false;
      throw new Error('A frozen snapshot mutation must fail');
    };
    failure(resolveSelectedFreeShot(state, request, broken), state, 'adapter-failed');
    failure(
      resolveSelectedFreeShot(state, request, () => ({
        ok: false,
        reason: 'Existing resolver rejected shot',
      })),
      state,
      'adapter-failed',
    );
    expect(JSON.stringify(state)).toBe(original);
    expect(state.receipts).toHaveLength(0);
    expect(stateOf(resolveSelectedFreeShot(state, request, outcome())).receipts).toHaveLength(1);
  });

  it('rejects stale resolutions and changed request IDs without rerolling', () => {
    const state = choose(begin(), 'enemy');
    const request = resolveRequest(state);
    const resolver = vi.fn(outcome());
    failure(
      resolveSelectedFreeShot(state, { ...request, expectedVersion: state.version - 1 }, resolver),
      state,
      'stale-version',
    );
    expect(resolver).not.toHaveBeenCalled();
    const spent = stateOf(resolveSelectedFreeShot(state, request, resolver));
    failure(
      resolveSelectedFreeShot(spent, { ...request, selectionId: 'different' }, resolver),
      spent,
      'request-conflict',
    );
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid outcomes atomically, including movement or normal AP spending', () => {
    const state = choose(begin(), 'enemy');
    const request = resolveRequest(state);
    const before = JSON.stringify(state);
    for (const change of [
      (snapshot: FreeShotFrame): FreeShotFrame => ({
        ...snapshot,
        revision: snapshot.revision - 1,
      }),
      (snapshot: FreeShotFrame): FreeShotFrame => ({
        ...snapshot,
        actors: snapshot.actors.map((a) => (a.id === 'guard' ? { ...a, subHex: '1,1' } : a)),
      }),
      (snapshot: FreeShotFrame): FreeShotFrame => ({
        ...snapshot,
        actors: snapshot.actors.map((a) =>
          a.id === 'guard' ? { ...a, normalActions: { mp: 0, acted: true, moved: false } } : a,
        ),
      }),
      (snapshot: FreeShotFrame): FreeShotFrame => ({
        ...snapshot,
        actors: snapshot.actors.slice(1),
      }),
    ]) {
      failure(
        resolveSelectedFreeShot(state, request, (input) => {
          const result = outcome()(input);
          if (!result.ok) return result;
          return { ...result, frame: change(result.frame) };
        }),
        state,
        'invalid-outcome',
      );
    }
    expect(JSON.stringify(state)).toBe(before);
    expect(state.receipts).toHaveLength(0);
  });

  it('does not treat property insertion order as spending normal actions', () => {
    const state = choose(begin(), 'enemy');
    const result = resolveSelectedFreeShot(state, resolveRequest(state), (input) => {
      const resolved = outcome()(input);
      if (!resolved.ok) return resolved;
      return {
        ...resolved,
        frame: {
          ...resolved.frame,
          actors: resolved.frame.actors.map((a) => ({
            ...a,
            normalActions:
              a.normalActions === null
                ? null
                : {
                    moved: a.normalActions.moved,
                    acted: a.normalActions.acted,
                    mp: a.normalActions.mp,
                  },
          })),
        },
      };
    });
    expect(stateOf(result).receipts).toHaveLength(1);
  });

  it('cannot accept an outcome ID a second time for another shooter', () => {
    const snapshot = frame(
      [
        actor('g1', 'A', '0,0', 'stationed-unit'),
        actor('g2', 'A', '1,0', 'stationed-unit'),
        actor('enemy', 'B', '2,0'),
      ],
      [
        { shooterId: 'g1', targetId: 'enemy' },
        { shooterId: 'g2', targetId: 'enemy' },
      ],
    );
    let selected = choose(begin(snapshot), 'enemy', 's1');
    const first = resolveSelectedFreeShot(selected, resolveRequest(selected, 'r1'), outcome());
    selected = choose(stateOf(first), 'enemy', 's2');
    const request = resolveRequest(selected, 'r2');
    failure(
      resolveSelectedFreeShot(selected, request, (input) => {
        const result = outcome()(input);
        return result.ok ? { ...result, outcomeId: 'outcome-s1' } : result;
      }),
      selected,
      'invalid-outcome',
    );
    expect(selected.receipts).toHaveLength(1);
  });

  it('adapts the existing attack resolver on a detached battle while preserving first-turn AP', () => {
    const original = flatBattle([
      mkUnit('guard', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('enemy', 'ww2_rifle_infantry', 'B', '2,0'),
    ]).battle;
    original.units[1].hp = 1;
    const originalJson = JSON.stringify(original);
    let resolvedBattle: Battle | null = null;
    const snapshot = frame(
      original.units.map((u) => ({
        id: u.id,
        team: u.team,
        subHex: u.pos!,
        alive: u.hp > 0,
        kind: u.id === 'guard' ? 'stationed-unit' : 'unit',
        normalActions: { mp: u.mp, acted: u.acted, moved: u.moved },
      })),
      [{ shooterId: 'guard', targetId: 'enemy' }],
    );
    const selected = choose(begin(snapshot), 'enemy');
    const result = resolveSelectedFreeShot(
      selected,
      resolveRequest(selected),
      ({ frame: before, shooter, target }) => {
        const fixture = flatBattle(structuredClone(original.units));
        const random = scriptedRng([20, 6]);
        const attacker = fixture.battle.units.find((u) => u.id === shooter.id)!;
        const attack = resolveAttack(fixture.ctx, random, fixture.battle, attacker, target.subHex);
        if ('error' in attack) return { ok: false, reason: attack.error };
        // Existing normal attack resolution spends actions; the free-shot adapter restores them.
        for (const unit of fixture.battle.units) {
          const normal = before.actors.find((a) => a.id === unit.id)!.normalActions!;
          unit.mp = normal.mp;
          unit.acted = normal.acted;
          unit.moved = normal.moved;
        }
        resolvedBattle = fixture.battle;
        return {
          ok: true,
          outcomeId: 'existing-resolver-shot',
          frame: {
            ...before,
            revision: before.revision + 1,
            rngState: random.state(),
            actors: before.actors.map((a) => ({
              ...a,
              alive: fixture.battle.units.find((u) => u.id === a.id)!.hp > 0,
            })),
          },
        };
      },
    );
    const final = stateOf(result);
    expect(final.receipts[0]).toMatchObject({
      rngBefore: 0,
      rngAfter: 2,
      outcomeId: 'existing-resolver-shot',
    });
    expect(result.ok && result.frame?.actors.find((a) => a.id === 'enemy')?.alive).toBe(false);
    expect((resolvedBattle as Battle | null)?.units[0].mp).toBe(original.units[0].mp);
    expect((resolvedBattle as Battle | null)?.units[0].acted).toBe(false);
    expect(JSON.stringify(original)).toBe(originalJson);
  });

  it('rejects sparse arrays and malformed facts at each public boundary without throwing', () => {
    const state = opened();
    const request = boundaryRequest(state);
    const sparse = Array(1) as FreeShotActor[];
    expect(() => beginFreeShotBoundary(state, request, frame(sparse, []))).not.toThrow();
    failure(beginFreeShotBoundary(state, request, frame(sparse, [])), state, 'invalid-frame');
    failure(
      beginFreeShotBoundary(state, request, frame(frame().actors, Array(1))),
      state,
      'invalid-frame',
    );
    for (const invalidState of [
      { ...state, cycles: Array(1) },
      { ...state, boundaries: Array(1) },
      { ...state, selections: Array(1) },
      { ...state, receipts: Array(1) },
    ] as FreeShotState[]) {
      expect(() => validateFreeShotState(invalidState)).not.toThrow();
      expect(() => getFreeShotPrompt(invalidState)).not.toThrow();
      failure(
        openFreeShotCycle(invalidState, {
          expectedVersion: invalidState.version,
          team: 'A',
          ownerCycleId: 'A2',
        }),
        invalidState,
        'invalid-state',
      );
    }
    const selected = choose(begin(), 'enemy');
    const pending = selected.pending!;
    const malformed: FreeShotState = {
      ...selected,
      pending: { ...pending, frame: { ...pending.frame, actors: sparse } },
    };
    expect(() =>
      resolveSelectedFreeShot(malformed, resolveRequest(selected), outcome()),
    ).not.toThrow();
    failure(
      resolveSelectedFreeShot(malformed, resolveRequest(selected), outcome()),
      malformed,
      'invalid-state',
    );
  });

  it('rejects malformed coordinates, friendly target facts and invalid queues instead of repairing saves', () => {
    expect(
      validateFreeShotFrame(frame([{ ...frame().actors[0], subHex: '02,0' }], [])),
    ).toBeTruthy();
    expect(
      validateFreeShotFrame(
        frame(
          [actor('g', 'A', '0,0', 'stationed-unit'), actor('ally', 'A', '1,0')],
          [{ shooterId: 'g', targetId: 'ally' }],
        ),
      ),
    ).toBeTruthy();
    const started = begin();
    const pending = started.pending!;
    expect(validateFreeShotState({ ...started, pending: { ...pending, cursor: 1 } })).toBeTruthy();
    const selected = choose(started, 'enemy');
    expect(
      validateFreeShotState({
        ...selected,
        pending: null,
        boundaries: selected.boundaries.map((b) => ({ ...b, completedVersion: selected.version })),
      }),
    ).toBeTruthy();
  });

  it('binds pending RNG, revision, facts and cursor to the opening/outcome chain after reload', () => {
    const snapshot = frame(
      [
        actor('g1', 'A', '0,0', 'stationed-unit'),
        actor('g2', 'A', '1,0', 'stationed-unit'),
        actor('enemy', 'B', '2,0'),
      ],
      [
        { shooterId: 'g1', targetId: 'enemy' },
        { shooterId: 'g2', targetId: 'enemy' },
      ],
    );
    const opening = begin(snapshot);
    const alteredOpening = {
      ...opening,
      pending: { ...opening.pending!, frame: { ...opening.pending!.frame, rngState: 999 } },
    };
    expect(validateFreeShotState(alteredOpening)).toBeTruthy();
    const selected = choose(opening, 'enemy', 's1');
    const after = stateOf(
      resolveSelectedFreeShot(selected, resolveRequest(selected, 'r1'), outcome()),
    );
    const restored: FreeShotState = JSON.parse(JSON.stringify(after));
    expect(validateFreeShotState(restored)).toBeNull();
    for (const change of [
      { ...restored.pending!, frame: { ...restored.pending!.frame, rngState: 999 } },
      { ...restored.pending!, frame: { ...restored.pending!.frame, revision: 999 } },
      { ...restored.pending!, cursor: 0 },
      {
        ...restored.pending!,
        frame: {
          ...restored.pending!.frame,
          actors: restored.pending!.frame.actors.map((a) =>
            a.id === 'enemy' ? { ...a, alive: false } : a,
          ),
        },
      },
    ])
      expect(validateFreeShotState({ ...restored, pending: change })).toBeTruthy();
    const forged = {
      ...restored,
      pending: {
        ...restored.pending!,
        frame: { ...restored.pending!.frame, rngState: 999, revision: 999 },
      },
    };
    const command = selectionRequest(restored, 'enemy', 's2');
    failure(selectFreeShotTarget(forged, command), forged, 'invalid-state');
  });

  it('rejects broken receipt RNG/revision links and falsified completion versions', () => {
    const selected = choose(begin(), 'enemy');
    const completed = stateOf(
      resolveSelectedFreeShot(selected, resolveRequest(selected), outcome()),
    );
    const receipt = completed.receipts[0];
    for (const changed of [
      { ...receipt, rngBefore: 999 },
      { ...receipt, rngAfter: 999 },
      { ...receipt, frameBefore: 99, frameAfter: 100 },
      { ...receipt, outcomeFrame: { ...receipt.outcomeFrame, rngState: 999 } },
    ])
      expect(validateFreeShotState({ ...completed, receipts: [changed] })).toBeTruthy();
    const boundary = completed.boundaries[0];
    expect(
      validateFreeShotState({
        ...completed,
        boundaries: [{ ...boundary, completedVersion: boundary.openedVersion }],
      }),
    ).toBeTruthy();
    const noTarget = begin(frame(frame().actors, []));
    const later = stateOf(
      openFreeShotCycle(noTarget, {
        expectedVersion: noTarget.version,
        team: 'A',
        ownerCycleId: 'A2',
      }),
    );
    expect(
      validateFreeShotState({
        ...later,
        boundaries: later.boundaries.map((b) => ({ ...b, completedVersion: later.version })),
      }),
    ).toBeTruthy();
  });
});

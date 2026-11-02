import assert from 'node:assert/strict';
import * as e from '../../../packages/engine/src/index.ts';
import { deploymentZone } from '../../../packages/engine/src/battleMap.ts';
import { contextFor } from '../../../packages/engine/src/tactical.ts';

function fixture() {
  let game = e.createGame({
    ...e.defaultSettings(),
    grid: { mainCols: 5, mainRows: 3, subRadius: 3 },
    seed: 42,
    fog: false,
    controllers: { A: 'human', B: 'human' },
    commanderTrainingCp: 1,
    engagement: { ...e.EXPERIMENTAL_ENGAGEMENT_PROFILE },
  });
  const actions = [];
  const step = (action) => {
    const r = e.apply(game, action);
    assert.equal(r.error, null, JSON.stringify(action));
    game = r.state;
    actions.push(action);
    return game;
  };
  const aid = game.armies.find((a) => a.team === 'A' && a.kind === 'commander').id;
  const bid = game.armies.find((a) => a.team === 'B' && a.kind === 'commander').id;
  step({ type: 'endTurn' });
  const def = game.armies.find((a) => a.id === bid);
  step({ type: 'formCommander', fromId: bid, unitIds: def.units.slice(-2).map((u) => u.id) });
  const extra = game.armies.at(-1).id;
  step({ type: 'endTurn' });
  const { world } = e.worldOf(game);
  const am = world.mains.find((m) => m.col === 2 && m.row === 1);
  const bm = world.mains.find((m) => m.col === 3 && m.row === 1);
  const ac = world.subs.find(
    (s) =>
      s.main === am.key &&
      world.subs.some((t) => t.main === bm.key && e.hexDistance(s.hex, t.hex) === 2),
  );
  const bc = world.subs.find((s) => s.main === bm.key && e.hexDistance(s.hex, ac.hex) === 2);
  e.setHolderPos(
    world,
    game.armies.find((a) => a.id === aid),
    ac.key,
  );
  e.setHolderPos(
    world,
    game.armies.find((a) => a.id === bid),
    bc.key,
  );
  e.setHolderPos(
    world,
    game.armies.find((a) => a.id === extra),
    bm.subKeys.find((k) => k !== bc.key),
  );
  // Explicit initial fixture ground for an observable capture and a legal primary fallback.
  game.hexes[bm.key].owner = 'B';
  const fb = world.mains.find((m) => m.col === 4 && m.row === 1);
  game.hexes[fb.key].owner = 'B';
  const cap = am.subKeys.toSorted(
    (a, b) => e.hexDistance(e.parseKey(b), bm.center) - e.hexDistance(e.parseKey(a), bm.center),
  )[0];
  game.settings.battleObjective = {
    kind: 'capture_point',
    captureKey: cap,
    captureRadius: 0,
    extractionAtOrigin: true,
  };
  assert.deepEqual(e.validateGameState(game), []);
  const before = structuredClone(game.armies.find((a) => a.id === extra));
  step({ type: 'engage', armyId: aid, targetId: bid });
  step({ type: 'engagementLock', team: 'A' });
  step({ type: 'engagementSelect', team: 'B', armyIds: [bid, extra] });
  step({ type: 'engagementLock', team: 'B' });
  return {
    get game() {
      return game;
    },
    step,
    actions,
    aid,
    bid,
    extra,
    before,
    target: bm.key,
    cap,
    world,
  };
}

const report = {
  label:
    'Read-only review. Initial positions/ground/custom capture objective prepared; all creation, participation, deployment and terminal commands use legal public apply actions. No HP/CP/outcome mutation.',
  cases: [],
};
for (const type of ['secureObjective', 'extract']) {
  const f = fixture();
  f.step({ type: 'startBattle' });
  f.step({ type: 'finishDeploy' });
  const unit = f.game.battle.units.find((u) => u.team === 'A');
  assert(deploymentZone(contextFor(f.game), f.game.battle, 'A', f.aid).includes(f.cap));
  f.step({ type: 'deploy', unitId: unit.id, cell: f.cap });
  f.step({ type: 'finishDeploy' });
  f.step({ type });
  const ending = structuredClone(f.game.battle);
  f.step({ type: 'concludeBattle' });
  assert.deepEqual(e.validateGameState(f.game), []);
  const extra = f.game.armies.find((a) => a.id === f.extra);
  const primary = f.game.armies.find((a) => a.id === f.bid);
  report.cases.push({
    type,
    ending: {
      winner: ending.winner,
      extracted: ending.extracted,
      withdrawnTeam: ending.withdrawnTeam,
      endReason: ending.endReason,
    },
    owner: f.game.hexes[f.target].owner,
    primaryDefenderAfter: primary?.at,
    additionalDefenderAfter: extra?.at,
    additionalPositionUnchanged: extra?.pos === f.before.pos,
    additionalMovesUnchanged: extra?.movesLeft === f.before.movesLeft,
    stillHeldLog: f.game.log.filter((l) => l.text.includes('still held')),
    actions: f.actions,
  });
}
for (let seed = 1; seed <= 100; seed++) {
  const f = fixture();
  f.game.rng = seed; // Declared initial deterministic roll seed, not a forced result.
  f.step({ type: 'autoResolve' });
  if (!f.game.log.some((l) => l.text.includes('AUTO-RESOLVE') && l.text.includes('ALPHA wins')))
    continue;
  const extra = f.game.armies.find((a) => a.id === f.extra);
  const primary = f.game.armies.find((a) => a.id === f.bid);
  report.cases.push({
    type: 'autoResolve',
    seed,
    owner: f.game.hexes[f.target].owner,
    primaryDefenderAfter: primary?.at,
    additionalDefenderAfter: extra?.at,
    livingAdditionalHp: extra?.units.map((u) => u.hp),
    additionalPositionUnchanged: extra?.pos === f.before.pos,
    additionalMovesUnchanged: extra?.movesLeft === f.before.movesLeft,
    stillHeldLog: f.game.log.filter((l) => l.text.includes('still held')),
    actions: f.actions,
  });
  break;
}
// Deliberately malformed save data, separate from the legal outcome reproductions.
const malformed = fixture();
malformed.step({ type: 'startBattle' });
for (const unit of malformed.game.battle.units.filter((u) => u.holderId === malformed.extra))
  unit.hp = 0;
const errors = e.validateGameState(malformed.game);
assert(errors.some((error) => error.includes('living persistent source HP')));
report.validation = {
  label:
    'Intentional corruption of deployment HP only; valid persistent roster remains alive. Fixed loader rejects it.',
  errors,
  persistentHp: malformed.game.armies.find((a) => a.id === malformed.extra).units.map((u) => u.hp),
  tacticalHp: malformed.game.battle.units
    .filter((u) => u.holderId === malformed.extra)
    .map((u) => u.hp),
};
console.log(JSON.stringify(report, null, 2));

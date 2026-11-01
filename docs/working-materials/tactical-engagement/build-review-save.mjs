// Prepared review posture; all units and CP originate from ordinary create/split/endTurn actions.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as engine from '../../../packages/engine/src/index.ts';
const settings = {
  ...engine.defaultSettings(),
  grid: { mainCols: 5, mainRows: 3, subRadius: 3 },
  seed: 42,
  fog: false,
  controllers: { A: 'human', B: 'human' },
  commanderTrainingCp: 1,
  engagement: { ...engine.EXPERIMENTAL_ENGAGEMENT_PROFILE },
};
let game = engine.createGame(settings);
const primary = {
  A: game.armies.find((a) => a.team === 'A' && a.kind === 'commander').id,
  B: game.armies.find((a) => a.team === 'B' && a.kind === 'commander').id,
};
const actions = [];
function step(action) {
  const before = structuredClone(game.cp);
  const result = engine.apply(game, action);
  assert.equal(result.error, null);
  game = result.state;
  actions.push({ action, before, after: structuredClone(game.cp) });
  return game;
}
function split(team, count) {
  const source = game.armies.find((a) => a.id === primary[team]);
  step({
    type: 'formCommander',
    fromId: source.id,
    unitIds: source.units.slice(-count).map((u) => u.id),
  });
  return game.armies.at(-1).id;
}
const A1 = split('A', 1),
  A2 = split('A', 2),
  declined = split('A', 1);
step({ type: 'endTurn' });
const B1 = split('B', 2),
  B2 = split('B', 2);
step({ type: 'endTurn' });
const { world } = engine.worldOf(game);
const aMain = world.mains.find((m) => m.col === 2 && m.row === 1),
  bMain = world.mains.find((m) => m.col === 3 && m.row === 1);
const aCell = world.subs.find(
  (s) =>
    s.main === aMain.key &&
    world.subs.some((t) => t.main === bMain.key && engine.hexDistance(s.hex, t.hex) === 2),
);
const bCell = world.subs.find(
  (s) => s.main === bMain.key && engine.hexDistance(s.hex, aCell.hex) === 2,
);
const taken = new Set(game.armies.filter((a) => a.kind !== 'commander').map((a) => a.pos));
function place(id, key) {
  assert(!taken.has(key));
  taken.add(key);
  engine.setHolderPos(
    world,
    game.armies.find((a) => a.id === id),
    key,
  );
}
function free(main) {
  return world.mainByKey.get(main).subKeys.find((k) => !taken.has(k));
}
place(primary.A, aCell.key);
place(primary.B, bCell.key);
place(A1, free(aMain.key));
place(A2, free(world.mains.find((m) => m.col === 1 && m.row === 1).key));
place(declined, free(bMain.key));
place(B1, free(bMain.key));
place(B2, free(world.mains.find((m) => m.col === 3 && m.row === 0).key));
// Explicit initial facings are review posture, not a combat result. No unit or resource is fabricated.
for (const holder of game.armies.filter((a) => a.kind === 'commander'))
  holder.units.forEach((u, i) => {
    u.facing = holder.team === 'A' ? (i % 2 === 0 ? 0 : 3) : i % 2 === 0 ? 3 : 0;
  });
assert.deepEqual(engine.validateGameState(game), []);
const staged = engine.apply(game, { type: 'engage', armyId: primary.A, targetId: primary.B });
assert.equal(staged.error, null);
for (const [team, ids] of [
  ['A', [primary.A, A1, A2]],
  ['B', [primary.B, B1, B2]],
]) {
  for (const id of ids.filter((id) => id !== primary[team]))
    assert.equal(
      engine.engagementCandidates(staged.state, team).find((c) => c.armyId === id)?.reason,
      undefined,
    );
}
const metadata = {
  label:
    'Prepared commander positions and initial facing; normal splits and turn income paid. No CP/HP/units fabricated.',
  settings,
  primary,
  additional: { A: [A1, A2], B: [B1, B2] },
  declined,
  actions,
  cpBeforeEngagement: game.cp,
  posture: game.armies
    .filter((a) => a.kind === 'commander')
    .map((a) => ({
      id: a.id,
      team: a.team,
      pos: a.pos,
      at: a.at,
      movesLeft: a.movesLeft,
      unitIds: a.units.map((u) => u.id),
    })),
};
await fs.writeFile(
  '/tmp/engagement-review.save.json',
  engine.serializeSave(game, 'Prepared multi-commander review'),
);
await fs.writeFile('/tmp/engagement-review-fixture.json', JSON.stringify(metadata, null, 2) + '\n');
console.log(
  JSON.stringify(
    { primary, additional: metadata.additional, declined, cp: game.cp, posture: metadata.posture },
    null,
    2,
  ),
);

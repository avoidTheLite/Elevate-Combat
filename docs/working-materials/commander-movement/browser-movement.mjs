// Actual map pointer inputs on the regular ready playtest; debug hooks only inspect/capture evidence.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const expected = process.argv[2] ?? 'fixed';
const out = process.env.MOVEMENT_EVIDENCE_DIR ?? `/tmp/commander-movement-${expected}`;
await fs.mkdir(out, { recursive: true });
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  expected,
  startedAt: new Date().toISOString(),
  host: 'cloud Chromium localhost, not user workstation',
  actions: [],
  snapshots: [],
  screenshots: [],
  errors: [],
};
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
});
const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } });
page.on('pageerror', (e) => report.errors.push(e.message));
const snapshot = async (label) => {
  const s = await page.evaluate(() => {
    const { store, engine: e, scene } = window.__ironRidge;
    const { game: g, ui } = store.getState();
    const a = g.armies.find((a) => a.team === 'A' && a.kind === 'commander');
    return {
      commander: { id: a.id, pos: a.pos, at: a.at, movesLeft: a.movesLeft },
      ui,
      phase: g.phase,
      turn: g.turn,
      active: g.active,
      validation: e.validateGameState(g),
      nodes: g.infrastructure?.sites.length,
      cp: g.cp,
      renderCalls: scene?.renderer.info.render.calls,
    };
  });
  report.snapshots.push({ label, ...s });
  await fs.writeFile(
    `${out}/browser-movement-progress.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log('snapshot', label, s.commander.pos, s.commander.movesLeft);
  return s;
};
const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  report.screenshots.push(`${name}.png`);
};
const clickKey = async (key, button = 'left') => {
  const point = await page.evaluate((key) => {
    const s = window.__ironRidge.scene,
      c = s.projectKey(key);
    if (!c) return null;
    const rect = s.renderer.domElement.getBoundingClientRect();
    // Search a bounded screen patch for a real ray hit on the intended cell/model.
    const offsets = [
      [0, 0],
      [0, -8],
      [0, 8],
      [-8, 0],
      [8, 0],
      [0, -16],
      [0, 16],
      [-16, 0],
      [16, 0],
      [-8, -8],
      [8, -8],
      [-8, 8],
      [8, 8],
    ];
    for (const [dx, dy] of offsets) {
      const x = c.x + dx,
        y = c.y + dy;
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue;
      s.pointer.set(
        ((x - rect.left) / rect.width) * 2 - 1,
        -((y - rect.top) / rect.height) * 2 + 1,
      );
      if (s.pickKey() === key) return { x, y };
    }
    return null;
  }, key);
  assert.ok(point, `Actual pointer target available for ${key}`);
  await page.mouse.click(point.x, point.y, { button });
  await page.waitForTimeout(120);
};
try {
  await page.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  await page.getByRole('button', { name: 'USE READY PLAYTEST SETUP', exact: true }).click();
  await page.getByRole('button', { name: 'START NEW GAME', exact: true }).click();
  await page.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  await page.waitForTimeout(600);
  const ids = await page.evaluate(() => {
    const h = window.__ironRidge,
      g = h.store.getState().game;
    const a = g.armies.find((a) => a.team === 'A' && a.kind === 'commander'),
      hq = g.armies.find((a) => a.team === 'A' && a.kind === 'garrison' && a.building === 'hq');
    return { a: a.id, start: a.pos, hq: hq.pos, garrison: hq.id };
  });
  report.identities = ids;
  await page.evaluate(() => {
    const h = window.__ironRidge,
      s = h.scene,
      old = s.handlers.onClick;
    s.handlers.onClick = (key, button) => {
      window.__movementClicks ??= [];
      window.__movementClicks.push({ key, button });
      old(key, button);
    };
  });
  const before = await snapshot('opening');
  await shot('01-opening');
  await clickKey(ids.start);
  const selected = await snapshot('commander selected');
  assert.equal(selected.ui.selectedArmy, ids.a);
  await clickKey(ids.hq);
  const hq = await snapshot('town center clicked');
  await shot('02-town-center-click');
  await clickKey(ids.start);
  const returned = await snapshot('original starting tile clicked');
  await shot('03-original-tile-click');
  report.pointerInputs = await page.evaluate(() => window.__movementClicks);
  assert.equal(returned.commander.pos, before.commander.pos);
  if (expected === 'baseline') {
    assert.equal(hq.commander.pos, ids.hq);
    assert.equal(hq.commander.movesLeft, before.commander.movesLeft - 1);
    assert.equal(returned.commander.movesLeft, before.commander.movesLeft - 2);
    report.result = 'REPRODUCED unintended HQ move and charged return';
  } else {
    assert.deepEqual(hq.commander, before.commander);
    assert.equal(hq.ui.selectedArmy, ids.garrison);
    assert.deepEqual(returned.commander, before.commander);
    assert.equal(returned.ui.selectedArmy, ids.a);
    for (let i = 0; i < 8; i++) {
      await clickKey(ids.hq);
      await clickKey(ids.start);
    }
    assert.deepEqual((await snapshot('eight rapid selection cycles')).commander, before.commander);
    await clickKey(ids.start, 'right');
    assert.deepEqual((await snapshot('right-click cancel')).commander, before.commander);
    assert.equal((await snapshot('canceled selection')).ui.selectedArmy, null);
    // A genuine empty-cell click is still an immediate confirmed order and both legs cost movement.
    await clickKey(ids.start);
    const dest = await page.evaluate(() => {
      const { engine: e, store } = window.__ironRidge,
        g = store.getState().game,
        a = g.armies.find((a) => a.team === 'A' && a.kind === 'commander');
      const { world } = e.worldOf(g);
      const hq = g.armies.find(
        (a) => a.team === 'A' && a.kind === 'garrison' && a.building === 'hq',
      );
      return [...e.commanderReach(g, a)].find(
        ([k, n]) =>
          n === 1 && e.hexDistance(world.subByKey.get(k).hex, world.subByKey.get(hq.pos).hex) > 1,
      )?.[0];
    });
    assert.ok(dest);
    report.confirmedDestination = dest;
    await clickKey(dest);
    const moved = await snapshot('confirmed empty-cell move');
    assert.equal(moved.commander.pos, dest);
    assert.equal(moved.commander.movesLeft, before.commander.movesLeft - 1);
    const onward = await page.evaluate(() => {
      const { engine: e, store } = window.__ironRidge,
        g = store.getState().game,
        a = g.armies.find((a) => a.team === 'A' && a.kind === 'commander');
      const { world } = e.worldOf(g);
      const hq = g.armies.find(
        (a) => a.team === 'A' && a.kind === 'garrison' && a.building === 'hq',
      );
      return [...e.commanderReach(g, a)].find(
        ([k, n]) =>
          n === 1 && e.hexDistance(world.subByKey.get(k).hex, world.subByKey.get(hq.pos).hex) > 1,
      )?.[0];
    });
    assert.ok(onward);
    report.onwardDestination = onward;
    await clickKey(onward);
    const outbound = await snapshot('confirmed onward move');
    assert.equal(outbound.commander.pos, onward);
    assert.equal(outbound.commander.movesLeft, before.commander.movesLeft - 2);
    await clickKey(dest);
    const back = await snapshot('confirmed open-cell return');
    assert.equal(back.commander.pos, dest);
    assert.equal(back.commander.movesLeft, before.commander.movesLeft - 3);
    const crossing = await page.evaluate(() => {
      const { engine: e, store } = window.__ironRidge,
        g = store.getState().game,
        a = g.armies.find((a) => a.team === 'A' && a.kind === 'commander');
      const { world } = e.worldOf(g);
      return [...e.commanderReach(g, a)].find(
        ([k, n]) =>
          n > 0 &&
          world.subByKey.get(k).main !== a.at &&
          !e.holderAt(g, k) &&
          !g.infrastructure.sites.some((s) => s.centerSubHex === k),
      );
    });
    assert.ok(crossing);
    report.crossMainMove = { destination: crossing[0], cost: crossing[1] };
    await clickKey(crossing[0]);
    const crossed = await snapshot('confirmed cross-MainHex move');
    assert.equal(crossed.commander.pos, crossing[0]);
    assert.equal(crossed.commander.movesLeft, back.commander.movesLeft - crossing[1]);
    assert.equal(crossed.ui.selectedMain, crossed.commander.at);
    const exact = await page.evaluate(() =>
      JSON.stringify(window.__ironRidge.store.getState().game),
    );
    await page.reload();
    await page.getByRole('button', { name: 'CONTINUE', exact: true }).click();
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.__ironRidge.store.getState().game)),
      exact,
    );
    await snapshot('exact save continuation');
    await shot('04-exact-save-continuation');
    report.result = 'PASS';
  }
  assert.deepEqual(report.errors, []);
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await fs.writeFile(`${out}/browser-movement.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));

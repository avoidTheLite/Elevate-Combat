// Real controls on generated/engine-initialized scenes. Hooks inspect coordinates/state only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.UX_EVIDENCE_DIR ?? '/tmp/ux-controls-commands';
await fs.mkdir(out, { recursive: true });
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  host: 'cloud Chromium localhost, not user workstation',
  checks: [],
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
const read = (p) => p.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
const shot = async (p, name) => {
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  report.screenshots.push(`${name}.png`);
};
const check = (name, data = {}) => {
  report.checks.push({ name, status: 'PASS', ...data });
  console.log('PASS', name);
};
async function fresh(mobile = false, regular = false) {
  const p = await browser.newPage(
    mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1512, height: 1100 } },
  );
  p.setDefaultTimeout(15000);
  p.on('pageerror', (e) => report.errors.push(e.message));
  await p.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  await p
    .getByRole('button', {
      name: regular ? 'START READY MOVEMENT CAMPAIGN' : 'OPEN PREPARED TACTICAL CONTROLS',
      exact: true,
    })
    .click();
  await p.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  await p.waitForTimeout(450);
  return p;
}
async function point(p, key) {
  return p.evaluate((key) => {
    const s = window.__ironRidge.scene,
      c = s.projectKey(key);
    if (!c) return null;
    const r = s.renderer.domElement.getBoundingClientRect();
    for (const [dx, dy] of [
      [0, 0],
      [0, -7],
      [0, 7],
      [-7, 0],
      [7, 0],
      [-12, -7],
      [12, -7],
      [-12, 7],
      [12, 7],
      [0, -16],
    ]) {
      const x = c.x + dx,
        y = c.y + dy;
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
      if (document.elementFromPoint(x, y) !== s.renderer.domElement) continue;
      s.pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      if (s.pickKey() === key) return { x, y };
    }
    return null;
  }, key);
}
async function click(p, key, mobile = false) {
  const q = await point(p, key);
  assert.ok(q, `Unobscured map target ${key}`);
  if (mobile) await p.touchscreen.tap(q.x, q.y);
  else await p.mouse.click(q.x, q.y);
  await p.waitForTimeout(80);
}
async function candidate(p, kind) {
  const keys = await p.evaluate((kind) => {
    const h = window.__ironRidge,
      g = h.store.getState().game,
      id = h.store.getState().ui.selectedUnit,
      u = g.battle.units.find((u) => u.id === id),
      ctx = h.engine.contextFor(g);
    return kind === 'move'
      ? [...h.engine.reachable(ctx, u)]
          .filter(
            ([k]) =>
              k !== u.pos &&
              h.engine.apply(g, { type: 'move', unitId: id, cell: k }).error === null,
          )
          .sort((a, b) => a[1].cost - b[1].cost)
          .map(([k]) => k)
      : g.battle.units
          .filter(
            (t) =>
              t.team !== u.team &&
              t.hp > 0 &&
              t.pos &&
              h.engine.previewAttack(ctx, g.battle, u, t.pos).legal,
          )
          .map((t) => t.pos);
  }, kind);
  for (const key of keys) if (await point(p, key)) return key;
  throw new Error(`No unobscured legal ${kind} target`);
}
async function expected(p, action) {
  return p.evaluate((action) => {
    const h = window.__ironRidge,
      r = h.engine.apply(h.store.getState().game, action);
    if (r.error) throw new Error(r.error);
    return r.state;
  }, action);
}
async function preferences(p, patch) {
  await p.getByRole('button', { name: 'DEMO CONTROLS', exact: true }).click();
  for (const [key, value] of Object.entries(patch))
    await p.getByRole('checkbox', { name: new RegExp(key) }).setChecked(value);
  await p.getByRole('button', { name: 'CLOSE CONTROLS', exact: true }).click();
}
try {
  const p = await fresh();
  const opening = await read(p);
  assert.deepEqual(
    await p.evaluate(() =>
      window.__ironRidge.engine.validateGameState(window.__ironRidge.store.getState().game),
    ),
    [],
  );
  let id = await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedUnit),
    unit = opening.battle.units.find((u) => u.id === id);
  assert.equal(
    await p
      .locator('[aria-label="Selected unit actions"]')
      .getByRole('button', { name: 'MOVE', exact: true })
      .count(),
    1,
  );
  assert.equal(
    await p
      .locator('[aria-label="Selected unit actions"]')
      .getByRole('button', { name: 'ATTACK', exact: true })
      .count(),
    1,
  );
  await shot(p, '01-selected-actions');
  check('Immediate selected actions and valid prepared initial scene');
  await click(p, unit.pos);
  assert.equal(await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedUnit), null);
  assert.equal(await p.locator('.map-callout').count(), 0);
  assert.deepEqual(await read(p), opening);
  check('Selected body click deselects without mutation');
  await p.getByRole('button', { name: 'SELECT RIF', exact: true }).click();
  const move = await candidate(p, 'move');
  const beforeMove = await read(p);
  const moveAction = { type: 'move', unitId: id, cell: move },
    afterMove = await expected(p, moveAction);
  await click(p, move);
  await p.getByTestId('map-command-preview').waitFor();
  assert.deepEqual(await read(p), beforeMove);
  await p.mouse.move(1470, 18);
  await p.waitForTimeout(800);
  assert.equal(await p.getByTestId('map-command-preview').count(), 1);
  assert.deepEqual(await read(p), beforeMove);
  assert.equal(await p.locator('.map-command-connector').count(), 1);
  await shot(p, '02-persistent-move-preview');
  check('Preview-first MOVE and pointer-leave persistence spend nothing');
  await p.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).click();
  assert.deepEqual(await read(p), afterMove);
  check('Confirm MOVE charges exact existing engine cost', {
    beforeMp: beforeMove.battle.units.find((u) => u.id === id).mp,
    afterMp: afterMove.battle.units.find((u) => u.id === id).mp,
  });
  const cancelTarget = await candidate(p, 'move');
  await click(p, cancelTarget);
  await p.getByTestId('map-command-preview').waitFor();
  await p.getByRole('button', { name: 'CANCEL', exact: true }).click();
  assert.deepEqual(await read(p), afterMove);
  assert.equal(await p.locator('.map-command-connector').count(), 0);
  await p.getByRole('button', { name: 'SELECT ENG', exact: true }).click();
  assert.equal(await p.getByTestId('map-command-preview').count(), 0);
  assert.equal(await p.locator('.map-command-connector').count(), 0);
  check('Cancel and selection change remove preview artifacts without spending');
  await p.getByRole('button', { name: 'SELECT RIF', exact: true }).click();
  await preferences(p, { QuickMove: true });
  const quickTarget = await candidate(p, 'move'),
    beforeQuick = await read(p),
    quickExpected = await expected(p, { type: 'move', unitId: id, cell: quickTarget });
  await click(p, quickTarget);
  assert.deepEqual(await read(p), quickExpected);
  assert.equal(await p.getByTestId('map-command-preview').count(), 0);
  check('QuickMove executes a legal click immediately');
  const attack = await candidate(p, 'attack'),
    beforeAttack = await read(p);
  await click(p, attack);
  await p.getByTestId('map-command-preview').waitFor();
  assert.deepEqual(await read(p), beforeAttack);
  await shot(p, '03-attack-preview');
  check('QuickAttack remains independent: full combat preview without execution');
  await p.getByRole('button', { name: 'CANCEL', exact: true }).click();
  await preferences(p, { QuickAttack: true });
  const attackExpected = await expected(p, { type: 'attack', unitId: id, cell: attack });
  await click(p, attack);
  assert.deepEqual(await read(p), attackExpected);
  check('QuickAttack executes exact engine attack without promised outcome', {
    beforeRng: beforeAttack.rng,
    afterRng: attackExpected.rng,
  });
  const saved = await read(p);
  await p.reload();
  await p.getByRole('button', { name: 'CONTINUE', exact: true }).click();
  assert.deepEqual(await read(p), saved);
  await p.getByRole('button', { name: 'DEMO CONTROLS', exact: true }).click();
  assert.equal(await p.getByRole('checkbox', { name: /QuickMove/ }).isChecked(), true);
  assert.equal(await p.getByRole('checkbox', { name: /QuickAttack/ }).isChecked(), true);
  await p.getByRole('button', { name: 'CLOSE CONTROLS', exact: true }).click();
  assert.equal(await p.getByTestId('map-command-preview').count(), 0);
  check('Exact save continuation and separate browser preferences persist');
  await p.close();
  const ops = await fresh();
  await ops.getByRole('button', { name: 'SELECT ENG', exact: true }).click();
  let eng = await ops.evaluate(() => window.__ironRidge.store.getState().ui.selectedUnit);
  const digExpected = await expected(ops, { type: 'dig', unitId: eng });
  await ops
    .locator('[aria-label="Selected unit actions"]')
    .getByRole('button', { name: 'DIG IN', exact: true })
    .click();
  assert.deepEqual(await read(ops), digExpected);
  await shot(ops, '04-engineer-dig-in');
  check('Engineer contextual Dig In performs existing fortification action');
  await ops.getByRole('button', { name: 'SELECT MG', exact: true }).click();
  const mg = await ops.evaluate(() => window.__ironRidge.store.getState().ui.selectedUnit);
  let opExpected = await expected(ops, { type: 'setUp', unitId: mg });
  await ops
    .locator('[aria-label="Selected unit actions"]')
    .getByRole('button', { name: 'SET UP', exact: true })
    .click();
  assert.deepEqual(await read(ops), opExpected);
  opExpected = await expected(ops, { type: 'packUp', unitId: mg });
  await ops
    .locator('[aria-label="Selected unit actions"]')
    .getByRole('button', { name: 'PACK UP', exact: true })
    .click();
  assert.deepEqual(await read(ops), opExpected);
  await shot(ops, '05-machine-gun-pack-up');
  check('Contextual Set Up and Pack Up perform real legal operations');
  await ops.close();
  const r = await fresh(false, true);
  const regular = await read(r);
  assert.equal(regular.infrastructure.sites.length, 5);
  assert.equal(regular.settings.commanderTrainingCp, 15);
  assert.deepEqual(regular.settings.infrastructure.nodes.captureCosts, { capture: 5, raze: 2 });
  const cmd = regular.armies.find((a) => a.team === 'A' && a.kind === 'commander'),
    hq = regular.armies.find((a) => a.team === 'A' && a.kind === 'garrison' && a.building === 'hq');
  await click(r, cmd.pos);
  await click(r, hq.pos);
  assert.deepEqual(await read(r), regular);
  assert.equal(await r.evaluate(() => window.__ironRidge.store.getState().ui.selectedArmy), hq.id);
  check('Regular sparse campaign preserves friendly-building inspection and5/2/15 prices');
  await click(r, cmd.pos);
  const hqPoint = await point(r, hq.pos);
  assert.ok(hqPoint);
  await r.mouse.move(hqPoint.x, hqPoint.y);
  await r.waitForTimeout(650);
  const targetCard = r.locator('.map-callout').filter({ hasText: `TILE ${hq.pos}` });
  await targetCard.getByRole('button', { name: 'MOVE', exact: true }).waitFor();
  const targetRect = await targetCard.boundingBox();
  await r.mouse.move(targetRect.x + targetRect.width / 2, targetRect.y + targetRect.height / 2, {
    steps: 8,
  });
  await r.waitForTimeout(700);
  assert.equal(await targetCard.count(), 1);
  assert.deepEqual(await read(r), regular);
  check('Hover dwell and continuous tile-to-callout travel without mutation');
  await targetCard.getByRole('button', { name: 'MOVE', exact: true }).click();
  await r.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).click();
  const shared = await read(r);
  assert.equal(shared.armies.find((a) => a.id === cmd.id).pos, hq.pos);
  const choices = r.locator('[aria-label="Choose occupant on selected tile"]');
  assert.equal(await choices.getByRole('button').count(), 2);
  await shot(r, '06-real-shared-tile-disambiguation');
  await choices.getByRole('button', { name: 'HQ GARRISON', exact: true }).click();
  assert.equal(await r.evaluate(() => window.__ironRidge.store.getState().ui.selectedArmy), hq.id);
  assert.deepEqual(await read(r), shared);
  check('Legal floating MOVE plus actual commander/garrison shared-cell disambiguation');
  await r.close();
  const m = await fresh(true);
  const mi = await m.evaluate(() => window.__ironRidge.store.getState().ui.selectedUnit);
  const mb = await read(m),
    mu = mb.battle.units.find((u) => u.id === mi);
  const mq = await point(m, mu.pos);
  assert.ok(mq, 'Mobile selected body remains unobscured');
  await click(m, mu.pos, true);
  assert.equal(await m.evaluate(() => window.__ironRidge.store.getState().ui.selectedUnit), null);
  await m.getByRole('button', { name: 'SELECT RIF', exact: true }).tap();
  const mt = await candidate(m, 'move'),
    me = await expected(m, { type: 'move', unitId: mi, cell: mt });
  await click(m, mt, true);
  await m.getByTestId('map-command-preview').waitFor();
  assert.deepEqual(await read(m), mb);
  await shot(m, '07-mobile-confirmation');
  const sizes = await m
    .locator('.map-callout button')
    .evaluateAll((es) =>
      es.map((e) => ({ text: e.textContent, height: e.getBoundingClientRect().height })),
    );
  assert.ok(
    sizes.every((s) => s.height >= 43),
    JSON.stringify(sizes),
  );
  await m.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).tap();
  assert.deepEqual(await read(m), me);
  assert.equal(await m.getByRole('button', { name: 'DETAILS', exact: true }).count(), 1);
  await m.getByRole('button', { name: 'DETAILS', exact: true }).tap();
  await m.getByRole('button', { name: 'HIDE DETAILS', exact: true }).tap();
  await shot(m, '08-mobile-map-controls');
  check('Mobile tap/select/preview/confirm,44px targets and optional details', {
    buttonSizes: sizes,
  });
  await m.close();
  assert.deepEqual(report.errors, []);
  report.result = 'PASS';
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await fs.writeFile(`${out}/browser-commands.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify({ result: report.result, checks: report.checks.length, out }, null, 2));

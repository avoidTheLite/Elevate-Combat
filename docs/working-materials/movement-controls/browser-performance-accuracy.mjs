// Native input on valid saved fixtures; DEV hooks read rules/projection or adjust the camera.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.PERFORMANCE_EVIDENCE_DIR ?? '/tmp/performance-review/browser';
await fs.mkdir(out, { recursive: true });
const hash = (x) => createHash('sha256').update(x).digest('hex');
const paths = execFileSync('git', ['ls-files', 'apps/web/src', 'packages/engine/src'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');
paths.push('docs/working-materials/movement-controls/browser-performance-accuracy.mjs');
const hashes = async () =>
  Object.fromEntries(await Promise.all(paths.map(async (p) => [p, hash(await fs.readFile(p))])));
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: await hashes(),
  checks: [],
  screenshots: [],
  errors: [],
  environment:
    'Cloud Chromium/SwiftShader; trusted CDP pen context and touch-button input, not physical-device or GPU/FPS certification.',
  touchHoldLimit:
    'No trusted touch contextmenu in 18 separate native plain-page attempts on this headless Chromium; this script does not claim touch-hold context proof.',
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
let currentPage;
const check = (name, data = {}) => {
  report.checks.push({ name, status: 'PASS', ...data });
  console.log('PASS', name);
};
const state = (p) =>
  p.evaluate(() => {
    const s = window.__ironRidge.store.getState();
    return { game: structuredClone(s.game), ui: structuredClone(s.ui) };
  });
const gameHash = async (p) => hash(JSON.stringify((await state(p)).game));
async function page({ width = 1512, height = 1100, touch = false } = {}) {
  const p = await browser.newPage({
    viewport: { width, height },
    isMobile: touch,
    hasTouch: touch,
  });
  currentPage = p;
  p.on('pageerror', (e) => report.errors.push(e.message));
  await p.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  return p;
}
async function rendered(p) {
  await p.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
}
async function focus(p, key) {
  await p.evaluate((key) => {
    const s = window.__ironRidge.scene;
    s.focus(key);
    s.viewSizeGoal = 12;
  }, key);
  await p.waitForFunction(() => {
    const s = window.__ironRidge.scene;
    return (
      Math.abs(s.viewSize - s.viewSizeGoal) < 0.005 && s.target.distanceTo(s.targetGoal) < 0.005
    );
  });
}
async function hit(p, key) {
  return p.evaluate((key) => {
    const s = window.__ironRidge.scene,
      c = s.projectKey(key),
      r = s.renderer.domElement.getBoundingClientRect();
    if (!c) return null;
    for (const [dx, dy] of [
      [0, 0],
      [0, 8],
      [0, -8],
      [8, 0],
      [-8, 0],
      [14, 9],
      [-14, -9],
      [0, 28],
      [0, -28],
      [30, 12],
      [-30, -12],
    ]) {
      const x = c.x + dx,
        y = c.y + dy;
      if (document.elementFromPoint(x, y) !== s.renderer.domElement) continue;
      const matches = (a, b) => {
        s.pointer.set(((a - r.left) / r.width) * 2 - 1, -((b - r.top) / r.height) * 2 + 1);
        return s.pickKey() === key;
      };
      if (
        matches(x, y) &&
        [
          [-2, -2],
          [2, -2],
          [-2, 2],
          [2, 2],
        ].every(([a, b]) => matches(x + a, y + b))
      )
        return { x, y };
    }
    return null;
  }, key);
}
async function shot(p, name) {
  await p.screenshot({ path: `${out}/${name}.png` });
  report.screenshots.push(`${name}.png`);
}
async function importFixture(p, kind, temporary) {
  const f = await p.evaluate(
    async ({ kind, temporary }) => {
      const { garrisonContextFixture } = await import('/src/controls/reviewFixtures.ts');
      const f = garrisonContextFixture(kind, temporary);
      return {
        ...f,
        save: window.__ironRidge.engine.serializeSave(
          f.game,
          'Prepared performance review fixture',
          '2026-11-11T00:00:00.000Z',
        ),
      };
    },
    { kind, temporary },
  );
  await p.getByRole('button', { name: 'RESUME GAME', exact: true }).click();
  await p.getByLabel('Import save file').setInputFiles({
    name: 'review-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(f.save),
  });
  await rendered(p);
  return f;
}
async function hideContext(p) {
  const button = p.getByRole('button', { name: 'HIDE CONTEXT', exact: true });
  if (await button.count()) {
    await button.click();
    await p.waitForTimeout(250);
  }
}
async function nativeContext(p, key) {
  const point = await hit(p, key);
  assert.ok(point, `Uncovered native context point for ${key}`);
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'right',
    buttons: 2,
    clickCount: 1,
    pointerType: 'pen',
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'right',
    buttons: 0,
    clickCount: 1,
    pointerType: 'pen',
  });
  await cdp.detach();
}
async function assertValid(p) {
  assert.deepEqual(
    await p.evaluate(() =>
      window.__ironRidge.engine.validateGameState(window.__ironRidge.store.getState().game),
    ),
    [],
  );
}
try {
  for (const spec of [
    { kind: 'hq', temporary: false, width: 390, height: 844 },
    { kind: 'hq', temporary: true, width: 568, height: 320 },
    { kind: 'node', temporary: true, width: 390, height: 844 },
  ]) {
    const p = await page({ ...spec, touch: true }),
      f = await importFixture(p, spec.kind, spec.temporary),
      before = await gameHash(p);
    const actor = f.game.armies.find((a) => a.team === 'A' && a.kind === 'commander');
    await focus(p, actor.pos);
    let point = await hit(p, actor.pos);
    assert.ok(point);
    await p.touchscreen.tap(point.x, point.y);
    await p.waitForFunction(
      (id) => window.__ironRidge.store.getState().ui.selectedArmy === id,
      actor.id,
    );
    await hideContext(p);
    await focus(p, f.center);
    await p.evaluate(() => {
      window.__nativeReviewEvents = [];
      const canvas = window.__ironRidge.scene.renderer.domElement;
      for (const type of ['contextmenu', 'pointerup', 'pointercancel'])
        canvas.addEventListener(type, (event) =>
          window.__nativeReviewEvents.push({
            type,
            trusted: event.isTrusted,
            pointerType: event.pointerType ?? null,
          }),
        );
    });
    await nativeContext(p, f.center);
    const callout = p.locator('[data-callout-kind="target"]');
    await callout.getByRole('button', { name: 'INSPECT TILE', exact: true }).waitFor();
    await p.waitForTimeout(1800);
    assert.equal(await callout.count(), 1);
    assert.equal(await callout.getAttribute('data-anchor-key'), f.center);
    const observed = await p.evaluate(() => window.__nativeReviewEvents);
    assert.ok(
      observed.some((e) => e.type === 'contextmenu' && e.trusted && e.pointerType === 'pen'),
      'Native trusted pen contextmenu required',
    );
    const s = await state(p);
    assert.equal(s.ui.selectedArmy, null);
    assert.equal(s.ui.selectedUnit, null);
    assert.equal(s.ui.inspectedCell, f.center);
    assert.equal(
      s.ui.selectedEntity,
      spec.temporary
        ? null
        : `node:${f.game.infrastructure.sites.find((n) => n.centerSubHex === f.center).nodeId}`,
    );
    assert.equal(await p.getByTestId('map-command-preview').count(), 0);
    assert.equal(await gameHash(p), before);
    await shot(
      p,
      `pinned-touch-${spec.kind}-${spec.temporary ? 'shared' : 'sole'}-${spec.width}x${spec.height}`,
    );
    const label =
      spec.kind === 'node'
        ? 'SELECT NODE GARRISON'
        : spec.temporary
          ? 'SELECT TILE GARRISON'
          : 'SELECT HQ GARRISON';
    await callout.getByRole('button', { name: label, exact: true }).tap();
    const after = await state(p);
    assert.equal(
      after.ui.selectedEntity,
      label === 'SELECT TILE GARRISON'
        ? f.temporaryId
        : `node:${f.game.infrastructure.sites.find((n) => n.centerSubHex === f.center).nodeId}`,
    );
    assert.equal(await gameHash(p), before);
    await assertValid(p);
    check(
      `Trusted pen context survives prior-actor inspection and release; touch ${spec.kind} ${spec.temporary ? 'shared' : 'sole'} choice spends nothing ${spec.width}x${spec.height}`,
      { events: observed },
    );
    await p.close();
  }
  const p = await page();
  await p.getByRole('button', { name: 'QUICK START TACTICAL CONTROLS', exact: true }).click();
  await rendered(p);
  async function command(kind) {
    const choices = await p.evaluate(async (kind) => {
      const h = window.__ironRidge,
        { game: g, ui } = h.store.getState(),
        { commandAt } = await import('/src/controls/commands.ts');
      const unit = g.battle.units.find((u) => u.id === ui.selectedUnit);
      const keys =
        kind === 'move'
          ? [...h.engine.reachable(h.engine.contextFor(g), unit).keys()]
          : g.battle.units
              .filter((u) => u.hp > 0 && u.team !== unit.team && u.pos)
              .map((u) => u.pos);
      return keys.map((key) => commandAt(g, ui, key, kind)).filter((c) => c?.kind === kind);
    }, kind);
    for (const c of choices) {
      const point = await hit(p, c.target);
      if (point) return { c, point };
    }
    throw Error(`No visible legal ${kind} target`);
  }
  let before = (await state(p)).game,
    original = hash(JSON.stringify(before));
  let move = await command('move');
  await p.mouse.click(move.point.x, move.point.y);
  await p.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).waitFor();
  assert.equal(await gameHash(p), original);
  await shot(p, 'pending-move');
  await p.keyboard.press('Escape');
  assert.equal(await gameHash(p), original);
  move = await command('move');
  await p.mouse.click(move.point.x, move.point.y);
  const expectedMove = await p.evaluate(
    (c) =>
      window.__ironRidge.engine.apply(window.__ironRidge.store.getState().game, c.action).state,
    move.c,
  );
  await p.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).click();
  assert.deepEqual((await state(p)).game, expectedMove);
  await p.evaluate(() => window.__ironRidge.scene.frameAll());
  await p.waitForTimeout(600);
  let attack = await command('attack'),
    attackBefore = await gameHash(p);
  await p.mouse.click(attack.point.x, attack.point.y);
  await p.getByRole('button', { name: 'CONFIRM ATTACK', exact: true }).waitFor();
  assert.equal(await gameHash(p), attackBefore);
  await shot(p, 'pending-attack');
  await p.getByRole('button', { name: 'CANCEL', exact: true }).click();
  assert.equal(await gameHash(p), attackBefore);
  attack = await command('attack');
  await p.mouse.click(attack.point.x, attack.point.y);
  const expectedAttack = await p.evaluate(
    (c) =>
      window.__ironRidge.engine.apply(window.__ironRidge.store.getState().game, c.action).state,
    attack.c,
  );
  await p.getByRole('button', { name: 'CONFIRM ATTACK', exact: true }).click();
  assert.deepEqual((await state(p)).game, expectedAttack);
  await assertValid(p);
  const saved = await p.evaluate(() =>
    window.__ironRidge.engine.serializeSave(
      window.__ironRidge.store.getState().game,
      'Confirmed move and attack',
      '2026-11-11T00:00:00.000Z',
    ),
  );
  const resumed = await page();
  await resumed.getByRole('button', { name: 'RESUME GAME', exact: true }).click();
  await resumed.getByLabel('Import save file').setInputFiles({
    name: 'confirmed-orders.json',
    mimeType: 'application/json',
    buffer: Buffer.from(saved),
  });
  await rendered(resumed);
  assert.deepEqual((await state(resumed)).game, expectedAttack);
  assert.equal(await resumed.getByTestId('map-command-preview').count(), 0);
  check(
    'Native move/attack cancel are free; confirmations match exact engine state/RNG and real save import resumes without a pending order',
  );
  await p.close();
  await resumed.close();
  const n = await page(),
    f = await importFixture(n, 'hq', false);
  await focus(n, f.center);
  let center = await hit(n, f.center);
  assert.ok(center);
  await n.mouse.click(center.x, center.y);
  const initial = await gameHash(n);
  async function build() {
    await focus(n, f.center);
    const homePoint = await hit(n, f.center);
    assert.ok(homePoint);
    await n.mouse.click(homePoint.x, homePoint.y);
    await n.getByRole('button', { name: 'Build at node', exact: true }).click();
    await n.getByRole('button', { name: /Build Workshop T1 3 CP/ }).click();
    const choice = await n.evaluate(() => {
      const h = window.__ironRidge,
        g = h.store.getState().game,
        node = h.engine.campaignNodeViews(g).find((n) => n.mainHex === g.hq.A);
      return h.engine
        .campaignNodeActionChoices(g, node.nodeId)
        .find(
          (c) =>
            c.legal &&
            c.request.kind === 'build' &&
            c.request.definitionId === 'workshop' &&
            c.request.tier === 1,
        );
    });
    await focus(n, choice.request.subHex);
    const point = await hit(n, choice.request.subHex);
    assert.ok(point);
    await n.mouse.click(point.x, point.y);
    await n.getByRole('button', { name: 'Confirm build (3 CP)', exact: true }).waitFor();
    return choice;
  }
  await build();
  assert.equal(await gameHash(n), initial);
  await n.getByRole('button', { name: 'Cancel building work', exact: true }).click();
  assert.equal(await gameHash(n), initial);
  const choice = await build();
  const expectedBuild = await n.evaluate(
    (choice) =>
      window.__ironRidge.engine.apply(window.__ironRidge.store.getState().game, {
        type: 'nodeWork',
        request: choice.request,
      }).state,
    choice,
  );
  await shot(n, 'live-node-quote');
  await n.getByRole('button', { name: 'Confirm build (3 CP)', exact: true }).click();
  assert.deepEqual((await state(n)).game, expectedBuild);
  await assertValid(n);
  check(
    'Native current node plan survives layout/inspection, cancel is free and visible confirmation charges one exact CP/work receipt',
  );
  await n.close();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(await hashes(), report.sourceHashes, 'Source changed during browser validation');
} catch (error) {
  report.failure = String(error.stack ?? error);
  if (currentPage && !currentPage.isClosed())
    await currentPage.screenshot({ path: `${out}/failure.png` });
  throw error;
} finally {
  await fs.writeFile(
    `${out}/browser-performance-accuracy.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  await browser.close();
}

// Real input on the Ready Regular Playtest; DEV hooks only read state and adjust camera.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.HQ_EVIDENCE_DIR ?? '/tmp/hq-context-review/browser';
await fs.mkdir(out, { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const paths = execFileSync('git', ['ls-files', 'apps/web/src', 'packages/engine/src'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');
paths.push('docs/working-materials/movement-controls/browser-hq-context.mjs');
const hashes = async () =>
  Object.fromEntries(await Promise.all(paths.map(async (p) => [p, hash(await fs.readFile(p))])));
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: await hashes(),
  environment: 'Cloud Chromium/SwiftShader; emulated touch, not physical-device acceptance.',
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
const state = (p) =>
  p.evaluate(() => {
    const s = window.__ironRidge.store.getState();
    return { game: structuredClone(s.game), ui: structuredClone(s.ui) };
  });
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
    ]) {
      const x = c.x + dx,
        y = c.y + dy;
      if (document.elementFromPoint(x, y) !== s.renderer.domElement) continue;
      s.pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      if (s.pickKey() === key) return { x, y };
    }
    return null;
  }, key);
}
const check = (name, data = {}) => {
  report.checks.push({ name, status: 'PASS', ...data });
  console.log('PASS', name);
};
try {
  for (const spec of [
    { width: 1512, height: 1100, touch: false },
    { width: 390, height: 844, touch: true },
    { width: 568, height: 320, touch: true },
  ]) {
    const p = await browser.newPage({
      viewport: { width: spec.width, height: spec.height },
      hasTouch: spec.touch,
      isMobile: spec.touch,
    });
    p.on('pageerror', (e) => report.errors.push(e.message));
    await p.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
    await p.getByRole('button', { name: 'PLAY SCENARIO', exact: true }).click();
    await p.getByRole('button', { name: 'START SCENARIO', exact: true }).click();
    await p.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
    const fixture = await p.evaluate(async () => {
      const h = window.__ironRidge,
        g = h.store.getState().game,
        e = h.engine;
      const { nearbyHqForTile } = await import('/src/lib/holders.ts');
      const hq = e.garrisonOf(g, 'A'),
        actor = g.armies.find((a) => a.kind === 'commander' && a.team === 'A');
      const reach = e.commanderReach(g, actor);
      const candidates = [...reach]
        .filter(([key]) => key !== actor.pos && nearbyHqForTile(g, 'A', key)?.id === hq.id)
        .map(([key, cost]) => ({ key, cost }));
      return { hq: structuredClone(hq), actor: structuredClone(actor), candidates };
    });
    assert.ok(fixture.candidates.length);
    await p.evaluate((key) => {
      const s = window.__ironRidge.scene;
      s.focus(key);
      s.viewSizeGoal = 12;
    }, fixture.hq.pos);
    await p.waitForFunction(() => {
      const s = window.__ironRidge.scene;
      return (
        Math.abs(s.viewSize - s.viewSizeGoal) < 0.005 && s.target.distanceTo(s.targetGoal) < 0.005
      );
    });
    const before = await state(p),
      beforeHash = hash(JSON.stringify(before.game));
    // Pick a raycast-confirmed point that is not covered by chrome/labels.
    let dest, point;
    for (const c of fixture.candidates) {
      const xy = await hit(p, c.key);
      if (xy) {
        dest = c;
        point = xy;
        break;
      }
    }
    assert.ok(dest, 'Visible empty HQ neighbor');
    const input = async (xy) =>
      spec.touch ? p.touchscreen.tap(xy.x, xy.y) : p.mouse.click(xy.x, xy.y);
    await input(point);
    let now = await state(p);
    assert.equal(now.ui.inspectedCell, dest.key);
    assert.equal(now.ui.selectedArmy, before.ui.selectedArmy);
    assert.equal(now.ui.selectedEntity, null);
    assert.equal(hash(JSON.stringify(now.game)), beforeHash);
    const context = p.getByTestId('selection-context');
    assert.equal(await context.locator('[data-entity-id]').count(), 0);
    const nearby = context.getByRole('button', { name: 'SELECT NEARBY HQ', exact: true });
    await nearby.waitFor();
    if (spec.touch) await nearby.tap();
    else {
      await nearby.focus();
      await p.keyboard.press('Enter');
    }
    now = await state(p);
    assert.equal(now.ui.inspectedCell, fixture.hq.pos);
    assert.equal(hash(JSON.stringify(now.game)), beforeHash);
    assert.ok(now.ui.selectedEntity);
    check(
      `Empty-ring inspection and explicit actual-HQ ${spec.touch ? 'touch' : 'keyboard'} navigation ${spec.width}x${spec.height}`,
      { ring: dest.key, hq: fixture.hq.pos },
    );
    const shot = `hq-context-${spec.width}x${spec.height}.png`;
    await p.screenshot({ path: `${out}/${shot}` });
    report.screenshots.push(shot);
    // Hide mobile context to give the original map input its full viewport.
    const hide = p.getByRole('button', { name: 'HIDE CONTEXT', exact: true });
    if (spec.touch && (await hide.count())) await hide.tap();
    // Selecting a real commander still takes precedence over nearby HQ access.
    const actorHit = await hit(p, fixture.actor.pos);
    assert.ok(actorHit, 'Visible commander');
    await input(actorHit);
    now = await state(p);
    assert.equal(now.ui.selectedArmy, fixture.actor.id);
    if (spec.touch && (await hide.count())) await hide.tap();
    point = await hit(p, dest.key);
    assert.ok(point);
    await input(point);
    now = await state(p);
    assert.equal(now.ui.selectedArmy, fixture.actor.id);
    assert.equal(now.ui.inspectedCell, dest.key);
    assert.equal(hash(JSON.stringify(now.game)), beforeHash);
    assert.equal(
      await p.getByRole('dialog', { name: 'MOVE command preview', exact: true }).count(),
      0,
    );
    // Open native hover/hold context for the explicit MOVE, rather than a tile-body order.
    if (spec.touch && (await hide.count())) await hide.tap();
    point = await hit(p, dest.key);
    assert.ok(point);
    if (spec.touch) {
      const cdp = await p.context().newCDPSession(p);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: point.x, y: point.y }],
      });
      await p.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else await p.mouse.move(point.x, point.y);
    const callout = p.locator('[data-callout-kind="target"]');
    await callout.getByRole('button', { name: 'SELECT NEARBY HQ', exact: true }).waitFor();
    assert.equal(
      await callout.getByRole('button', { name: 'SELECT HQ GARRISON', exact: true }).count(),
      0,
    );
    const move = callout.getByRole('button', { name: 'MOVE', exact: true });
    if (spec.touch) await move.tap();
    else await move.click();
    const confirm = p.getByRole('button', { name: 'CONFIRM MOVE', exact: true });
    await confirm.waitFor();
    assert.equal(hash(JSON.stringify((await state(p)).game)), beforeHash);
    if (spec.touch) await confirm.tap();
    else {
      await confirm.focus();
      await p.keyboard.press('Enter');
    }
    now = await state(p);
    const moved = now.game.armies.find((a) => a.id === fixture.actor.id);
    assert.equal(moved.pos, dest.key);
    assert.equal(moved.movesLeft, fixture.actor.movesLeft - dest.cost);
    assert.deepEqual(
      await p.evaluate(() =>
        window.__ironRidge.engine.validateGameState(window.__ironRidge.store.getState().game),
      ),
      [],
    );
    check(
      `Retained actor; separate MOVE confirms exactly ${dest.cost} movement at ${spec.width}x${spec.height}`,
      {
        origin: fixture.actor.pos,
        destination: dest.key,
        before: fixture.actor.movesLeft,
        after: moved.movesLeft,
      },
    );
    await p.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(await hashes(), report.sourceHashes, 'Source changed during browser validation');
} catch (error) {
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  await fs.writeFile(`${out}/browser-hq-context.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}

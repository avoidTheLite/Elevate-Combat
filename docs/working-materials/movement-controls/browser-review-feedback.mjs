// Native browser input; prepared engine-valid fixtures enter through the real save importer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.REVIEW_EVIDENCE_DIR ?? '/tmp/interface-review2/browser';
await fs.mkdir(out, { recursive: true });
const hash = (x) => createHash('sha256').update(x).digest('hex');
const paths = execFileSync('git', ['ls-files', 'apps/web/src', 'packages/engine/src'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');
paths.push('docs/working-materials/movement-controls/browser-review-feedback.mjs');
const hashes = async () =>
  Object.fromEntries(await Promise.all(paths.map(async (p) => [p, hash(await fs.readFile(p))])));
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: await hashes(),
  checks: [],
  screenshots: [],
  errors: [],
  environment: 'Cloud Chromium/SwiftShader; emulated touch, not physical-device certification.',
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
const check = (name, data = {}) => {
  report.checks.push({ name, status: 'PASS', ...data });
  console.log('PASS', name);
};
const game = (p) => p.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
const gameHash = async (p) => hash(JSON.stringify(await game(p)));
async function fresh({
  width = 1512,
  height = 1100,
  touch = false,
  mode = 'normal',
  home = false,
} = {}) {
  const p = await browser.newPage({
    viewport: { width, height },
    isMobile: touch,
    hasTouch: touch,
  });
  p.on('pageerror', (e) => report.errors.push(e.message));
  if (mode !== 'normal')
    await p.addInitScript((mode) => {
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'iron-ridge:proposed-map-controls:v1')
          throw new DOMException(mode, mode === 'quota' ? 'QuotaExceededError' : 'SecurityError');
        return set.call(this, k, v);
      };
      if (mode === 'blocked')
        Storage.prototype.getItem = function (k) {
          if (k === 'iron-ridge:proposed-map-controls:v1')
            throw new DOMException('blocked', 'SecurityError');
          return get.call(this, k);
        };
    }, mode);
  await p.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  if (!home) {
    await p.getByRole('button', { name: 'QUICK START TACTICAL CONTROLS', exact: true }).click();
    await p.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  }
  return p;
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
      const matches = (x, y) => {
        s.pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
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
try {
  // Native Tab defaults are exercised here; jsdom only verifies trap interception.
  for (const spec of [
    { width: 1512, height: 1100 },
    { width: 390, height: 844, touch: true },
  ]) {
    const p = await fresh(spec),
      before = await gameHash(p),
      log = p.getByRole('button', { name: 'LOG', exact: true });
    await log.focus();
    await p.keyboard.press('Enter');
    await p.getByRole('button', { name: 'CLOSE LOG', exact: true }).waitFor();
    assert.equal(await p.evaluate(() => document.activeElement.textContent.trim()), 'CLOSE LOG');
    await p.keyboard.press('Tab');
    assert.equal(await p.evaluate(() => document.activeElement.tagName), 'SUMMARY');
    await p.keyboard.press('Enter');
    assert.equal(
      await p
        .getByRole('dialog', { name: 'Game log' })
        .locator('details')
        .evaluate((e) => e.open),
      true,
    );
    await shot(p, `log-keyboard-${spec.width}x${spec.height}`);
    await p.keyboard.press('Tab');
    assert.equal(await p.evaluate(() => document.activeElement.textContent.trim()), 'CLOSE LOG');
    await p.keyboard.press('Shift+Tab');
    assert.equal(await p.evaluate(() => document.activeElement.tagName), 'SUMMARY');
    await p.keyboard.press('Shift+Tab');
    assert.equal(await p.evaluate(() => document.activeElement.textContent.trim()), 'CLOSE LOG');
    await p.keyboard.press('Escape');
    await p.getByRole('dialog', { name: 'Game log' }).waitFor({ state: 'detached' });
    assert.equal(await p.evaluate(() => document.activeElement.textContent.trim()), 'LOG');
    await log.click();
    await p.getByRole('button', { name: 'CLOSE LOG', exact: true }).click();
    assert.equal(await p.evaluate(() => document.activeElement.textContent.trim()), 'LOG');
    assert.equal(await gameHash(p), before);
    check(
      `Native log Tab/Shift+Tab, Enter expansion, Escape/close and focus restoration ${spec.width}x${spec.height}`,
    );
    await p.close();
  }
  for (const spec of [
    { mode: 'normal', width: 1512, height: 1100 },
    { mode: 'quota', width: 390, height: 844, touch: true },
    { mode: 'blocked', width: 568, height: 320, touch: true },
  ]) {
    const p = await fresh(spec),
      before = await gameHash(p);
    await p.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await p.getByRole('checkbox', { name: 'Quick Move' }).check();
    await p.getByRole('checkbox', { name: 'Quick Attack' }).check();
    await p.getByLabel('Hover delay', { exact: true }).fill('1200');
    await p.getByLabel('Animation duration', { exact: true }).fill('300');
    assert.equal(await p.getByRole('checkbox', { name: 'Quick Move' }).isChecked(), true);
    await p.getByRole('button', { name: 'CLOSE SETTINGS', exact: true }).click();
    await p.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    assert.equal(await p.getByRole('checkbox', { name: 'Quick Move' }).isChecked(), true);
    assert.equal(await p.getByRole('checkbox', { name: 'Quick Attack' }).isChecked(), true);
    assert.equal(await p.getByLabel('Hover delay', { exact: true }).inputValue(), '1200');
    assert.equal(await p.getByLabel('Animation duration', { exact: true }).inputValue(), '300');
    await shot(p, `preferences-${spec.mode}`);
    await p.getByRole('button', { name: 'CLOSE SETTINGS', exact: true }).click();
    assert.equal(await gameHash(p), before);
    const choices = await p.evaluate(async () => {
      const h = window.__ironRidge,
        { game: g, ui } = h.store.getState(),
        { commandAt } = await import('/src/controls/commands.ts');
      const unit = g.battle.units.find((u) => u.id === ui.selectedUnit);
      return [...h.engine.reachable(h.engine.contextFor(g), unit).keys()]
        .map((key) => commandAt(g, ui, key, 'move'))
        .filter((c) => c?.kind === 'move');
    });
    let c, xy;
    for (const candidate of choices) {
      const point = await hit(p, candidate.target);
      if (point) {
        c = candidate;
        xy = point;
        break;
      }
    }
    assert.ok(c);
    const expected = await p.evaluate(
      (c) =>
        window.__ironRidge.engine.apply(window.__ironRidge.store.getState().game, c.action).state,
      c,
    );
    if (spec.touch) await p.touchscreen.tap(xy.x, xy.y);
    else await p.mouse.click(xy.x, xy.y);
    await p.waitForFunction(
      (key) =>
        window.__ironRidge.store
          .getState()
          .game.battle.units.some(
            (u) => u.id === window.__ironRidge.store.getState().ui.selectedUnit && u.pos === key,
          ),
      c.target,
    );
    assert.deepEqual(await game(p), expected);
    assert.equal(await p.getByTestId('map-command-preview').count(), 0);
    check(
      `${spec.mode} storage: cumulative live preferences survive Settings remount and immediately drive exact QuickMove ${spec.width}x${spec.height}`,
    );
    await p.close();
  }
  for (const spec of [
    { kind: 'hq', width: 1512, height: 1100 },
    { kind: 'node', width: 1512, height: 1100 },
    { kind: 'node', width: 568, height: 320, touch: true },
  ]) {
    const p = await fresh({ ...spec, home: true });
    const fixture = await p.evaluate(async (kind) => {
      const { garrisonContextFixture } = await import('/src/controls/reviewFixtures.ts');
      const f = garrisonContextFixture(kind, true);
      return {
        ...f,
        save: window.__ironRidge.engine.serializeSave(
          f.game,
          'Prepared legal center guard',
          '2026-11-09T00:00:00.000Z',
        ),
      };
    }, spec.kind);
    await p.getByRole('button', { name: 'RESUME GAME', exact: true }).click();
    await p.getByLabel('Import save file').setInputFiles({
      name: 'center-guard.json',
      mimeType: 'application/json',
      buffer: Buffer.from(fixture.save),
    });
    await p.waitForFunction(() => window.__ironRidge.store.getState().game?.phase === 'strategic');
    const handoff = p.getByRole('button', { name: /I AM ALPHA.*CONTINUE/ });
    if (await handoff.count()) await handoff.click();
    await p.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
    await p.evaluate((key) => {
      const s = window.__ironRidge.scene;
      s.focus(key);
      s.viewSizeGoal = 12;
    }, fixture.center);
    await p.waitForFunction(() => {
      const s = window.__ironRidge.scene;
      return (
        Math.abs(s.viewSize - s.viewSizeGoal) < 0.005 && s.target.distanceTo(s.targetGoal) < 0.005
      );
    });
    const before = await gameHash(p);
    const xy = await hit(p, fixture.center);
    assert.ok(xy);
    if (spec.touch) await p.touchscreen.tap(xy.x, xy.y);
    else await p.mouse.click(xy.x, xy.y);
    const context = p.getByTestId('selection-context');
    await context.getByRole('button', { name: 'Select TILE GARRISON', exact: true }).waitFor();
    assert.equal(await p.getByTestId('entity-context-body').count(), 2);
    const guard = context.getByRole('button', { name: 'Select TILE GARRISON', exact: true });
    if (spec.touch) await guard.tap();
    else await guard.click();
    assert.equal(
      await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedArmy),
      fixture.temporaryId,
    );
    if (spec.touch) {
      // The in-tile choices cover a small tile at this zoom. Exercise its native
      // context-card alternative; permanent callout IDs are exercised on desktop.
      const nodeId = `node:${fixture.game.infrastructure.sites.find((s) => s.centerSubHex === fixture.center).nodeId}`;
      await context.locator(`[data-entity-id="${nodeId}"]`).locator('button').first().tap();
      assert.equal(
        await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedEntity),
        nodeId,
      );
      assert.equal(
        await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedArmy),
        null,
      );
      assert.equal(await gameHash(p), before);
      await shot(p, `garrison-cards-touch-${spec.width}x${spec.height}`);
      check(
        `Touch context cards keep the actual stationed guard and combined node separately selectable without spending ${spec.width}x${spec.height}`,
      );
      await p.close();
      continue;
    }
    const hide = p.getByRole('button', { name: 'HIDE CONTEXT', exact: true });
    if (spec.touch && (await hide.count())) {
      await hide.tap();
      await p.waitForTimeout(250);
    }
    // Reinspect the shared tile to return to its unchosen multi-entity context.
    let point = await hit(p, fixture.center);
    assert.ok(point);
    if (spec.touch) await p.touchscreen.tap(point.x, point.y);
    else await p.mouse.click(point.x, point.y);
    if (spec.touch && (await hide.count())) {
      await hide.tap();
      await p.waitForTimeout(250);
    }
    point = await hit(p, fixture.center);
    assert.ok(point);
    if (spec.touch) {
      const cdp = await p.context().newCDPSession(p);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: point.x, y: point.y }],
      });
      await p.waitForTimeout(1200);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await p.mouse.move(0, 0);
      await p.mouse.move(point.x, point.y);
    }
    const label = spec.kind === 'hq' ? 'SELECT HQ GARRISON' : 'SELECT NODE GARRISON',
      callout = p.locator('[data-callout-kind="target"]');
    await callout.getByRole('button', { name: label, exact: true }).waitFor();
    if (spec.touch) await callout.getByRole('button', { name: label, exact: true }).tap();
    else {
      await callout.getByRole('button', { name: label, exact: true }).focus();
      await p.keyboard.press('Enter');
    }
    assert.equal(
      await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedEntity),
      `node:${fixture.game.infrastructure.sites.find((s) => s.centerSubHex === fixture.center).nodeId}`,
    );
    assert.equal(await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedArmy), null);
    assert.equal(await gameHash(p), before);
    const show = p.getByRole('button', { name: 'CONTEXT', exact: true });
    if (spec.touch && (await show.count())) await show.tap();
    await shot(p, `garrison-context-${spec.kind}-${spec.width}x${spec.height}`);
    check(
      `${spec.kind} center: imported engine-valid stationed guard stays selectable; permanent callout selects actual node card without spending ${spec.width}x${spec.height}`,
    );
    await p.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(await hashes(), report.sourceHashes, 'Source changed during validation');
} catch (error) {
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  await fs.writeFile(`${out}/browser-review-feedback.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}

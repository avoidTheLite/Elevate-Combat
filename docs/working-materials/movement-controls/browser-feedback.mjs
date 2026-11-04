// Real browser proof for Justin's popup feedback. Debug hooks inspect game/coordinates only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.UX_FEEDBACK_EVIDENCE_DIR ?? '/tmp/popup-browser-feedback';
await fs.mkdir(out, { recursive: true });
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  environment: 'Cloud Chromium/SwiftShader. Touch is trusted CDP emulation, not a physical device.',
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
const check = (name, data = {}) => {
  report.checks.push({ name, status: 'PASS', ...data });
  console.log('PASS', name);
};
const game = (p) => p.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
async function fresh(touch = false) {
  const p = await browser.newPage({
    viewport: touch ? { width: 390, height: 844 } : { width: 1512, height: 1100 },
    hasTouch: touch,
    isMobile: touch,
  });
  p.on('pageerror', (e) => report.errors.push(e.message));
  await p.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  await p.getByRole('button', { name: 'OPEN PREPARED TACTICAL CONTROLS', exact: true }).click();
  await p.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  await p.waitForTimeout(800);
  return p;
}
async function point(p, key) {
  return p.evaluate((key) => {
    const s = window.__ironRidge.scene,
      c = s.projectKey(key),
      r = s.renderer.domElement.getBoundingClientRect();
    if (!c) return null;
    for (const [dx, dy] of [
      [0, 0],
      [0, 7],
      [0, -7],
      [7, 0],
      [-7, 0],
      [12, 7],
      [-12, -7],
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
async function shot(p, name) {
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  report.screenshots.push(`${name}.png`);
}
async function visibleConfirm(p, name) {
  const button = p.getByRole('button', { name, exact: true });
  assert.ok(await button.isVisible());
  assert.ok(
    await button.evaluate((e) => {
      const r = e.getBoundingClientRect(),
        c = e.closest('.map-callout').getBoundingClientRect();
      return r.top >= c.top && r.bottom <= c.bottom + 1 && r.bottom <= innerHeight;
    }),
    'Confirm remains inside card and viewport',
  );
}
try {
  const p = await fresh(),
    before = await game(p),
    id = await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedUnit),
    unit = before.battle.units.find((u) => u.id === id);
  await p.mouse.move(1400, 18);
  await p.waitForTimeout(800);
  assert.equal(await p.locator('.map-callout').count(), 0);
  await shot(p, '01-selected-no-popup');
  check('Mouse idle selection has no persistent action popup');
  const origin = await point(p, unit.pos);
  assert.ok(origin);
  await p.mouse.move(origin.x, origin.y);
  await p.waitForTimeout(650);
  assert.equal(await p.locator('[aria-label="Contextual unit actions"]').count(), 1);
  assert.equal(await p.locator('[data-callout-kind="selected"]').count(), 0);
  assert.deepEqual(await game(p), before);
  check('Mouse dwell retains contextual tile actions without spending');
  await p.mouse.move(1400, 18);
  await p.waitForTimeout(850);
  assert.equal(await p.locator('.map-callout').count(), 0);
  check('Context callout leaves after dwell while selection remains');
  await p.getByRole('button', { name: 'Selected tile actions', exact: true }).click();
  await p
    .locator('[aria-label="Contextual unit actions"]')
    .getByRole('button', { name: 'MOVE', exact: true })
    .click();
  const keys = await p.evaluate(() => {
    const h = window.__ironRidge,
      g = h.store.getState().game,
      u = g.battle.units.find((u) => u.id === h.store.getState().ui.selectedUnit);
    return [...h.engine.reachable(h.engine.contextFor(g), u).keys()].filter(
      (k) =>
        k !== u.pos && h.engine.apply(g, { type: 'move', unitId: u.id, cell: k }).error === null,
    );
  });
  let dest, hit;
  for (const k of keys) {
    hit = await point(p, k);
    if (hit) {
      dest = k;
      break;
    }
  }
  assert.ok(hit);
  await p.mouse.click(hit.x, hit.y);
  await p.getByTestId('map-command-preview').waitFor();
  assert.equal(await p.locator('.map-callout').count(), 1);
  assert.equal(await p.locator('.map-command-help[open]').count(), 0);
  assert.ok(
    !(await p
      .getByText('Movement preserves the remaining action when the rules allow.', { exact: true })
      .isVisible()),
  );
  assert.deepEqual(await game(p), before);
  await shot(p, '02-compact-move-preview');
  const cdp = await p.context().newCDPSession(p),
    ax = await cdp.send('Accessibility.getFullAXTree');
  const confirm = ax.nodes.find(
    (n) => n.role?.value === 'button' && n.name?.value === 'CONFIRM MOVE',
  );
  assert.match(confirm?.description?.value ?? '', /MP/);
  await cdp.detach();
  check(
    'Preview prose hidden by default; hover title and browser accessibility description retain cost',
  );
  const help = p.locator('summary[aria-label="MOVE command details"]');
  await help.focus();
  const camera = await p.evaluate(() => window.__ironRidge.scene.targetGoal.toArray());
  await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(100);
  assert.deepEqual(await p.evaluate(() => window.__ironRidge.scene.targetGoal.toArray()), camera);
  await p.keyboard.press('Enter');
  assert.equal(await p.locator('.map-command-help[open]').count(), 1);
  await visibleConfirm(p, 'CONFIRM MOVE');
  assert.deepEqual(await game(p), before);
  check('Keyboard Help opens with Enter, yields camera keys and preserves game state');
  await p.keyboard.press('Escape');
  assert.equal(await p.getByTestId('map-command-preview').count(), 0);
  await p.locator('canvas').focus();
  await p.keyboard.press('Shift+F10');
  assert.equal(await p.locator('[aria-label="Contextual unit actions"]').count(), 1);
  assert.deepEqual(await game(p), before);
  check('Trusted Shift+F10 still opens selected tile actions');
  await p.close();
  const m = await fresh(true),
    mb = await game(m);
  assert.equal(await m.locator('.map-callout').count(), 0);
  const trigger = m.getByRole('button', { name: 'Selected tile actions', exact: true });
  assert.ok((await trigger.boundingBox()).height >= 44);
  await trigger.tap();
  const group = m.locator('[aria-label="Contextual unit actions"]');
  await group.getByRole('button', { name: 'ATTACK', exact: true }).tap();
  const enemy = await m.evaluate(() => {
    const h = window.__ironRidge,
      g = h.store.getState().game,
      u = g.battle.units.find((u) => u.id === h.store.getState().ui.selectedUnit);
    return g.battle.units
      .filter(
        (t) =>
          t.team !== u.team &&
          t.pos &&
          h.engine.previewAttack(h.engine.contextFor(g), g.battle, u, t.pos).legal,
      )
      .map((t) => t.pos);
  });
  let ep;
  for (const k of enemy) {
    ep = await point(m, k);
    if (ep) break;
  }
  assert.ok(ep);
  await m.touchscreen.tap(ep.x, ep.y);
  await m.getByTestId('map-command-preview').waitFor();
  assert.equal(await m.locator('.map-command-help[open]').count(), 0);
  await shot(m, '03-mobile-compact-attack');
  check('Touch fallback reaches targeting and compact attack preview without native hold');
  await m.locator('summary[aria-label="ATTACK command details"]').tap();
  await visibleConfirm(m, 'CONFIRM ATTACK');
  assert.deepEqual(await game(m), mb);
  await shot(m, '04-mobile-optional-help');
  await m.getByRole('button', { name: 'CANCEL', exact: true }).tap();
  assert.deepEqual(await game(m), mb);
  check('Touch Help scrolls without clipping Confirm; Cancel spends nothing');
  await m.getByRole('button', { name: 'DEMO CONTROLS', exact: true }).tap();
  const pref = m.getByRole('dialog', { name: 'Proposed map control preferences' });
  assert.equal(await pref.locator('details[open]').count(), 0);
  await pref.locator('summary[aria-label="Control preference help"]').tap();
  assert.equal(await pref.locator('details[open]').count(), 1);
  assert.deepEqual(await game(m), mb);
  check('Preference prose is optional touch-accessible Help');
  await m.close();
  for (const viewport of [
    { width: 568, height: 320 },
    { width: 320, height: 568 },
  ]) {
    const small = await fresh(true);
    await small.setViewportSize(viewport);
    await small.getByRole('button', { name: 'SELECT ENG', exact: true }).tap();
    const original = await game(small);
    await small.getByRole('button', { name: 'Selected tile actions', exact: true }).tap();
    const card = small.locator('.map-callout[data-callout-mode="context"]');
    assert.equal(await card.evaluate((e) => getComputedStyle(e).overflowY), 'auto');
    const deselect = card.getByRole('button', { name: 'DESELECT', exact: true });
    await deselect.scrollIntoViewIfNeeded();
    assert.ok(
      await deselect.evaluate((e) => {
        const r = e.getBoundingClientRect(),
          c = e.closest('.map-callout').getBoundingClientRect();
        return r.top >= c.top && r.bottom <= c.bottom + 1 && r.bottom <= innerHeight;
      }),
    );
    await shot(small, `05-context-scroll-${viewport.width}x${viewport.height}`);
    await deselect.tap();
    assert.equal(await small.locator('.map-callout').count(), 0);
    assert.deepEqual(await game(small), original);
    check(
      `Small ${viewport.width}x${viewport.height} contextual actions scroll and remain reachable`,
    );
    await small.close();
  }
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(`${out}/browser-feedback.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}

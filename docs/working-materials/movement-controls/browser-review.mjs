// PR18 review proof. Fixtures enter through the real save-file UI; debug hooks only
// construct validated initial fixtures, inspect state, and project/raycast coordinates.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.UX_REVIEW_EVIDENCE_DIR ?? '/tmp/pr18-review-browser';
const url = process.env.QA_URL ?? 'http://127.0.0.1:5173/';
await fs.mkdir(out, { recursive: true });
const sourcePaths = [
  'apps/web/src/controls/attackPresentation.ts',
  'apps/web/src/controls/commands.ts',
  'apps/web/src/controls/useMapControls.ts',
  'apps/web/src/controls/MapCallouts.tsx',
  'apps/web/src/controls/reviewFixtures.ts',
  'apps/web/src/components/game/TacticalSidebar.tsx',
  'apps/web/src/render/HexScene.ts',
  'apps/web/src/index.css',
];
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(sourcePaths.map(async (p) => [p, sha(await fs.readFile(p))])),
  );
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  sourceHashes: await sourceHashes(),
  environment: 'Chromium/SwiftShader; touch uses trusted CDP emulation, not a physical device.',
  checks: [],
  errors: [],
  screenshots: [],
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
const check = (name, details = {}) => {
  report.checks.push({ name, status: 'PASS', ...details });
  console.log('PASS', name);
};
const state = (p) => p.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
const stateHash = async (p) => sha(JSON.stringify(await state(p)));
async function page(touch = false) {
  const p = await browser.newPage({
    viewport: touch ? { width: 568, height: 320 } : { width: 1512, height: 1100 },
    hasTouch: touch,
    isMobile: touch,
  });
  p.on('pageerror', (e) => report.errors.push(e.message));
  await p.goto(url);
  return p;
}
async function ready(p) {
  await p.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  await p.waitForTimeout(700);
}
async function prepared(touch = false) {
  const p = await page(touch);
  await p.getByRole('button', { name: 'OPEN PREPARED TACTICAL CONTROLS', exact: true }).click();
  await ready(p);
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
const forbidden = /\bTN\s|direct hit|splash\s*\d|Expected damage|armor|armour|\bSide\b|\bFront\b/i;
async function privacyCase({ occupied, fog }) {
  const p = await page();
  const fixture = await p.evaluate(
    async ({ occupied, fog }) => {
      const { blindFireFixture } = await import('/src/controls/reviewFixtures.ts');
      const f = blindFireFixture(),
        engine = window.__ironRidge.engine;
      if (occupied) {
        const hidden = f.battle.units.find((u) => u.team === 'B');
        hidden.pos = f.target;
        const source = f.game.armies
          .find((a) => a.id === hidden.holderId)
          .units.find((u) => u.id === hidden.id);
        hidden.typeId = source.typeId = 'ww2_tank';
        hidden.hp = source.hp = hidden.maxHp = engine.unitType('ww2_tank').hp;
      }
      f.game.settings.fog = fog;
      const errors = engine.validateGameState(f.game);
      if (errors.length) throw new Error(errors.join('; '));
      const ctx = engine.buildContext(f.game.settings, f.battle),
        preview = engine.previewAttack(ctx, f.battle, f.shooter, f.target);
      if (!preview.legal || !preview.blind) throw new Error('Expected legal blind-fire fixture');
      return {
        save: engine.serializeSave(f.game, 'PR18 initial review fixture', '2026-11-04T00:00:00Z'),
        shooterId: f.shooter.id,
        origin: f.shooter.pos,
        target: f.target,
        preview: { blind: preview.blind, tn: preview.tn, expectedDamage: preview.expectedDamage },
        errors,
      };
    },
    { occupied, fog },
  );
  await p.getByLabel('Import save file', { exact: true }).setInputFiles({
    name: 'pr18-review-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(fixture.save),
  });
  const handoff = p.getByRole('button', { name: /^I AM .*CONTINUE$/ });
  if (fog) await handoff.click();
  await ready(p);
  const before = await stateHash(p),
    origin = await point(p, fixture.origin);
  assert.ok(origin, 'Shooter body has an ordinary canvas hit');
  await p.mouse.click(origin.x, origin.y);
  await p.waitForTimeout(600);
  assert.equal(
    await p.evaluate(() => window.__ironRidge.store.getState().ui.selectedUnit),
    fixture.shooterId,
  );
  await p.getByRole('button', { name: 'Selected tile actions', exact: true }).click();
  await p
    .getByLabel('Contextual unit actions')
    .getByRole('button', { name: 'ATTACK', exact: true })
    .click();
  const target = await point(p, fixture.target);
  assert.ok(target, 'Blind target has an ordinary canvas hit');
  await p.mouse.click(target.x, target.y);
  const dialog = p.getByRole('dialog', { name: 'ATTACK command preview', exact: true });
  await dialog.waitFor();
  await dialog.locator('summary').click();
  const details = await dialog.locator('.map-preview-details').innerText(),
    title = await dialog
      .getByRole('button', { name: 'CONFIRM ATTACK', exact: true })
      .getAttribute('title'),
    sidebar = await p.getByTestId('target-detail').innerText();
  const cdp = await p.context().newCDPSession(p),
    ax = await cdp.send('Accessibility.getFullAXTree');
  const axDetails = ax.nodes
    .filter(
      (n) =>
        (n.role?.value === 'button' && n.name?.value === 'CONFIRM ATTACK') ||
        (n.role?.value === 'dialog' && n.name?.value === 'ATTACK command preview'),
    )
    .map((n) => ({
      role: n.role.value,
      name: n.name.value,
      description: n.description?.value ?? '',
    }));
  assert.equal(axDetails.length, 2);
  if (fog) {
    for (const text of [details, title, sidebar, ...axDetails.map((n) => n.description)]) {
      assert.match(text, /Defender statistics are unknown/);
      assert.doesNotMatch(text, forbidden);
    }
  } else {
    for (const text of [details, title, ...axDetails.map((n) => n.description)]) {
      assert.match(text, /TN\s/);
      assert.match(text, /Expected damage/);
    }
    assert.match(sidebar, /TN/);
  }
  await shot(p, `${fog ? 'blind' : 'fog-off'}-${occupied ? 'hidden-tank' : 'empty'}-help`);
  await p.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  assert.equal(await stateHash(p), before);
  check(
    `${fog ? 'Blind' : 'Fog-off'} ${occupied ? 'hidden tank' : 'empty ground'} Help/title/actual AX and sidebar`,
    {
      details,
      title,
      sidebar,
      axDetails,
      enginePreview: fixture.preview,
      fixtureValidationErrors: fixture.errors,
      gameHashBefore: before,
      gameHashAfter: await stateHash(p),
    },
  );
  await cdp.detach();
  await p.close();
  return { details, title, axDetails };
}
async function hoverFocusLifetime() {
  const p = await prepared(),
    before = await stateHash(p),
    key = await p.evaluate(() => {
      const s = window.__ironRidge.store.getState();
      return s.game.battle.units.find((u) => u.id === s.ui.selectedUnit).pos;
    });
  const events = [];
  for (const retain of ['focus', 'pointer']) {
    await p.mouse.move(1400, 18);
    const origin = await point(p, key);
    assert.ok(origin);
    await p.mouse.move(origin.x, origin.y);
    const card = p.locator('.map-callout[data-callout-mode="context"]');
    await card.waitFor();
    await card.evaluate((c) => {
      window.reviewCardEvents = [];
      for (const type of ['pointerenter', 'pointerleave', 'focusin', 'focusout'])
        c.addEventListener(type, (e) =>
          window.reviewCardEvents.push({ type: e.type, isTrusted: e.isTrusted }),
        );
    });
    const button = card.getByRole('button', { name: 'MOVE', exact: true }),
      rect = await button.boundingBox();
    await p.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2, { steps: 8 });
    await button.focus();
    if (retain === 'focus') await p.mouse.move(1400, 18);
    else await p.locator('canvas').focus();
    await p.waitForTimeout(1000);
    assert.equal(await card.count(), 1, `${retain} alone retains hovered card`);
    if (retain === 'focus') await p.locator('canvas').focus();
    else await p.mouse.move(1400, 18);
    await p.waitForTimeout(850);
    assert.equal(await card.count(), 0, 'Card exits after both pointer and focus leave');
    events.push({ retainedBy: retain, events: await p.evaluate(() => window.reviewCardEvents) });
    assert.equal(await stateHash(p), before);
  }
  check('Real hovered card tracks keyboard focus and pointer independently', {
    events,
    gameHashBefore: before,
    gameHashAfter: await stateHash(p),
  });
  await p.close();
}
async function destination(p) {
  const keys = await p.evaluate(() => {
    const h = window.__ironRidge,
      g = h.store.getState().game,
      u = g.battle.units.find((unit) => unit.id === h.store.getState().ui.selectedUnit);
    return [...h.engine.reachable(h.engine.contextFor(g), u).keys()].filter(
      (key) =>
        key !== u.pos &&
        h.engine.apply(g, { type: 'move', unitId: u.id, cell: key }).error === null,
    );
  });
  for (const key of keys) {
    const hit = await point(p, key);
    if (hit) return { key, ...hit };
  }
  throw new Error('No ordinary canvas destination');
}
async function cancellationAndScroll() {
  const p = await prepared(),
    before = await stateHash(p),
    key = await p.evaluate(() => {
      const s = window.__ironRidge.store.getState();
      return s.game.battle.units.find((u) => u.id === s.ui.selectedUnit).pos;
    }),
    origin = await point(p, key),
    dest = await destination(p);
  assert.ok(origin);
  await p.mouse.move(origin.x, origin.y);
  await p.mouse.down();
  await p.mouse.move(dest.x, dest.y, { steps: 8 });
  assert.equal(await p.getByTestId('map-command-preview').count(), 1);
  await p.keyboard.press('Escape');
  await p.mouse.move(dest.x + 3, dest.y + 3);
  await p.mouse.up();
  assert.equal(await p.getByTestId('map-command-preview').count(), 0);
  assert.deepEqual(
    await p.evaluate(() => ({
      dragging: window.__ironRidge.scene.dragging,
      activePointers: window.__ironRidge.scene.activePointers.size,
    })),
    { dragging: null, activePointers: 0 },
  );
  assert.equal(await stateHash(p), before);
  check('Escape relinquishes pointer ownership; later motion/release cannot revive preview', {
    gameHashBefore: before,
    gameHashAfter: await stateHash(p),
  });
  await p.close();
  const m = await prepared(true),
    original = await stateHash(m),
    target = await destination(m);
  await m.touchscreen.tap(target.x, target.y);
  const card = m.locator('.map-callout[data-callout-mode="preview"]');
  await card.waitFor();
  assert.equal(await card.evaluate((c) => getComputedStyle(c).overflowY), 'auto');
  const cdp = await m.context().newCDPSession(m),
    scrollPositions = [];
  for (let swipe = 0; swipe < 8; swipe++) {
    const fits = await card.getByRole('button', { name: 'CANCEL', exact: true }).evaluate((e) => {
      const r = e.getBoundingClientRect(),
        c = e.closest('.map-callout').getBoundingClientRect();
      return r.top >= c.top && r.bottom <= c.bottom && r.bottom <= innerHeight;
    });
    if (fits) break;
    const r = await card.boundingBox(),
      x = r.x + r.width - 12,
      start = r.y + r.height - 7,
      end = r.y + 7;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: start, id: 1 }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: start + ((end - start) * step) / 8, id: 1 }],
      });
      await m.waitForTimeout(55);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    scrollPositions.push(await card.evaluate((c) => c.scrollTop));
  }
  for (const name of ['CONFIRM MOVE', 'CANCEL'])
    assert.ok(
      await card.getByRole('button', { name, exact: true }).evaluate((e) => {
        const r = e.getBoundingClientRect(),
          c = e.closest('.map-callout').getBoundingClientRect();
        return (
          r.top >= c.top &&
          r.bottom <= c.bottom &&
          r.bottom <= innerHeight &&
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === e
        );
      }),
    );
  await shot(m, '568x320-whole-preview-scroll');
  await card.getByRole('button', { name: 'CANCEL', exact: true }).tap();
  assert.equal(await card.count(), 0);
  assert.equal(await stateHash(m), original);
  check('568x320 native whole-preview scroll reveals Confirm/Cancel; Cancel spends nothing', {
    scrollPositions,
    gameHashBefore: original,
    gameHashAfter: await stateHash(m),
  });
  await cdp.detach();
  await m.close();
}
try {
  const empty = await privacyCase({ occupied: false, fog: true }),
    hidden = await privacyCase({ occupied: true, fog: true });
  assert.deepEqual(hidden, empty, 'Hidden defender cannot be distinguished from empty ground');
  check('Blind empty and occupied targets have identical Help/title/actual AX presentation');
  await privacyCase({ occupied: true, fog: false });
  await hoverFocusLifetime();
  await cancellationAndScroll();
  assert.deepEqual(report.errors, []);
  report.sourceHashesAfter = await sourceHashes();
  assert.deepEqual(
    report.sourceHashesAfter,
    report.sourceHashes,
    'Application source stayed frozen',
  );
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(`${out}/browser-review.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}

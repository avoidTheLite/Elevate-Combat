// Real browser input; DEV hooks inspect rules/state/projection and camera only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.COMPACT_EVIDENCE_DIR ?? '/tmp/compact-previews/browser';
await fs.mkdir(out, { recursive: true });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const sourceFiles = [
  'apps/web/src/controls/CommandPreview.tsx',
  'apps/web/src/controls/MapCallouts.tsx',
  'apps/web/src/controls/useMapControls.ts',
  'apps/web/src/controls/types.ts',
  'apps/web/src/components/screens/GameScreen.tsx',
  'apps/web/src/render/HexScene.ts',
  'apps/web/src/render/spec.ts',
  'apps/web/src/index.css',
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(sourceFiles.map(async (file) => [file, sha(await fs.readFile(file))])),
  );
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: await hashes(),
  environment:
    'Cloud Chromium/SwiftShader; trusted CDP touch emulation, not physical-device validation.',
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
const check = (name, data = {}) => {
  report.checks.push({ name, status: 'PASS', ...data });
  console.log('PASS', name);
};
const game = (p) => p.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
const gameHash = async (p) => sha(JSON.stringify(await game(p)));
async function fresh({
  touch = false,
  width = 1512,
  height = 1100,
  reduced = false,
  regular = false,
} = {}) {
  const p = await browser.newPage({
    viewport: { width, height },
    hasTouch: touch,
    isMobile: touch,
  });
  p.on('pageerror', (e) => report.errors.push(e.message));
  if (reduced) await p.emulateMedia({ reducedMotion: 'reduce' });
  await p.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  await p
    .getByRole('button', {
      name: regular ? 'START READY MOVEMENT CAMPAIGN' : 'OPEN PREPARED TACTICAL CONTROLS',
      exact: true,
    })
    .click();
  await p.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  await p.waitForFunction(() => {
    const s = window.__ironRidge.scene;
    return (
      Math.abs(s.viewSize - s.viewSizeGoal) < 0.005 && s.target.distanceTo(s.targetGoal) < 0.005
    );
  });
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
      if (s.pickKey() === key) {
        const solid = [
          [-2, -2],
          [2, -2],
          [-2, 2],
          [2, 2],
        ].every(([sx, sy]) => {
          if (document.elementFromPoint(x + sx, y + sy) !== s.renderer.domElement) return false;
          s.pointer.set(
            ((x + sx - r.left) / r.width) * 2 - 1,
            -((y + sy - r.top) / r.height) * 2 + 1,
          );
          return s.pickKey() === key;
        });
        if (solid) return { x, y };
      }
    }
    return null;
  }, key);
}
async function moveCandidate(p, min = 3) {
  const choices = await p.evaluate(async (min) => {
    const h = window.__ironRidge,
      { game: g, ui } = h.store.getState(),
      { commandAt } = await import('/src/controls/commands.ts');
    const actor =
      g.phase === 'battle'
        ? g.battle.units.find((u) => u.id === ui.selectedUnit)
        : g.armies.find((a) => a.id === ui.selectedArmy);
    const keys =
      g.phase === 'battle'
        ? [...h.engine.reachable(h.engine.contextFor(g), actor).keys()]
        : [...h.engine.commanderReach(g, actor).keys()];
    return keys.map((key) => commandAt(g, ui, key, 'move')).filter((c) => c?.path.length >= min);
  }, min);
  for (const command of choices) {
    const hit = await point(p, command.target);
    if (hit) return { command, hit };
  }
  if (min > 2) return moveCandidate(p, 2);
  throw Error('No visible legal movement destination');
}
async function stageMove(p, { touch = false, min = 3 } = {}) {
  const c = await moveCandidate(p, min);
  if (touch) await p.touchscreen.tap(c.hit.x, c.hit.y);
  else await p.mouse.click(c.hit.x, c.hit.y);
  await p.getByRole('dialog', { name: 'MOVE command preview', exact: true }).waitFor();
  await fitControls(p);
  return c.command;
}
async function fitControls(p) {
  await p.waitForFunction(() => {
    const b = document.querySelector('.map-move-confirmation');
    if (!b) return false;
    const s = window.__ironRidge.scene,
      t = s.projectTile(b.dataset.anchorKey);
    if (!t) return false;
    const r = b.getBoundingClientRect(),
      root = s.container.getBoundingClientRect(),
      points = [
        [r.left - root.left, r.top - root.top],
        [r.right - root.left, r.top - root.top],
        [r.left - root.left, r.bottom - root.top],
        [r.right - root.left, r.bottom - root.top],
      ];
    const inside = ([x, y]) => {
      let v = false;
      for (let i = 0, j = t.corners.length - 1; i < t.corners.length; j = i++) {
        const a = t.corners[i],
          z = t.corners[j];
        if (a.y > y !== z.y > y && x < ((z.x - a.x) * (y - a.y)) / (z.y - a.y) + a.x) v = !v;
      }
      return v;
    };
    return points.every(inside);
  });
}
async function attackCandidate(p) {
  const enemies = await p.evaluate(() => {
    const h = window.__ironRidge,
      { game: g, ui } = h.store.getState();
    const unit = g.battle.units.find((u) => u.id === ui.selectedUnit),
      ctx = h.engine.contextFor(g);
    return g.battle.units.filter(
      (u) =>
        u.team !== unit.team && u.pos && h.engine.previewAttack(ctx, g.battle, unit, u.pos).legal,
    );
  });
  await p.getByTitle('Reset view (R)', { exact: true }).click();
  await p.waitForTimeout(750);
  let enemy, target;
  for (let rotation = 0; rotation < 8 && !target; rotation++) {
    for (const candidate of enemies) {
      target = await point(p, candidate.pos);
      if (target) {
        enemy = candidate;
        break;
      }
    }
    if (!target) {
      await p.getByTitle('Rotate right (E)', { exact: true }).click();
      await p.waitForTimeout(500);
    }
  }
  assert.ok(target, 'A real legal enemy tile must be clickable');
  return { enemy, target };
}
async function stageAttack(p, touch = false) {
  const { enemy, target } = await attackCandidate(p);
  if (touch) await p.touchscreen.tap(target.x, target.y);
  else await p.mouse.click(target.x, target.y);
  await p.getByRole('dialog', { name: 'ATTACK command preview', exact: true }).waitFor();
  await fitControls(p);
  return enemy;
}
async function snapshot(p) {
  return p.evaluate(() => {
    const s = window.__ironRidge.scene,
      svg = document.querySelector('.map-command-route'),
      route = svg?.querySelector('[data-command-route]'),
      line = svg?.querySelector('.map-command-line'),
      glow = svg?.querySelector('.map-command-glow'),
      box = document.querySelector('.map-move-confirmation');
    return {
      kind: svg?.dataset.kind,
      staged: svg?.dataset.staged,
      geometryCount: svg?.querySelectorAll('[data-command-route]').length,
      lineCount: svg?.querySelectorAll('.map-command-line').length,
      d: route?.getAttribute('d'),
      geometryId: route?.id,
      lineHref: line?.getAttribute('href'),
      glowHref: glow?.getAttribute('href'),
      color: svg && getComputedStyle(svg).color,
      width: line && getComputedStyle(line).strokeWidth,
      animation: glow && getComputedStyle(glow).animationName,
      dash: glow && getComputedStyle(glow).strokeDashoffset,
      duration: glow && getComputedStyle(glow).animationDuration,
      dashArray: glow && getComputedStyle(glow).strokeDasharray,
      pulseSpacing: glow && getComputedStyle(glow).getPropertyValue('--map-flow-spacing'),
      legacyEffects: s.fxGroup.children.length,
      viewSize: s.viewSize,
      viewSizeGoal: s.viewSizeGoal,
      buttons: box
        ? [...box.querySelectorAll('button')].map((b) => {
            const r = b.getBoundingClientRect();
            return {
              name: b.getAttribute('aria-label'),
              width: r.width,
              height: r.height,
              visible:
                r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
              focused: document.activeElement === b,
            };
          })
        : [],
    };
  });
}
async function shot(p, name) {
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  report.screenshots.push(`${name}.png`);
}
async function ax(p) {
  const cdp = await p.context().newCDPSession(p),
    tree = await cdp.send('Accessibility.getFullAXTree');
  await cdp.detach();
  return tree.nodes
    .filter(
      (n) =>
        n.role?.value === 'button' &&
        ['CONFIRM MOVE', 'CANCEL', 'CONFIRM ATTACK'].includes(n.name?.value),
    )
    .map((n) => ({ name: n.name.value, description: n.description?.value ?? '' }));
}
try {
  const p = await fresh(),
    before = await game(p),
    beforeHash = await gameHash(p),
    c = await moveCandidate(p);
  await p.mouse.move(c.hit.x, c.hit.y);
  await p.waitForTimeout(280);
  const hover = await snapshot(p);
  assert.equal(hover.staged, 'false');
  assert.equal(hover.width, '2px');
  assert.equal(hover.color, 'rgb(51, 255, 136)');
  assert.equal(hover.geometryCount, 1);
  assert.equal(hover.legacyEffects, 0);
  await shot(p, '01-hover-route');
  check('One thin green hover route follows the actual movement path without legacy geometry', {
    path: c.command.path,
    hover,
  });
  await p.mouse.click(c.hit.x, c.hit.y);
  await p.getByRole('dialog', { name: 'MOVE command preview' }).waitFor();
  await p.waitForTimeout(1100);
  const staged = await snapshot(p);
  assert.equal(staged.staged, 'true');
  assert.equal(staged.width, '4px');
  assert.equal(staged.geometryCount, 1);
  assert.equal(staged.lineCount, 1);
  assert.equal(staged.lineHref, staged.glowHref);
  assert.equal(staged.legacyEffects, 0);
  assert.equal(staged.buttons.length, 2);
  assert.ok(staged.buttons.every((b) => b.width === 44 && b.height === 44 && b.visible));
  assert.ok(staged.buttons[0].focused);
  assert.equal(await gameHash(p), beforeHash);
  const a11y = await ax(p);
  assert.match(a11y.find((b) => b.name === 'CONFIRM MOVE').description, /MP/);
  await shot(p, '02-staged-move-icons');
  check('Staged route is bold; two44px check/X controls have cost descriptions and do not spend', {
    staged,
    a11y,
    gameHashBefore: beforeHash,
    gameHashAfter: await gameHash(p),
  });
  const offsets = [];
  for (let i = 0; i < 3; i++) {
    offsets.push((await snapshot(p)).dash);
    await p.waitForTimeout(140);
  }
  assert.equal(staged.animation, 'map-command-flow');
  assert.equal(staged.duration, '0.9s');
  assert.ok(Math.abs((Number(staged.pulseSpacing) * (c.command.path.length - 1)) / 100 - 3) < 1e-6);
  assert.ok(new Set(offsets).size > 1);
  check('Glow moves along the shared route toward its arrow', { offsets });
  const expected = await p.evaluate(
    ({ before, command }) => window.__ironRidge.engine.apply(before, command.action).state,
    { before, command: c.command },
  );
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => !document.querySelector('[data-testid="map-command-preview"]'));
  assert.deepEqual(await game(p), expected);
  check('Keyboard Enter confirms the exact engine move once', {
    beforePosition: c.command.origin,
    afterPosition: c.command.target,
  });
  await p.close();

  const q = await fresh(),
    qHash = await gameHash(q);
  await stageMove(q);
  await q.getByRole('button', { name: 'CANCEL', exact: true }).click();
  assert.equal(await q.getByTestId('map-command-preview').count(), 0);
  assert.equal(await gameHash(q), qHash);
  check('RedX cancels without movement/AP/CP changes');
  const drag = await moveCandidate(q),
    origin = await point(q, drag.command.origin);
  assert.ok(origin);
  await q.mouse.move(origin.x, origin.y);
  await q.mouse.down();
  await q.mouse.move(drag.hit.x, drag.hit.y, { steps: 8 });
  await q.getByTestId('map-command-preview').waitFor();
  assert.ok(await q.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).isDisabled());
  await q.keyboard.press('Escape');
  await q.mouse.move(drag.hit.x + 2, drag.hit.y + 2);
  await q.mouse.up();
  await q.waitForTimeout(250);
  assert.equal(await q.getByTestId('map-command-preview').count(), 0);
  assert.equal(await gameHash(q), qHash);
  check('Active drag cannot confirm; Escape and late release cannot revive or spend');
  await q.close();

  const a = await fresh(),
    aHash = await gameHash(a);
  const enemy = await stageAttack(a);
  await a.waitForTimeout(250);
  const attack = await snapshot(a),
    enemyColor = await a.evaluate(
      (id) =>
        getComputedStyle(window.__ironRidge.scene.tokens.get(id).labelEl.querySelector('.ir-name'))
          .color,
      enemy.id,
    );
  assert.equal(attack.color, enemyColor);
  assert.equal(attack.kind, 'attack');
  assert.equal(attack.geometryCount, 1);
  assert.equal((attack.d.match(/[ML]/g) || []).length, 2);
  assert.equal(attack.legacyEffects, 0);
  assert.equal(attack.buttons.length, 2);
  assert.ok(attack.buttons.every((b) => b.width === 44 && b.height === 44 && b.visible));
  assert.equal(await a.locator('.map-callout').count(), 0);
  assert.equal(await a.locator('.map-command-help').count(), 0);
  const attackAX = await ax(a);
  assert.match(attackAX.find((b) => b.name === 'CONFIRM ATTACK').description, /Hit \d+%/);
  assert.doesNotMatch(JSON.stringify(attackAX), /TN |Expected damage/);
  assert.equal(await gameHash(a), aHash);
  await shot(a, '03-attack-single-red-arrow');
  check('Attack has one red arrow and in-hex44px check/X, compact hit description and no Help', {
    attack,
    enemyColor,
    attackAX,
  });
  await a.getByRole('button', { name: '◎ FIRE VIEW (F)', exact: true }).click();
  await a.waitForTimeout(600);
  assert.equal((await snapshot(a)).legacyEffects, 0);
  assert.equal((await snapshot(a)).geometryCount, 1);
  assert.equal(await gameHash(a), aHash);
  check('Existing firing view keeps a single command arrow and leaves game authority unchanged');
  await a.getByRole('button', { name: 'CANCEL', exact: true }).click();
  assert.equal(await gameHash(a), aHash);
  const enemyAgain = await stageAttack(a);
  const expectedAttack = await a.evaluate((target) => {
    const h = window.__ironRidge,
      { game: g, ui } = h.store.getState();
    return h.engine.apply(g, { type: 'attack', unitId: ui.selectedUnit, cell: target }).state;
  }, enemyAgain.pos);
  await a.keyboard.press('Enter');
  assert.deepEqual(await game(a), expectedAttack);
  check('Attack X cancels without spend; keyboard check confirms exactly one engine attack');
  await a.close();

  const hoverPage = await fresh();
  const { target: hp } = await attackCandidate(hoverPage);
  await hoverPage.mouse.move(hp.x, hp.y);
  const card = hoverPage.locator('.map-callout');
  await card.waitFor();
  const hoverText = await card.innerText(),
    hoverRect = await card.boundingBox();
  assert.match(hoverText, /TILE .*Height .*Hit \d+%/s);
  assert.doesNotMatch(hoverText, /HELP|Expected damage|TN |PREVIEW/);
  assert.ok(hoverRect.width <= 205 && hoverRect.height < 150);
  await shot(hoverPage, '09-small-hover-summary');
  check('Hover window is at most204px, with basic tile summary and hit percentage and no Help', {
    hoverText,
    hoverRect,
  });
  await hoverPage.close();

  for (const size of [
    { width: 390, height: 844 },
    { width: 568, height: 320 },
  ]) {
    const m = await fresh({ touch: true, ...size }),
      mBefore = await game(m),
      mHash = await gameHash(m),
      cmd = await stageMove(m, { touch: true });
    const view = await snapshot(m);
    assert.ok(view.buttons.every((b) => b.width >= 44 && b.height >= 44 && b.visible));
    assert.equal(await gameHash(m), mHash);
    await shot(m, `04-touch-${size.width}x${size.height}`);
    await m.getByRole('button', { name: 'CANCEL', exact: true }).tap();
    assert.equal(await gameHash(m), mHash);
    const second = await stageMove(m, { touch: true });
    const expectedMove = await m.evaluate(
      ({ g, c }) => window.__ironRidge.engine.apply(g, c.action).state,
      { g: mBefore, c: second },
    );
    await m.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).tap();
    assert.deepEqual(await game(m), expectedMove);
    check(
      `Trusted touch ${size.width}x${size.height}: in-hex44px controls, cancel and exact confirmation`,
      { path: cmd.path, view },
    );
    await m.close();
    const t = await fresh({ touch: true, ...size }),
      tHash = await gameHash(t);
    await stageAttack(t, true);
    const tView = await snapshot(t);
    assert.ok(tView.buttons.every((b) => b.width === 44 && b.height === 44 && b.visible));
    assert.equal(await gameHash(t), tHash);
    await shot(t, `10-touch-attack-${size.width}x${size.height}`);
    await t.getByRole('button', { name: 'CANCEL', exact: true }).tap();
    assert.equal(await gameHash(t), tHash);
    const te = await stageAttack(t, true);
    const expected = await t.evaluate((target) => {
      const h = window.__ironRidge,
        { game: g, ui } = h.store.getState();
      return h.engine.apply(g, { type: 'attack', unitId: ui.selectedUnit, cell: target }).state;
    }, te.pos);
    await t.getByRole('button', { name: 'CONFIRM ATTACK', exact: true }).tap();
    assert.deepEqual(await game(t), expected);
    check(
      `Trusted touch attack ${size.width}x${size.height}: initial tap never fires, in-hex controls cancel and confirm exactly once`,
      { tView },
    );
    await t.close();
  }

  const r = await fresh({ reduced: true });
  await stageMove(r);
  const reduced = await snapshot(r);
  assert.equal(reduced.animation, 'none');
  assert.ok(Math.abs(reduced.viewSize - reduced.viewSizeGoal) < 1e-6);
  await r.waitForTimeout(180);
  assert.equal((await snapshot(r)).dash, reduced.dash);
  await shot(r, '05-reduced-motion');
  check('Reduced motion keeps static direction and immediate camera fitting', { reduced });
  await r.close();

  const z = await fresh();
  for (let i = 0; i < 5; i++) await z.getByRole('button', { name: '−', exact: true }).click();
  await z.waitForTimeout(1000);
  const zoomBefore = (await snapshot(z)).viewSize,
    zHash = await gameHash(z);
  await stageMove(z, { min: 2 });
  const overview = await snapshot(z);
  assert.ok(overview.viewSize < zoomBefore);
  assert.equal(await gameHash(z), zHash);
  await shot(z, '06-overview-fitted-controls');
  check('Overview zoom fits the destination once while leaving authoritative state unchanged', {
    zoomBefore,
    overview,
  });
  await z.close();

  const s = await fresh({ regular: true });
  const sHash = await gameHash(s);
  const commander = await s.evaluate(() =>
    window.__ironRidge.store
      .getState()
      .game.armies.find((a) => a.team === 'A' && a.kind === 'commander'),
  );
  const commanderPoint = await point(s, commander.pos);
  assert.ok(commanderPoint);
  await s.mouse.click(commanderPoint.x, commanderPoint.y);
  assert.equal(
    await s.evaluate(() => window.__ironRidge.store.getState().ui.selectedArmy),
    commander.id,
  );
  assert.equal(await gameHash(s), sHash);
  const sCommand = await stageMove(s);
  assert.equal((await snapshot(s)).kind, 'move');
  assert.equal(await gameHash(s), sHash);
  await shot(s, '07-regular-campaign-preview');
  await s.getByRole('button', { name: 'CANCEL', exact: true }).click();
  assert.equal(await gameHash(s), sHash);
  check('Existing regular sparse campaign uses the same compact route without spending', {
    path: sCommand.path,
  });
  await s.close();

  const resume = await fresh(),
    resumeHash = await gameHash(resume);
  await stageMove(resume);
  await resume.reload();
  await resume.getByRole('button', { name: 'CONTINUE', exact: true }).click();
  await resume.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  await resume.waitForTimeout(600);
  assert.equal(await gameHash(resume), resumeHash);
  assert.equal(await resume.getByTestId('map-command-preview').count(), 0);
  check('Continue restores exact game without reviving an unconfirmed move');
  await resume.getByRole('button', { name: 'SELECT RIF', exact: true }).click();
  assert.equal(await gameHash(resume), resumeHash);
  await resume.getByRole('button', { name: 'DEMO CONTROLS', exact: true }).click();
  await resume.getByRole('checkbox', { name: /QuickMove/ }).check();
  await resume.getByRole('button', { name: 'CLOSE CONTROLS', exact: true }).click();
  const quick = await moveCandidate(resume, 2),
    quickBefore = await game(resume);
  const quickExpected = await resume.evaluate(
    ({ g, c }) => window.__ironRidge.engine.apply(g, c.action).state,
    { g: quickBefore, c: quick.command },
  );
  await resume.mouse.click(quick.hit.x, quick.hit.y);
  assert.deepEqual(await game(resume), quickExpected);
  assert.equal(await resume.getByTestId('map-command-preview').count(), 0);
  check(
    'Existing QuickMove preference still executes one exact legal click without a confirmation',
  );
  await resume.close();

  const privacy = [];
  for (const config of [
    { occupied: false, fog: true },
    { occupied: true, fog: true },
    { occupied: true, fog: false },
  ]) {
    const v = await browser.newPage({ viewport: { width: 1512, height: 1100 } });
    v.on('pageerror', (e) => report.errors.push(e.message));
    await v.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
    const f = await v.evaluate(async (config) => {
      const { blindFireFixture } = await import('/src/controls/reviewFixtures.ts'),
        f = blindFireFixture(),
        h = window.__ironRidge;
      f.game.settings.fog = config.fog;
      if (config.occupied) {
        const u = f.battle.units.find((u) => u.team === 'B'),
          source = f.game.armies.find((a) => a.id === u.holderId).units.find((s) => s.id === u.id);
        u.pos = f.target;
        u.typeId = source.typeId = 'ww2_tank';
        u.hp = source.hp = u.maxHp = h.engine.unitType('ww2_tank').hp;
      }
      const errors = h.engine.validateGameState(f.game);
      if (errors.length) throw Error(errors.join(';'));
      return {
        save: h.engine.serializeSave(f.game),
        target: f.target,
        origin: f.shooter.pos,
        unitId: f.shooter.id,
      };
    }, config);
    await v.locator('input[aria-label="Import save file"]').setInputFiles({
      name: 'prepared-blind-preview.json',
      mimeType: 'application/json',
      buffer: Buffer.from(f.save),
    });
    if (config.fog) await v.getByRole('button', { name: /^I AM .*CONTINUE$/ }).click();
    await v.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
    await v.waitForTimeout(700);
    const origin = await point(v, f.origin);
    assert.ok(origin);
    await v.mouse.click(origin.x, origin.y);
    await v.waitForTimeout(650);
    await v.getByRole('button', { name: 'Selected tile actions', exact: true }).click();
    await v
      .getByLabel('Contextual unit actions')
      .getByRole('button', { name: 'ATTACK', exact: true })
      .click();
    const target = await point(v, f.target);
    assert.ok(target);
    await v.mouse.click(target.x, target.y);
    const dialog = v.getByRole('dialog', { name: 'ATTACK command preview', exact: true });
    await dialog.waitFor();
    const text = await dialog
        .getAttribute('aria-describedby')
        .then((id) => v.locator(`[id="${id}"]`).textContent()),
      a11y = await ax(v);
    privacy.push({ config, text, a11y, route: (await snapshot(v)).d });
    if (config.fog) {
      assert.doesNotMatch(text, /TN |direct hit|Expected damage|armor/);
      assert.match(text, /Hit chance unknown/);
      assert.doesNotMatch(JSON.stringify(a11y), /TN |direct hit|Expected damage|armor/);
    } else assert.match(text, /Hit \d+%/);
    if (config.occupied && config.fog) await shot(v, '08-blind-fire-remains-redacted');
    await v.close();
  }
  assert.equal(privacy[0].text, privacy[1].text);
  const emptyPoints = privacy[0].route.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const hiddenPoints = privacy[1].route.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.equal(emptyPoints.length, hiddenPoints.length);
  assert.ok(
    emptyPoints.every((value, i) => Math.abs(value - hiddenPoints[i]) < 0.25),
    'Same route within0.25CSSpx camera-settling tolerance',
  );
  check(
    'Prepared valid blind empty/hidden-tank fixtures preserve fog redaction and identical route; fog-off shows hit percentage',
    {
      privacy,
      fixtureProvenance:
        'Engine-initialized snapshots imported through actual save UI; no fabricated gameplay outcomes.',
    },
  );
  assert.equal(report.errors.length, 0);
  report.sourceHashesAfter = await hashes();
  assert.deepEqual(report.sourceHashesAfter, report.sourceHashes);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = String(error.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(`${out}/browser-compact-previews.json`, JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, out }));
}

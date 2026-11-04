// Actual browser input proof. Debug hooks inspect state/coordinates or adjust the camera only.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');

const out = process.env.UX_INPUT_EVIDENCE_DIR ?? '/tmp/ux-controls-input';
const desktopOnly = process.argv.includes('--desktop-only');
const url = process.env.QA_URL ?? 'http://127.0.0.1:5173/';
await fs.mkdir(out, { recursive: true });
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  sourceNote:
    'sourceRevision is checkout HEAD; interpret sourceStatus with the accompanying application-source hash manifest. Physical-device behavior is outside this report.',
  startedAt: new Date().toISOString(),
  url,
  desktopOnly,
  environment:
    'Cloud headless Chromium/SwiftShader. Touch is CDP emulation, not a physical device.',
  cases: [],
  errors: [],
  screenshots: [],
  navigations: [],
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
let context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, hasTouch: true });
let page = await context.newPage();
function observePage() {
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame())
      report.navigations.push({
        url: frame.url(),
        case: current?.name,
        at: new Date().toISOString(),
      });
  });
}
observePage();
const save = async () =>
  fs.writeFile(`${out}/browser-input.json`, JSON.stringify(report, null, 2) + '\n');
const hash = (text) => createHash('sha256').update(text).digest('hex');
let current;

async function snapshot() {
  const state = await page.evaluate(() => {
    const { store, engine, scene } = window.__ironRidge;
    const { game, ui } = store.getState();
    return {
      serialized: JSON.stringify(game),
      ui,
      validation: engine.validateGameState(game),
      units: game.battle.units.map((u) => ({
        id: u.id,
        team: u.team,
        type: u.typeId,
        pos: u.pos,
        hp: u.hp,
        mp: u.mp,
        moved: u.moved,
        acted: u.acted,
        deployed: u.deployed,
      })),
      rng: game.rng,
      cp: game.cp,
      phase: game.phase,
      turn: game.turn,
      active: game.active,
      battleActive: game.battle.active,
      camera: {
        target: scene.target.toArray(),
        targetGoal: scene.targetGoal.toArray(),
        viewSize: scene.viewSize,
      },
      preview: document.querySelector('[data-testid="map-command-preview"]')?.textContent ?? null,
    };
  });
  const { serialized, ...summary } = state;
  return { ...summary, gameHash: hash(serialized) };
}

async function checkpoint(label) {
  const state = await snapshot();
  current.snapshots.push({ label, ...state });
  assert.deepEqual(state.validation, [], `${label}: valid engine state`);
  await save();
  return state;
}

async function shot(name) {
  const filename = `${String(report.cases.length).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: `${out}/${filename}`, fullPage: true });
  report.screenshots.push(filename);
}

async function boot() {
  await page.goto(url);
  await page.getByRole('button', { name: 'OPEN PREPARED TACTICAL CONTROLS', exact: true }).click();
  await page.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  await page.waitForTimeout(650);
  await page.evaluate(() => {
    window.__inputProofEvents = [];
    const scene = window.__ironRidge.scene;
    const canvas = scene.renderer.domElement;
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
      'contextmenu',
    ]) {
      canvas.addEventListener(type, (event) =>
        window.__inputProofEvents.push({
          type,
          trusted: event.isTrusted,
          pointerType: event.pointerType,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          button: event.button,
          time: performance.now(),
          defaultPrevented: event.defaultPrevented,
          gesture: scene.dragging?.mode ?? null,
        }),
      );
    }
  });
  const state = await checkpoint('prepared initial fixture through UI');
  assert.ok(state.ui.selectedUnit, 'fixture starts with a selected rifle');
}

async function point(key, { bodyId = null } = {}) {
  const result = await page.evaluate(
    ({ key, bodyId }) => {
      const scene = window.__ironRidge.scene;
      const canvas = scene.renderer.domElement;
      const rect = canvas.getBoundingClientRect();
      const tile = scene.projectTile(key);
      const center = scene.projectKey(key);
      if (!tile || !center) return null;
      // A bounded 19-point patch, scaled to this tile. No unbounded ray search.
      const candidates = [{ x: center.x, y: center.y }];
      for (const fraction of [0.35, 0.65, 0.85])
        for (const corner of tile.corners)
          candidates.push({
            x: center.x + (corner.x - tile.center.x) * fraction,
            y: center.y + (corner.y - tile.center.y) * fraction,
          });
      if (bodyId) {
        const token = scene.tokens.get(bodyId);
        if (token)
          for (const lift of [0.25, 0.6, 1]) {
            const p = token.group.position.clone();
            p.y += lift;
            p.applyMatrix4(scene.world.matrixWorld).project(scene.activeCamera());
            const x = rect.left + ((p.x + 1) * rect.width) / 2;
            const y = rect.top + ((1 - p.y) * rect.height) / 2;
            candidates.unshift({ x, y }, { x: x - 1, y }, { x: x + 1, y });
          }
      }
      for (const candidate of candidates) {
        const { x, y } = candidate;
        if (x <= rect.left + 1 || x >= rect.right - 1 || y <= rect.top + 1 || y >= rect.bottom - 1)
          continue;
        if (document.elementFromPoint(x, y) !== canvas) continue;
        scene.pointer.set(
          ((x - rect.left) / rect.width) * 2 - 1,
          -((y - rect.top) / rect.height) * 2 + 1,
        );
        const picked = scene.pickKey();
        const pickedBody = bodyId ? scene.pickToken(true) : null;
        if (bodyId ? pickedBody === key : picked === key)
          return { x, y, key, picked, pickedBody, canvas: true };
      }
      return null;
    },
    { key, bodyId },
  );
  return result;
}

async function selected() {
  return page.evaluate(() => {
    const { game, ui } = window.__ironRidge.store.getState();
    return game.battle.units.find((u) => u.id === ui.selectedUnit);
  });
}

async function candidates({ distance = 1, neighbor = false, emptyFar = false } = {}) {
  return page.evaluate(
    ({ distance, neighbor, emptyFar }) => {
      const { engine: e, scene, store } = window.__ironRidge;
      const { game, ui } = store.getState();
      const actor = game.battle.units.find((u) => u.id === ui.selectedUnit);
      const occupied = new Set(
        game.battle.units.filter((u) => u.hp > 0 && u.pos).map((u) => u.pos),
      );
      if (emptyFar)
        return [...e.contextFor(game).cells].filter(
          (key) => !occupied.has(key) && e.hexDistance(e.parseKey(key), e.parseKey(actor.pos)) > 2,
        );
      if (neighbor)
        return e.DIRECTIONS.map((_, d) => e.hexKey(e.neighbor(e.parseKey(actor.pos), d))).filter(
          (key) => scene.cellIndex.has(key) && !occupied.has(key),
        );
      return [...e.reachable(e.contextFor(game), actor)]
        .filter(
          ([key, node]) =>
            key !== actor.pos &&
            node.cost > 0 &&
            e.hexDistance(e.parseKey(key), e.parseKey(actor.pos)) >= distance,
        )
        .map(([key, node]) => ({ key, cost: node.cost }));
    },
    { distance, neighbor, emptyFar },
  );
}

async function visibleDestination(options) {
  for (const destination of await candidates(options)) {
    const hit = await point(destination.key);
    if (hit) return { ...destination, ...hit };
  }
  return null;
}

async function drag(from, to, { button = 'left' } = {}) {
  assert.ok(from && to, 'canvas origin and target are available');
  current.actions.push({ input: 'actual Playwright mouse', kind: 'drag', from, to, button });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(60);
  await page.mouse.up({ button });
  await page.waitForTimeout(160);
}

async function zoomAcross(across) {
  const actor = await selected();
  await page.evaluate((key) => window.__ironRidge.scene.focus(key), actor.pos);
  await page.waitForFunction(() => {
    const scene = window.__ironRidge.scene;
    return scene.target.distanceTo(scene.targetGoal) < 0.005;
  });
  let measured;
  for (let i = 0; i < 2; i++) {
    measured = await page.evaluate((key) => {
      const scene = window.__ironRidge.scene,
        tile = scene.projectTile(key);
      const width =
        Math.max(...tile.corners.map((p) => p.x)) - Math.min(...tile.corners.map((p) => p.x));
      return scene.renderer.domElement.getBoundingClientRect().width / width;
    }, actor.pos);
    await page.evaluate((factor) => window.__ironRidge.scene.zoom(factor), across / measured);
    await page.waitForFunction(() => {
      const scene = window.__ironRidge.scene;
      return Math.abs(scene.viewSize - scene.viewSizeGoal) < scene.viewSizeGoal * 0.001;
    });
  }
  measured = await page.evaluate((key) => {
    const scene = window.__ironRidge.scene,
      tile = scene.projectTile(key);
    return (
      scene.renderer.domElement.getBoundingClientRect().width /
      (Math.max(...tile.corners.map((p) => p.x)) - Math.min(...tile.corners.map((p) => p.x)))
    );
  }, actor.pos);
  current.actions.push({
    input: 'camera-only debug API',
    kind: 'zoom/focus',
    requestedTilesAcross: across,
    actualTilesAcross: measured,
  });
  assert.ok(
    Math.abs(measured - across) < across * 0.01,
    'actual zoom calibration is within one percent of the requested tile width',
  );
  return measured;
}

async function run(name, callback) {
  current = { name, actions: [], snapshots: [], status: 'running' };
  report.cases.push(current);
  console.log(`START ${name}`);
  try {
    await boot();
    await callback();
    current.status = 'PASS';
  } catch (error) {
    current.status = 'FAIL';
    current.failure = String(error);
    await shot('failure').catch(() => {});
    console.error(name, error);
  }
  current.events = await page.evaluate(() => window.__inputProofEvents ?? []).catch(() => []);
  await save();
  console.log(`${current.status} ${name}`);
}

try {
  await run(
    'selected drag previews without spending; release retains; explicit confirm charges exact movement',
    async () => {
      const actor = await selected(),
        from = await point(actor.pos),
        dest = await visibleDestination({ distance: 1 });
      assert.ok(from && dest);
      const before = await checkpoint('before selected drag');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(dest.x, dest.y, { steps: 12 });
      await page.waitForTimeout(100);
      const during = await checkpoint('full preview during trusted pointer drag');
      assert.equal(during.gameHash, before.gameHash);
      assert.ok(during.preview);
      await page.mouse.up();
      await page.waitForTimeout(130);
      const released = await checkpoint('release keeps full preview');
      assert.equal(released.gameHash, before.gameHash);
      assert.ok(released.preview);
      await page.mouse.move(1500, 10);
      await page.waitForTimeout(850);
      assert.equal((await checkpoint('pointer leave keeps preview')).gameHash, before.gameHash);
      await shot('selected-drag-preview');
      await page.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).click();
      await page.waitForTimeout(150);
      const after = await checkpoint('explicit confirm moves once');
      const moved = after.units.find((u) => u.id === actor.id);
      assert.equal(moved.pos, dest.key);
      assert.equal(moved.mp, actor.mp - dest.cost);
      assert.equal(moved.acted, actor.acted);
      assert.equal(moved.hp, actor.hp);
      assert.deepEqual(
        after.units.filter((u) => u.id !== actor.id),
        before.units.filter((u) => u.id !== actor.id),
      );
      assert.deepEqual(after.cp, before.cp);
      assert.deepEqual(after.rng, before.rng);
      current.expected = {
        destination: dest.key,
        movementCost: dest.cost,
        remainingMp: actor.mp - dest.cost,
      };
      await shot('confirmed-drag');
    },
  );

  await run('other-origin left drag pans without changing game', async () => {
    let from;
    for (const key of await candidates({ emptyFar: true })) {
      from = await point(key);
      if (from) break;
    }
    assert.ok(from);
    const before = await checkpoint('before empty-origin pan');
    await drag(from, { x: from.x + 65, y: from.y + 25 });
    const after = await checkpoint('after empty-origin pan');
    assert.equal(after.gameHash, before.gameHash);
    assert.notDeepEqual(after.camera.target, before.camera.target);
    assert.equal(after.preview, null);
  });

  await run(
    'near/far calibration on the same empty neighbor; other unit bodies remain protected',
    async () => {
      const actor = await selected();
      await zoomAcross(10);
      let neighbor;
      for (const key of await candidates({ neighbor: true })) {
        const hit = await point(key);
        if (hit) {
          neighbor = key;
          break;
        }
      }
      assert.ok(neighbor, 'unoccupied neighbor is accessible at near zoom');
      const near = await checkpoint('near calibration before drag');
      const nearFrom = await point(neighbor);
      await drag(nearFrom, { x: nearFrom.x + 50, y: nearFrom.y + 10 });
      const nearAfter = await checkpoint('near empty neighbor pans');
      assert.equal(nearAfter.gameHash, near.gameHash);
      assert.notDeepEqual(nearAfter.camera.target, near.camera.target);
      assert.equal(nearAfter.preview, null);
      await zoomAcross(50);
      const farFrom = await point(neighbor),
        target = await visibleDestination({ distance: 2 });
      assert.ok(
        farFrom && target,
        'same neighbor and legal far target are accessible canvas points',
      );
      const far = await checkpoint('far calibration before selected-origin-expanded drag');
      await drag(farFrom, target);
      const farAfter = await checkpoint('far empty neighbor previews selected-unit command');
      assert.equal(farAfter.gameHash, far.gameHash);
      assert.ok(farAfter.preview);
      assert.deepEqual(farAfter.camera.targetGoal, far.camera.targetGoal);
      await shot('far-expanded-origin-preview');
      await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
      const others = far.units.filter((u) => u.team === 'A' && u.id !== actor.id);
      let protectedHit;
      for (const other of others) {
        const hit = await point(other.pos, { bodyId: other.id });
        if (hit) {
          protectedHit = { other, hit };
          break;
        }
      }
      assert.ok(protectedHit, 'a visible other-unit solid body remains an actual canvas hit');
      const protectedBefore = await checkpoint('before other-unit-body far drag');
      await drag(protectedHit.hit, { x: protectedHit.hit.x + 50, y: protectedHit.hit.y + 10 });
      const protectedAfter = await checkpoint(
        'other-unit body pans, never steals selected command',
      );
      assert.equal(protectedAfter.gameHash, protectedBefore.gameHash);
      assert.equal(protectedAfter.preview, null);
      assert.notDeepEqual(protectedAfter.camera.target, protectedBefore.camera.target);
      const ordinary = await point(protectedHit.other.pos);
      assert.ok(ordinary);
      await page.mouse.click(ordinary.x, ordinary.y);
      await page.waitForTimeout(120);
      const clicked = await checkpoint('ordinary far click exactly selects other unit');
      assert.equal(clicked.ui.selectedUnit, protectedHit.other.id);
      assert.equal(clicked.gameHash, protectedBefore.gameHash);
      current.expected = { sameEmptyNeighbor: neighbor, protectedUnit: protectedHit.other.id };
    },
  );

  await run('right mouse stationary cancels; right drag pans', async () => {
    const actor = await selected(),
      origin = await point(actor.pos);
    const before = await checkpoint('before right click');
    await page.mouse.click(origin.x, origin.y, { button: 'right' });
    await page.waitForTimeout(150);
    const canceled = await checkpoint('stationary right mouse canceled');
    assert.equal(canceled.ui.selectedUnit, null);
    assert.equal(canceled.gameHash, before.gameHash);
    const pick = await point(actor.pos);
    assert.ok(pick);
    await page.mouse.click(pick.x, pick.y);
    await page.waitForTimeout(120);
    const selectedBefore = await checkpoint('reselected before right pan');
    const panOrigin = await point(actor.pos);
    await drag(panOrigin, { x: panOrigin.x + 70, y: panOrigin.y + 15 }, { button: 'right' });
    const panned = await checkpoint('right drag pans');
    assert.equal(panned.gameHash, before.gameHash);
    assert.equal(panned.ui.selectedUnit, actor.id);
    assert.notDeepEqual(panned.camera.target, selectedBefore.camera.target);
  });

  await run(
    'synthetic pointercancel, capture loss and second-pointer cancellation never commit',
    async () => {
      const actor = await selected(),
        dest = await visibleDestination({ distance: 1 });
      const before = await checkpoint('before cancellation probes');
      for (const type of ['pointercancel', 'lostpointercapture', 'second-pointer']) {
        const origin = await point(actor.pos);
        assert.ok(origin && dest);
        await page.mouse.move(origin.x, origin.y);
        await page.mouse.down();
        await page.mouse.move(dest.x, dest.y, { steps: 8 });
        await page.waitForTimeout(80);
        assert.ok((await snapshot()).preview);
        await page.evaluate((type) => {
          const scene = window.__ironRidge.scene,
            canvas = scene.renderer.domElement;
          const id = scene.dragging.pointerId;
          if (type === 'second-pointer') {
            canvas.dispatchEvent(
              new PointerEvent('pointerdown', {
                pointerId: id + 100,
                pointerType: 'touch',
                clientX: 500,
                clientY: 500,
                button: 0,
                bubbles: true,
              }),
            );
            canvas.dispatchEvent(
              new PointerEvent('pointercancel', {
                pointerId: id + 100,
                pointerType: 'touch',
                bubbles: true,
              }),
            );
          } else
            canvas.dispatchEvent(
              new PointerEvent(type, { pointerId: id, pointerType: 'mouse', bubbles: true }),
            );
        }, type);
        current.actions.push({ input: 'explicitly synthetic DOM cancellation event', kind: type });
        await page.mouse.up();
        await page.waitForTimeout(100);
        const after = await checkpoint(`synthetic ${type} then actual mouse release`);
        assert.equal(after.gameHash, before.gameHash);
        assert.equal(after.preview, null);
      }
    },
  );

  await run(
    'actual CDP touch drag and tap alternative; native hold observation without OS preference claims',
    async () => {
      const cdp = await context.newCDPSession(page);
      const actor = await selected(),
        origin = await point(actor.pos),
        dest = await visibleDestination({ distance: 1 });
      assert.ok(origin && dest);
      const before = await checkpoint('before CDP touch drag');
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: origin.x, y: origin.y, id: 11 }],
      });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: origin.x + ((dest.x - origin.x) * i) / 12,
              y: origin.y + ((dest.y - origin.y) * i) / 12,
              id: 11,
            },
          ],
        });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(180);
      const released = await checkpoint('trusted touch drag releases into full pending preview');
      assert.equal(released.gameHash, before.gameHash);
      assert.ok(released.preview);
      await page.getByRole('button', { name: 'CANCEL', exact: true }).tap();
      const targetPoint = await point(dest.key);
      assert.ok(targetPoint);
      await page.touchscreen.tap(targetPoint.x, targetPoint.y);
      await page.waitForTimeout(150);
      assert.ok((await checkpoint('tap target provides non-hold preview alternative')).preview);
      await page.getByRole('button', { name: 'CANCEL', exact: true }).tap();
      const holdPoint = await point(actor.pos);
      assert.ok(holdPoint);
      const start = await page.evaluate(() => performance.now());
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: holdPoint.x, y: holdPoint.y, id: 12 }],
      });
      await page.waitForTimeout(1300);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(150);
      const native = await page.evaluate(
        (start) =>
          window.__inputProofEvents.filter(
            (event) => event.type === 'contextmenu' && event.trusted && event.time >= start,
          ),
        start,
      );
      current.nativeHold = native.length
        ? { result: 'OBSERVED', events: native, elapsedMs: native[0].time - start }
        : {
            result: 'UNKNOWN',
            detail:
              'Chromium CDP touch hold did not emit a trusted native contextmenu in this environment. No OS timing preference compliance is claimed.',
          };
      assert.equal((await checkpoint('after native hold observation')).gameHash, before.gameHash);
      if (!native.length) {
        await page.evaluate(
          ({ x, y }) =>
            window.__ironRidge.scene.renderer.domElement.dispatchEvent(
              new PointerEvent('contextmenu', {
                pointerType: 'touch',
                pointerId: 12,
                clientX: x,
                clientY: y,
                bubbles: true,
                cancelable: true,
              }),
            ),
          holdPoint,
        );
        current.actions.push({
          input: 'explicitly synthetic contextmenu fallback',
          trusted: false,
        });
        assert.equal(
          (await checkpoint('synthetic native-context API fallback')).gameHash,
          before.gameHash,
        );
      }
      await shot('touch-input');
      await cdp.detach();
    },
  );

  await run('keyboard focus, native button Space, canvas context and reduced motion', async () => {
    const before = await checkpoint('before focused keyboard input');
    await page.getByRole('button', { name: 'Selected tile actions', exact: true }).click();
    const move = page.getByRole('button', { name: 'MOVE', exact: true }).first();
    await move.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(180);
    await page.keyboard.press('Space');
    await page.waitForTimeout(120);
    const after = await checkpoint('focused action ArrowRight and Space');
    assert.equal(after.gameHash, before.gameHash);
    assert.deepEqual(after.camera.targetGoal, before.camera.targetGoal);
    const actor = await selected();
    const originalPoint = await point(actor.pos);
    assert.ok(originalPoint);
    await page.mouse.click(originalPoint.x, originalPoint.y, { button: 'right' });
    await page.waitForTimeout(100);
    assert.equal((await snapshot()).ui.selectedUnit, null);
    let hovered;
    for (const unit of before.units.filter((u) => u.team === 'A' && u.id !== actor.id)) {
      const hit = await point(unit.pos);
      if (hit) {
        hovered = { unit, hit };
        break;
      }
    }
    assert.ok(hovered, 'another friendly tile is available for the keyboard hover fallback');
    await page.mouse.move(hovered.hit.x, hovered.hit.y);
    await page.waitForTimeout(100);
    await page.locator('canvas').focus();
    await page.keyboard.press('Shift+F10');
    await page.waitForTimeout(120);
    const contextState = await checkpoint('canvas keyboard context alternative');
    assert.equal(contextState.gameHash, before.gameHash);
    assert.equal(
      contextState.ui.selectedUnit,
      hovered.unit.id,
      'native keyboard context uses the hovered friendly unit when no actor is selected',
    );
    current.keyboardContextEvents = await page.evaluate(() =>
      window.__inputProofEvents.filter((event) => event.type === 'contextmenu'),
    );
    assert.ok(
      current.keyboardContextEvents.some((event) => event.trusted && event.button === -1),
      'a trusted keyboard context event reached the real canvas',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    current.reducedMotion = await page.evaluate(() => ({
      matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animation: getComputedStyle(document.querySelector('.map-callout')).animationDuration,
      transition: getComputedStyle(document.querySelector('.map-callout')).transitionDuration,
    }));
    assert.equal(current.reducedMotion.matches, true);
    assert.equal((await checkpoint('reduced motion preference')).gameHash, before.gameHash);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  if (desktopOnly)
    report.mobile = {
      status: 'PENDING',
      reason: 'Run without --desktop-only for the separate 390px touch viewport.',
    };
  else {
    await context.close();
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    page = await context.newPage();
    observePage();
    await run(
      '390px mobile touch drag keeps preview; tap Confirm charges exact movement',
      async () => {
        const cdp = await context.newCDPSession(page);
        const actor = await selected(),
          origin = await point(actor.pos),
          dest = await visibleDestination({ distance: 1 });
        assert.ok(
          origin && dest,
          'selected tile and legal destination are uncovered canvas input points at 390px',
        );
        current.viewport = await page.locator('canvas').boundingBox();
        const before = await checkpoint('390px before selected touch drag');
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: origin.x, y: origin.y, id: 21 }],
        });
        for (let i = 1; i <= 12; i++)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [
              {
                x: origin.x + ((dest.x - origin.x) * i) / 12,
                y: origin.y + ((dest.y - origin.y) * i) / 12,
                id: 21,
              },
            ],
          });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(180);
        const released = await checkpoint('390px touch release retains preview without cost');
        assert.equal(released.gameHash, before.gameHash);
        assert.ok(released.preview);
        await shot('390px-touch-drag-preview');
        await page.getByRole('button', { name: 'CONFIRM MOVE', exact: true }).tap();
        await page.waitForTimeout(150);
        const confirmed = await checkpoint('390px Confirm tap commits the exact movement cost');
        assert.equal(confirmed.units.find((u) => u.id === actor.id).pos, dest.key);
        assert.equal(confirmed.units.find((u) => u.id === actor.id).mp, actor.mp - dest.cost);
        assert.deepEqual(confirmed.cp, before.cp);
        assert.deepEqual(confirmed.rng, before.rng);
        current.expected = { destination: dest.key, cost: dest.cost };
        await cdp.detach();
      },
    );
    await run(
      '390px real two-touch input cancels command and pans without changing game',
      async () => {
        const cdp = await context.newCDPSession(page);
        const actor = await selected(),
          origin = await point(actor.pos),
          dest = await visibleDestination({ distance: 1 });
        assert.ok(origin && dest);
        const before = await checkpoint('390px before multi-touch cancellation');
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: origin.x, y: origin.y, id: 31 }],
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: dest.x, y: dest.y, id: 31 }],
        });
        await page.waitForTimeout(100);
        assert.ok((await snapshot()).preview);
        const second = {
          x: Math.max(25, Math.min(365, dest.x + 45)),
          y: Math.max(220, Math.min(730, dest.y + 70)),
          id: 32,
        };
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: dest.x, y: dest.y, id: 31 }, second],
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: dest.x + 15, y: dest.y + 8, id: 31 },
            { ...second, x: second.x + 15, y: second.y + 8 },
          ],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(150);
        const after = await checkpoint('390px after real two-touch cancel/pan/release');
        assert.equal(after.gameHash, before.gameHash);
        assert.equal(after.preview, null);
        assert.notDeepEqual(after.camera.targetGoal, before.camera.targetGoal);
        current.input =
          'CDP touch dispatch produces trusted browser pointer events; no synthetic DOM cancellation used in this case.';
        const trustedDowns = await page.evaluate(() =>
          window.__inputProofEvents.filter(
            (event) =>
              event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted,
          ),
        );
        assert.ok(
          new Set(trustedDowns.map((event) => event.pointerId)).size >= 2,
          'two distinct trusted touch pointer presses reached the actual canvas',
        );
        current.trustedTouchPointers = trustedDowns;
        await cdp.detach();
      },
    );
    report.mobile = {
      status: report.cases
        .filter((entry) => entry.name.startsWith('390px'))
        .every((entry) => entry.status === 'PASS')
        ? 'PASS'
        : 'FAIL',
      viewport: { width: 390, height: 844 },
    };
  }
  assert.deepEqual(report.errors, [], 'browser page errors');
} finally {
  report.finishedAt = new Date().toISOString();
  report.status =
    report.cases.every((entry) => entry.status === 'PASS') && !report.errors.length
      ? 'PASS'
      : 'FAIL';
  await save();
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      status: report.status,
      cases: report.cases.map(({ name, status, failure }) => ({ name, status, failure })),
      errors: report.errors,
      out,
    },
    null,
    2,
  ),
);
if (report.status !== 'PASS') process.exitCode = 1;

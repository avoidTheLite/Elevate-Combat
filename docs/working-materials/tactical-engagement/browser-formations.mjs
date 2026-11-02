import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs';
const folder = '/tmp/engagement-formation-browser';
const save = await fs.readFile('/tmp/engagement-review.save.json', 'utf8');
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
const page = await browser.newPage({
  viewport: { width: 1600, height: 1100 },
  deviceScaleFactor: 1,
});
const pageErrors = [],
  consoleErrors = [],
  warnings = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push({ text: m.text(), location: m.location() });
  if (m.type() === 'warning') warnings.push(m.text());
});
await page.goto('http://127.0.0.1:5173/');
await page.waitForFunction(() => !!window.__ironRidge?.store);
const imported = await page.evaluate(
  (text) => window.__ironRidge.store.getState().importSave(text),
  save,
);
assert(imported, 'Review save import failed');
await page.waitForFunction(() => window.__ironRidge?.scene?.renderer?.info?.render?.calls > 0);
const initial = await page.evaluate(() =>
  structuredClone(window.__ironRidge.store.getState().game),
);
const rows = [];
for (const [id, name] of [
  ['Aarmy1', 'rifles-back-to-back'],
  ['Aarmy18', 'at-infantry-and-tank'],
]) {
  await page.evaluate((id) => {
    const { store, scene } = window.__ironRidge;
    const army = store.getState().game.armies.find((a) => a.id === id);
    store.getState().setUi({ selectedArmy: id, selectedMain: army.at });
    scene.focus(army.pos);
    scene.zoom(0.01);
  }, id);
  await page.waitForTimeout(1200);
  // Camera-only height adjustment centres the actual raised tile at close zoom.
  await page.evaluate((id) => {
    const { store, scene } = window.__ironRidge;
    const army = store.getState().game.armies.find((a) => a.id === id);
    scene.targetGoal.y = scene.cellPos(army.pos).y;
    scene.target.copy(scene.targetGoal);
  }, id);
  await page.waitForTimeout(500);
  const evidence = await page.evaluate((id) => {
    const { store, scene } = window.__ironRidge;
    const game = store.getState().game;
    const army = game.armies.find((a) => a.id === id);
    const token = scene.tokens.get(id);
    const rendered = [];
    token.body.traverse((o) => {
      if (o.name === 'roster-unit')
        rendered.push({
          id: o.userData.unitId,
          typeId: o.userData.typeId,
          facing: o.userData.facing,
          x: o.userData.x,
          z: o.userData.z,
          scale: o.userData.scale,
          area: o.userData.projectedArea,
          areaLimit: o.userData.areaLimit,
        });
    });
    const canvas = scene.renderer.domElement,
      gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    return {
      id,
      army: { pos: army.pos, movesLeft: army.movesLeft, units: army.units },
      rendered,
      projectedTile: scene.projectKey(army.pos),
      webgl: {
        present: !!gl,
        version: gl?.getParameter(gl.VERSION),
        renderCalls: scene.renderer.info.render.calls,
      },
      viewSize: scene.viewSize,
      bodyText: document.body.innerText,
    };
  }, id);
  assert.deepEqual(
    evidence.rendered.map((u) => u.id).sort(),
    evidence.army.units.map((u) => u.id).sort(),
  );
  assert(evidence.rendered.every((u) => u.area <= u.areaLimit && u.scale > 0));
  const east = evidence.rendered.find((u) => u.facing === 0),
    west = evidence.rendered.find((u) => u.facing === 3);
  assert(
    east && west && east.x > 0 && west.x < 0,
    'Opposite-facing models are not on opposite sides',
  );
  assert(evidence.webgl.present && evidence.webgl.renderCalls > 0, 'No actual WebGL rendering');
  await page.screenshot({ path: `${folder}/${name}-full.png`, fullPage: true });
  await page.getByTestId('scene-host').screenshot({ path: `${folder}/${name}-map.png` });
  const pos = evidence.projectedTile;
  if (pos) {
    const x = Math.max(0, pos.x - 170),
      y = Math.max(0, pos.y - 180);
    await page.screenshot({
      path: `${folder}/${name}-detail.png`,
      clip: { x, y, width: 340, height: 340 },
    });
  }
  rows.push(evidence);
}
const final = await page.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
assert.deepEqual(final, initial, 'Visual inspection changed actual game state');
const appErrors = consoleErrors.filter((e) => !e.location?.url?.endsWith('/favicon.ico'));
const report = {
  observedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceClean:
    execFileSync('git', ['status', '--porcelain', '--', 'apps/web/src', 'packages/engine/src'], {
      encoding: 'utf8',
    }).trim() === '',
  status: pageErrors.length || appErrors.length ? 'FAIL' : 'PASS',
  appErrors,
  nonApplicationResourceErrors: consoleErrors.filter((e) =>
    e.location?.url?.endsWith('/favicon.ico'),
  ),
  url: 'http://127.0.0.1:5173/',
  fixture: '/tmp/engagement-review.save.json',
  fixtureNote:
    'Existing review save created by normal split/endTurn actions plus explicitly labelled initial position/facing posture. No units, CP, HP or resources changed during this browser inspection.',
  cameraNote:
    'Selected each holder through store.setUi and used existing scene focus/zoom. A camera-only target-height adjustment centred each raised tile for close-up images; game state stayed exact.',
  unchangedGameState: true,
  pageErrors,
  consoleErrors,
  warnings,
  rows,
};
await fs.writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      status: report.status,
      pageErrors,
      consoleErrors,
      warnings,
      unchangedGameState: true,
      rows: rows.map(({ id, rendered, webgl }) => ({ id, rendered, webgl })),
    },
    null,
    2,
  ),
);
const full = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
full.on('pageerror', (e) => pageErrors.push(e.message));
await full.goto('http://127.0.0.1:5173/');
await full.getByLabel('Commander training price (CP)').fill('1');
await full.getByRole('button', { name: 'START NEW GAME', exact: true }).click();
await full.waitForFunction(() => window.__ironRidge?.scene?.renderer?.info?.render?.calls > 0);
const fresh = await full.evaluate(() => {
  const { store, scene } = window.__ironRidge;
  const game = store.getState().game;
  const a = game.armies.find((a) => a.kind === 'commander' && a.team === 'A');
  store.getState().setUi({ selectedArmy: a.id, selectedMain: a.at });
  scene.focus(a.pos);
  scene.zoom(0.01);
  return {
    id: a.id,
    unitIds: a.units.map((u) => u.id),
    cp: game.cp,
    commanderPrice: game.settings.commanderTrainingCp,
  };
});
await full.waitForTimeout(1200);
await full.evaluate((id) => {
  const { store, scene } = window.__ironRidge;
  const army = store.getState().game.armies.find((a) => a.id === id);
  scene.targetGoal.y = scene.cellPos(army.pos).y;
  scene.target.copy(scene.targetGoal);
}, fresh.id);
await full.waitForTimeout(300);
fresh.rendered = await full.evaluate((id) => {
  const rows = [];
  window.__ironRidge.scene.tokens.get(id).body.traverse((o) => {
    if (o.name === 'roster-unit')
      rows.push({ id: o.userData.unitId, typeId: o.userData.typeId, facing: o.userData.facing });
  });
  return rows;
}, fresh.id);
assert(fresh.unitIds.length > 3);
assert.deepEqual(fresh.unitIds.slice().sort(), fresh.rendered.map((u) => u.id).sort());
await full.screenshot({ path: `${folder}/fresh-six-unit-roster-full.png`, fullPage: true });
const freshpos = await full.evaluate((id) => {
  const { store, scene } = window.__ironRidge;
  return scene.projectKey(store.getState().game.armies.find((a) => a.id === id).pos);
}, fresh.id);
await full.screenshot({
  path: `${folder}/fresh-six-unit-roster-detail.png`,
  clip: { x: freshpos.x - 170, y: freshpos.y - 180, width: 340, height: 340 },
});
report.freshRoster = {
  ...fresh,
  source:
    'New Campaign through visible Start New Game UI; explicit commanderCP1. No unit/resource edits.',
};
report.status = pageErrors.length || appErrors.length ? 'FAIL' : 'PASS';
await fs.writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2) + '\n');
await browser.close();

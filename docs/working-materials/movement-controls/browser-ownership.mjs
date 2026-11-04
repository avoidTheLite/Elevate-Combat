// Prepared initial snapshots enter through Setup's real file input. Fixture
// history is declared data, not claimed UI-earned play; engine regressions prove
// actual movement/capture/resighting. Hooks only construct local fixture objects,
// inspect the running game, and project coordinates. They never write live state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const { chromium } = await import('/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.UX_OWNERSHIP_EVIDENCE_DIR ?? '/tmp/pr18-ownership-browser';
const url = process.env.QA_URL ?? 'http://127.0.0.1:5173/';
await fs.mkdir(out, { recursive: true });
const sourcePaths = [
  'packages/engine/src/types.ts',
  'packages/engine/src/strategic.ts',
  'packages/engine/src/actions.ts',
  'packages/engine/src/save.ts',
  'apps/web/src/lib/strategicVisibility.ts',
  'apps/web/src/render/buildScene.ts',
  'apps/web/src/components/game/StrategicSidebar.tsx',
  'apps/web/src/components/game/NodePanel.tsx',
  'apps/web/src/components/game/RoadRepairPanel.tsx',
  'docs/working-materials/movement-controls/browser-ownership.mjs',
];
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(sourcePaths.map(async (path) => [path, sha(await fs.readFile(path))])),
  );
const report = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: await hashes(),
  startedAt: new Date().toISOString(),
  fixtureProvenance:
    'Prepared, engine-validated initial ownership snapshots imported through Setup. Prior observations are declared fixture data; no UI-earned history is asserted.',
  environment: 'Managed Chromium/SwiftShader on localhost; desktop emulation.',
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
const game = (page) =>
  page.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
const gameHash = async (page) => sha(JSON.stringify(await game(page)));
async function fresh() {
  const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () =>
      !!window.__ironRidge?.engine &&
      !!document.querySelector('input[aria-label="Import save file"]'),
  );
  return page;
}
async function load(page, save, fog) {
  await page.getByLabel('Import save file', { exact: true }).setInputFiles({
    name: 'prepared-ownership.json',
    mimeType: 'application/json',
    buffer: Buffer.from(save),
  });
  if (fog) await page.getByRole('button', { name: /^I AM .*CONTINUE$/ }).click();
  await page.waitForFunction(() => window.__ironRidge?.scene?.renderer.info.render.calls > 0);
  await page.waitForTimeout(500);
}
async function selectMain(page, main, keys) {
  for (const key of keys) {
    const positions = await page.evaluate((key) => {
      const scene = window.__ironRidge.scene,
        point = scene.projectKey(key);
      if (!point) return [];
      return [
        [0, 0],
        [0, -7],
        [0, 7],
        [-7, 0],
        [7, 0],
      ]
        .map(([dx, dy]) => ({ x: point.x + dx, y: point.y + dy }))
        .filter(({ x, y }) => document.elementFromPoint(x, y) === scene.renderer.domElement);
    }, key);
    for (const position of positions) {
      await page.mouse.click(position.x, position.y);
      await page.waitForTimeout(60);
      if (
        await page.evaluate(
          (main) => window.__ironRidge.store.getState().ui.selectedMain === main,
          main,
        )
      ) {
        const panel = page.locator('[data-panel-id="hex"]');
        const expand = panel.getByRole('button', { name: /^Expand HEX/ });
        if (await expand.count()) await expand.click();
        return (await panel.getByText('Owner', { exact: true }).locator('..').innerText())
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  }
  throw new Error(`No unobscured ordinary map click selected MainHex ${main}`);
}
async function shot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  report.screenshots.push(`${name}.png`);
}
async function fixture(page, mode) {
  return page.evaluate((mode) => {
    const engine = window.__ironRidge.engine;
    const state = engine.createGame({
      ...engine.defaultSettings(),
      seed: 914211,
      grid: { mainCols: 7, mainRows: 3, subRadius: 2 },
      controllers: { A: 'human', B: 'human' },
      fog: true,
    });
    const { world } = engine.worldOf(state);
    const target = world.mains.find((main) => main.col === 5 && main.row === 0);
    const unknown = world.mains.find((main) => main.col === 4 && main.row === 0);
    const foe = state.armies.find((holder) => holder.team === 'B' && holder.kind === 'commander');
    engine.setHolderPos(world, foe, engine.hexKey(target.center));
    state.hexes[target.key].owner = state.hexes[unknown.key].owner = 'B';
    state.ownershipKnowledge.A[target.key] = null;
    delete state.ownershipKnowledge.A[unknown.key];
    if (mode === 'edge') {
      const eye = state.armies.find((holder) => holder.team === 'A' && holder.kind === 'commander');
      const taken = new Set(
        state.armies.filter((holder) => holder.id !== eye.id).map((holder) => holder.pos),
      );
      const anchor = world.subs.find((cell) => {
        if (taken.has(cell.key) || engine.mainDistance(world, cell.main, target.key) !== 2)
          return false;
        engine.setHolderPos(world, eye, cell.key);
        const oldOwner = state.hexes[cell.main].owner;
        state.hexes[cell.main].owner = 'A';
        const seen = engine.strategicVisibleCells(state, 'A');
        state.hexes[cell.main].owner = oldOwner;
        return (
          target.subKeys.some((key) => seen.has(key)) && !seen.has(engine.hexKey(target.center))
        );
      });
      if (!anchor) throw new Error('No partial edge-visibility fixture on this deterministic map');
      engine.setHolderPos(world, eye, anchor.key);
      state.hexes[anchor.main].owner = 'A';
    }
    engine.refreshOwnershipKnowledge(state);
    if (mode === 'open') state.settings.fog = false;
    const cells = engine.strategicVisibleCells(state, 'A');
    const visibleTargetTiles = target.subKeys.filter((key) => cells.has(key));
    if (
      mode === 'hidden' &&
      (visibleTargetTiles.length || unknown.subKeys.some((key) => cells.has(key)))
    )
      throw new Error('Hidden fixture unexpectedly observable');
    if (mode === 'edge' && (!visibleTargetTiles.length || cells.has(engine.hexKey(target.center))))
      throw new Error('Expected an observable edge and an occluded center');
    const errors = engine.validateGameState(state);
    if (errors.length) throw new Error(errors.join('; '));
    return {
      mode,
      target: target.key,
      unknown: unknown.key,
      targetKeys: target.subKeys,
      unknownKeys: unknown.subKeys,
      visibleTargetTiles,
      centerVisible: cells.has(engine.hexKey(target.center)),
      actualOwner: state.hexes[target.key].owner,
      observedOwner: state.ownershipKnowledge.A[target.key],
      unknownKnown: Object.hasOwn(state.ownershipKnowledge.A, unknown.key),
      state,
      save: engine.serializeSave(
        state,
        `Prepared ownership ${mode} snapshot`,
        '2026-11-04T00:00:00Z',
      ),
      errors,
    };
  }, mode);
}
try {
  const page = await fresh();
  const hidden = await fixture(page, 'hidden');
  await fs.writeFile(`${out}/prepared-hidden.save.json`, hidden.save);
  await load(page, hidden.save, true);
  const before = await gameHash(page);
  assert.equal(hidden.actualOwner, 'B');
  assert.equal(hidden.observedOwner, null);
  assert.equal(hidden.unknownKnown, false);
  const retained = await selectMain(page, hidden.target, hidden.targetKeys);
  assert.match(retained, /NEUTRAL/);
  assert.ok(await page.getByText(/Last observed owner/).count());
  await shot(page, '01-hidden-prior-owner');
  const unknown = await selectMain(page, hidden.unknown, hidden.unknownKeys);
  assert.match(unknown, /UNKNOWN/);
  await shot(page, '02-never-observed-owner');
  assert.equal(await gameHash(page), before);
  check(
    'Prepared hidden enemy truth retains observed neutral; never-observed ownership is distinct; map inspection preserves game',
    {
      target: hidden.target,
      unknown: hidden.unknown,
      actualOwner: hidden.actualOwner,
      retained,
      unknown,
      gameHash: before,
    },
  );

  await page.getByRole('button', { name: 'MENU', exact: true }).click();
  await page.getByRole('button', { name: 'SAVE GAME…', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'EXPORT .JSON', exact: true }).click();
  const download = await downloadPromise;
  const exportedPath = `${out}/ui-exported.save.json`;
  await download.saveAs(exportedPath);
  const exported = await fs.readFile(exportedPath, 'utf8');
  const envelope = JSON.parse(exported);
  assert.equal(envelope.schema, 5);
  assert.deepEqual(envelope.state, hidden.state);
  assert.equal(await gameHash(page), before);
  const resumed = await fresh();
  await load(resumed, exported, true);
  assert.deepEqual(await game(resumed), hidden.state);
  assert.match(await selectMain(resumed, hidden.target, hidden.targetKeys), /NEUTRAL/);
  await shot(resumed, '03-ui-export-import-retains-memory');
  check('Real UI export and Setup file import retain schema5 observations and exact game', {
    schema: envelope.schema,
    fileSha256: sha(exported),
    gameHashBefore: before,
    gameHashAfter: await gameHash(resumed),
  });
  await page.close();
  await resumed.close();

  for (const mode of ['open', 'edge']) {
    const current = await fresh();
    const prepared = await fixture(current, mode);
    await fs.writeFile(`${out}/prepared-${mode}.save.json`, prepared.save);
    await load(current, prepared.save, mode !== 'open');
    const hash = await gameHash(current);
    const owner = await selectMain(current, prepared.target, prepared.targetKeys);
    assert.match(owner, /BRAVO/);
    assert.equal(await gameHash(current), hash);
    await shot(
      current,
      mode === 'edge' ? '05-visible-edge-updates-owner' : '04-fog-off-current-owner',
    );
    check(
      mode === 'edge'
        ? 'A visible edge reveals current MainHex owner with center still occluded'
        : 'Fog-off view reveals current owner despite retained prior observation',
      {
        target: prepared.target,
        owner,
        visibleTargetTiles: prepared.visibleTargetTiles,
        centerVisible: prepared.centerVisible,
        gameHash: hash,
      },
    );
    await current.close();
  }
  assert.deepEqual(report.errors, []);
  report.sourceHashesAfter = await hashes();
  assert.deepEqual(
    report.sourceHashesAfter,
    report.sourceHashes,
    'Production source stayed frozen',
  );
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(`${out}/browser-ownership.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}

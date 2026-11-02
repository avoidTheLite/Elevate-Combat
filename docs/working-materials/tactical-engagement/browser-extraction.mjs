// A declared custom-objective checkpoint exercises legal extraction without fabricated casualties.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as e from '../../../packages/engine/src/index.ts';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs'
);
const out = process.env.ENGAGEMENT_EVIDENCE_DIR ?? '/tmp/engagement-browser';
const meta = JSON.parse(await fs.readFile('/tmp/engagement-review-fixture.json', 'utf8'));
const loaded = e.deserializeSave(await fs.readFile('/tmp/engagement-review.save.json', 'utf8'));
assert.equal(loaded.ok, true);
let preview = structuredClone(loaded.save.state);
function step(action) {
  const result = e.apply(preview, action);
  assert.equal(result.error, null);
  preview = result.state;
}
step({ type: 'engage', armyId: meta.primary.A, targetId: meta.primary.B });
for (const team of ['A', 'B']) {
  step({ type: 'engagementSelect', team, armyIds: [meta.primary[team], ...meta.additional[team]] });
  step({ type: 'engagementLock', team });
}
step({ type: 'startBattle' });
step({ type: 'autoDeploy' });
step({ type: 'finishDeploy' });
step({ type: 'autoDeploy' });
step({ type: 'finishDeploy' });
const captureKey = preview.battle.units.find((u) => u.holderId === meta.primary.A).pos;
const game = structuredClone(loaded.save.state);
game.settings.battleObjective = {
  kind: 'capture_point',
  captureKey,
  captureRadius: 0,
  extractionAtOrigin: true,
};
await fs.writeFile(
  '/tmp/engagement-extraction.save.json',
  e.serializeSave(
    game,
    'Prepared extraction checkpoint: custom capture point in Alpha deploy zone',
  ),
);
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const handover = async () => {
  const b = page.getByRole('button', { name: /I AM .*CONTINUE/ });
  if (await b.count()) await b.click();
};
try {
  await page.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  await page
    .getByLabel('Import save file', { exact: true })
    .setInputFiles('/tmp/engagement-extraction.save.json');
  await handover();
  await page.evaluate(
    (id) => window.__ironRidge.store.getState().setUi({ selectedArmy: id }),
    meta.primary.A,
  );
  await page
    .getByRole('button', { name: /ENGAGE BRAVO/ })
    .first()
    .click();
  for (const team of ['A', 'B']) {
    for (const id of meta.additional[team])
      await page.getByRole('checkbox', { name: `Include commander ${id}`, exact: true }).check();
    await page
      .getByRole('button', {
        name: `LOCK ${team === 'A' ? 'ALPHA' : 'BRAVO'} COMMANDERS`,
        exact: true,
      })
      .click();
    await handover();
  }
  await page.getByRole('button', { name: 'FIGHT TACTICAL BATTLE', exact: true }).click();
  await handover();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'AUTO-DEPLOY', exact: true }).click();
    await page.getByRole('button', { name: 'READY ▶', exact: true }).click();
    await handover();
  }
  const before = await page.evaluate(() =>
    structuredClone(window.__ironRidge.store.getState().game),
  );
  assert(before.battle.units.every((u) => u.hp > 0));
  await page.screenshot({ path: `${out}/10-legal-extraction-checkpoint.png`, fullPage: true });
  await page.getByRole('button', { name: 'EXTRACT', exact: true }).click();
  const extracted = await page.evaluate(() =>
    structuredClone(window.__ironRidge.store.getState().game),
  );
  assert.equal(extracted.battle.extracted, true);
  assert(extracted.battle.units.every((u) => u.hp > 0));
  // Extraction dispatch writes the ordinary autosave before presenting the result overlay.
  await page.reload();
  await page.getByRole('button', { name: 'CONTINUE', exact: true }).click();
  await handover();
  assert.deepEqual(
    await page.evaluate(() => window.__ironRidge.store.getState().game.battle),
    extracted.battle,
  );
  await page.getByRole('button', { name: 'RETURN TO CAMPAIGN', exact: true }).click();
  await handover();
  const final = await page.evaluate(() =>
    structuredClone(window.__ironRidge.store.getState().game),
  );
  for (const id of [...meta.additional.A, ...meta.additional.B]) {
    const original = game.armies.find((a) => a.id === id),
      actual = final.armies.find((a) => a.id === id);
    assert.equal(actual.pos, original.pos);
    assert.equal(actual.movesLeft, original.movesLeft);
    assert.deepEqual(
      actual.units.map((u) => u.id),
      original.units.map((u) => u.id),
    );
  }
  const validation = await page.evaluate(() =>
    window.__ironRidge.engine.validateGameState(window.__ironRidge.store.getState().game),
  );
  assert.deepEqual(validation, []);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${out}/11-extracted-commander-provenance.png`, fullPage: true });
  const report = {
    status: 'PASS',
    observedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceClean:
      execFileSync('git', ['status', '--porcelain', '--', 'apps/web/src', 'packages/engine/src'], {
        encoding: 'utf8',
      }).trim() === '',
    customObjective: {
      captureKey,
      captureRadius: 0,
      reason:
        'Prepared extraction checkpoint; the existing configurable objective is deliberately placed in Alpha deployment space. This is not a claimed combat victory.',
    },
    unitsBefore: before.battle.units.length,
    allUnitsAlive: true,
    extracted: true,
    exactBattleReload: true,
    additionalHolderIds: [...meta.additional.A, ...meta.additional.B],
    provenancePreserved: true,
    finalValidation: validation,
    pageErrors: errors,
  };
  await fs.writeFile(`${out}/extraction-report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

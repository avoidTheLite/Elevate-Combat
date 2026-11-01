// Reproduce with Vite dev server, Chromium and the generated prepared review save.
// Only declared initial commander positions/facing are prepared; all battle actions are real.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs'
);
const out = process.env.ENGAGEMENT_EVIDENCE_DIR ?? '/tmp/engagement-browser';
await fs.mkdir(out, { recursive: true });
const meta = JSON.parse(await fs.readFile('/tmp/engagement-review-fixture.json', 'utf8'));
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
const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } });
page.setDefaultTimeout(20000);
const errors = [],
  warnings = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'warning' && m.text().includes('[ai]')) warnings.push(m.text());
});
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
};
const read = () => page.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
const handover = async () => {
  const b = page.getByRole('button', { name: /I AM .*CONTINUE/ });
  if (await b.count()) await b.click();
};
try {
  await page.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  await page
    .getByLabel('Import save file', { exact: true })
    .setInputFiles('/tmp/engagement-review.save.json');
  await page.waitForFunction(() => !!window.__ironRidge?.store.getState().game);
  await handover();
  await page.evaluate(
    (id) =>
      window.__ironRidge.store
        .getState()
        .setUi({
          selectedArmy: id,
          selectedMain: window.__ironRidge.store.getState().game.armies.find((a) => a.id === id).at,
        }),
    meta.primary.A,
  );
  await shot('01-prepared-commander-rosters');
  await page
    .getByRole('button', { name: /ENGAGE BRAVO/ })
    .first()
    .click();
  await page
    .getByRole('checkbox', { name: `Include commander ${meta.additional.A[0]}`, exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: `Include commander ${meta.additional.A[1]}`, exact: true })
    .check();
  assert.match(await page.getByTestId('participation-total').innerText(), /9 CP/);
  assert.equal(
    await page
      .getByRole('checkbox', { name: `Include commander ${meta.declined}`, exact: true })
      .isChecked(),
    false,
  );
  await shot('02-alpha-selects-9cp');
  await page.getByRole('button', { name: 'SAVE GAME…', exact: true }).click();
  await page.getByRole('button', { name: 'Save to slot 1', exact: true }).click();
  const pending = await read();
  await page.reload();
  await page.getByRole('button', { name: 'CONTINUE', exact: true }).click();
  await handover();
  assert.deepEqual((await read()).pending, pending.pending);
  await page.getByRole('button', { name: 'LOCK ALPHA COMMANDERS', exact: true }).click();
  assert.equal(
    await page
      .getByRole('checkbox', { name: `Include commander ${meta.additional.B[0]}`, exact: true })
      .count(),
    0,
    'private defender choices hidden before handover',
  );
  await shot('03-private-handover');
  await handover();
  for (const id of meta.additional.B)
    await page.getByRole('checkbox', { name: `Include commander ${id}`, exact: true }).check();
  assert.match(await page.getByTestId('participation-total').innerText(), /4 CP/);
  await shot('04-bravo-selects-4cp');
  await page.getByRole('button', { name: 'LOCK BRAVO COMMANDERS', exact: true }).click();
  await handover();
  const before = await read();
  await page.getByRole('button', { name: 'FIGHT TACTICAL BATTLE', exact: true }).click();
  await handover();
  const committed = await read();
  assert.deepEqual(committed.cp, { A: before.cp.A - 9, B: before.cp.B - 4 });
  for (const id of [...meta.additional.A, ...meta.additional.B, meta.declined]) {
    const initial = meta.posture.find((p) => p.id === id),
      current = committed.armies.find((a) => a.id === id);
    assert.equal(current.pos, initial.pos);
    assert.equal(current.movesLeft, initial.movesLeft);
  }
  const zones = await page.evaluate(() => {
    const { store, engine: e } = window.__ironRidge,
      g = store.getState().game,
      b = g.battle,
      c = e.buildContext(g.settings, b);
    return b.participants.map((p) => ({ ...p, cells: e.deploymentZone(c, b, p.team, p.armyId) }));
  });
  assert.equal(zones.length, 6);
  assert(zones.every((z) => z.cells.length > 0));
  const firstB = committed.battle.units.find((u) => u.holderId === meta.additional.B[1]);
  await page
    .getByRole('list', { name: 'Deployment roster' })
    .getByRole('button', { name: new RegExp(firstB.label) })
    .click();
  await shot('05-bravo-own-deployment-zone');
  await page.getByRole('button', { name: 'AUTO-DEPLOY', exact: true }).click();
  await page.getByRole('button', { name: 'READY ▶', exact: true }).click();
  await handover();
  const firstA = (await read()).battle.units.find((u) => u.holderId === meta.additional.A[1]);
  await page
    .getByRole('list', { name: 'Deployment roster' })
    .getByRole('button', { name: new RegExp(firstA.label) })
    .click();
  await shot('06-alpha-remote-deployment-zone');
  await page.getByRole('button', { name: 'AUTO-DEPLOY', exact: true }).click();
  await page.getByRole('button', { name: 'READY ▶', exact: true }).click();
  await handover();
  const combat = await read();
  assert.equal(combat.battle.phase, 'combat');
  assert(combat.battle.units.every((u) => u.pos));
  await shot('07-six-commander-combat');
  // Drive ordinary legal AI choices through the same action pipeline to a real terminal battle.
  const journey = await page.evaluate(() => {
    const { store, engine: e } = window.__ironRidge;
    let steps = 0,
      extract = false;
    const failures = [];
    while (steps < 6000) {
      const g = store.getState().game;
      if (!g.battle || g.battle.phase === 'over') break;
      const b = g.battle;
      let action = e.aiStep(g);
      if (b.active === b.attacker && e.holdsCaptureZone(e.contextFor(g), b, b.attacker)) {
        action = { type: 'extract' };
        extract = true;
      }
      if (!store.getState().dispatch(action)) {
        failures.push({ action, error: store.getState().error });
        break;
      }
      store.getState().dismissHandoff();
      steps++;
    }
    return {
      steps,
      extract,
      failures,
      battle: structuredClone(store.getState().game.battle),
      validation: e.validateGameState(store.getState().game),
    };
  });
  assert.deepEqual(journey.failures, []);
  assert.deepEqual(journey.validation, []);
  assert.equal(journey.battle.phase, 'over');
  await handover();
  await shot('08-real-battle-result');
  await page.getByRole('button', { name: 'RETURN TO CAMPAIGN', exact: true }).click();
  await handover();
  const final = await read();
  assert.deepEqual(
    final.armies.find((a) => a.id === meta.declined),
    committed.armies.find((a) => a.id === meta.declined),
  );
  for (const id of [...meta.additional.A, ...meta.additional.B]) {
    const current = final.armies.find((a) => a.id === id);
    if (current) {
      const p = meta.posture.find((p) => p.id === id);
      assert.equal(current.pos, p.pos);
      assert.equal(current.movesLeft, p.movesLeft);
      assert(current.units.every((u) => p.unitIds.includes(u.id)));
    }
  }
  await shot('09-preserved-commander-provenance');
  const webgl = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return {
      present: !!canvas,
      version: canvas?.getContext('webgl2')?.getParameter(7938),
      renderCalls: window.__ironRidge.scene?.renderer?.info?.render?.calls ?? null,
    };
  });
  assert.equal(webgl.present, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  const report = {
    status: 'PASS',
    observedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceClean:
      execFileSync('git', ['status', '--porcelain', '--', 'apps/web/src', 'packages/engine/src'], {
        encoding: 'utf8',
      }).trim() === '',
    preparedFixture: meta,
    selection: {
      A: pending.pending.participation.attackerIds,
      B: before.pending.participation.defenderIds,
    },
    cpBefore: before.cp,
    cpAfter: committed.cp,
    exactPendingReload: true,
    zones,
    combatUnitCount: combat.battle.units.length,
    journey: {
      steps: journey.steps,
      extracted: journey.extract,
      winner: journey.battle.winner,
      endReason: journey.battle.endReason,
    },
    finalValidation: await page.evaluate(() =>
      window.__ironRidge.engine.validateGameState(window.__ironRidge.store.getState().game),
    ),
    webgl,
    pageErrors: errors,
    aiWarnings: warnings,
    scope:
      'Visible engagement/selection/save/handover/deployment controls; final combat driven through legal shared-engine actions, no fabricated HP/winner/resource receipts.',
  };
  await fs.writeFile(`${out}/browser-report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        status: report.status,
        combatUnits: report.combatUnitCount,
        steps: report.journey.steps,
        extracted: report.journey.extracted,
        cp: report.cpAfter,
        webgl,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

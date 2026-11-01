// Additional controller coverage from the same paid-split review position, using real actions.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as engine from '../../../packages/engine/src/index.ts';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs'
);
const out = process.env.ENGAGEMENT_EVIDENCE_DIR ?? '/tmp/engagement-browser';
const fixture = JSON.parse(await fs.readFile('/tmp/engagement-review-fixture.json', 'utf8'));
const loaded = engine.deserializeSave(
  await fs.readFile('/tmp/engagement-review.save.json', 'utf8'),
);
assert.equal(loaded.ok, true);
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
const reports = [];
try {
  for (const [name, controllers] of [
    ['human-ai', { A: 'human', B: 'ai' }],
    ['ai-human', { A: 'ai', B: 'human' }],
    ['ai-ai', { A: 'ai', B: 'ai' }],
  ]) {
    let game = structuredClone(loaded.save.state);
    game.settings.controllers = controllers;
    const opened = engine.apply(game, {
      type: 'engage',
      armyId: fixture.primary.A,
      targetId: fixture.primary.B,
    });
    assert.equal(opened.error, null);
    game = opened.state;
    const file = `/tmp/engagement-${name}.save.json`;
    await fs.writeFile(file, engine.serializeSave(game, `Prepared ${name} engagement`));
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
    await page.evaluate(() => {
      const { store } = window.__ironRidge;
      store.getState().setAiSpeed(20);
      window.__modeProbe = { states: [], committed: false };
      const tick = store.getState().aiTick;
      store.setState({
        aiTick: () => {
          if (!window.__modeProbe.committed) tick();
        },
      });
      store.subscribe((s, old) => {
        if (!s.game) return;
        window.__modeProbe.states.push({
          phase: s.game.phase,
          stage: s.game.pending?.participation?.stage,
          cp: { ...s.game.cp },
          error: s.error,
        });
        if (
          old.game?.phase === 'battle-pending' &&
          old.game.pending?.participation?.stage === 'ready' &&
          (s.game.phase === 'battle' || s.game.pending === null)
        ) {
          window.__modeProbe.committed = true;
          store.getState().setAiSpeed(999999);
        }
      });
    });
    await page.getByLabel('Import save file', { exact: true }).setInputFiles(file);
    if (controllers.A === 'human') {
      await page
        .getByRole('checkbox', {
          name: `Include commander ${fixture.additional.A[0]}`,
          exact: true,
        })
        .check();
      await page
        .getByRole('checkbox', {
          name: `Include commander ${fixture.additional.A[1]}`,
          exact: true,
        })
        .check();
      await page.getByRole('button', { name: 'LOCK ALPHA COMMANDERS', exact: true }).click();
    }
    if (controllers.B === 'human') {
      await page
        .getByRole('checkbox', {
          name: `Include commander ${fixture.additional.B[0]}`,
          exact: true,
        })
        .check();
      await page
        .getByRole('checkbox', {
          name: `Include commander ${fixture.additional.B[1]}`,
          exact: true,
        })
        .check();
      await page.getByRole('button', { name: 'LOCK BRAVO COMMANDERS', exact: true }).click();
    }
    if (Object.values(controllers).includes('human'))
      await page.getByRole('button', { name: 'AUTO-RESOLVE', exact: true }).click();
    await page.waitForFunction(() => window.__modeProbe?.committed);
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => {
      const { store, engine: e } = window.__ironRidge,
        g = store.getState().game;
      return {
        game: structuredClone(g),
        probe: window.__modeProbe,
        errors: e.validateGameState(g),
      };
    });
    assert.deepEqual(state.errors, []);
    assert(state.probe.states.every((s) => !s.error));
    assert(state.probe.states.some((s) => s.stage === 'defender'));
    assert(state.probe.states.some((s) => s.stage === 'ready'));
    for (const id of [...fixture.additional.A, ...fixture.additional.B]) {
      const current = state.game.armies.find((a) => a.id === id),
        original = fixture.posture.find((p) => p.id === id);
      if (current) {
        assert.equal(current.pos, original.pos);
        assert.equal(current.movesLeft, original.movesLeft);
        assert(current.units.every((u) => original.unitIds.includes(u.id)));
      }
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${out}/controller-${name}.png`, fullPage: true });
    reports.push({
      mode: name,
      controllers,
      realSelectionStages: true,
      transitions: state.probe.states,
      committed: state.probe.committed,
      phase: state.game.phase,
      cp: state.game.cp,
      validationErrors: state.errors,
      pageErrors: errors,
    });
    await page.close();
  }
  const report = {
    status: 'PASS',
    observedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceClean:
      execFileSync('git', ['status', '--porcelain', '--', 'apps/web/src', 'packages/engine/src'], {
        encoding: 'utf8',
      }).trim() === '',
    modes: reports,
    scope:
      'Real AI side-selection/commit through current app. Human choices use visible controls; same paid-split fixture with prepared initial positions. Pacing pauses only after actual commitment.',
  };
  await fs.writeFile(`${out}/controller-report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        status: report.status,
        modes: reports.map((m) => ({
          mode: m.mode,
          phase: m.phase,
          cp: m.cp,
          transitions: m.transitions.length,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

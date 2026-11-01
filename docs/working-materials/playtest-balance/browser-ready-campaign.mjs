// Cloud Chromium proof of the ordinary setup, Balance Lab and generated campaign.
// Requires the Vite dev server. No user-desktop access or public deployment is implied.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
const out = process.env.PLAYTEST_EVIDENCE_DIR ?? '/tmp/playtest-balance-browser';
await fs.mkdir(out, { recursive: true });
const recipe = JSON.parse(await fs.readFile('apps/web/public/scenarios/strategic-objectives-playtest.json', 'utf8'));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const report = { sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), startedAt: new Date().toISOString(), host: 'cloud Chromium at localhost; not the user workstation', checks: {}, controllers: [], screenshots: [], errors: [] };
const makePage = async () => {
  const page = await browser.newPage({viewport: {width: 1512, height: 1100}, acceptDownloads: true});
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.__ironRidge?.store);
  return page;
};
const shot = async (page, name, locator) => {
  await page.waitForTimeout(150);
  await (locator ?? page).screenshot({path:`${out}/${name}.png`, ...(locator ? {} : {fullPage:true})});
  report.screenshots.push(`${name}.png`);
};
const read = page => page.evaluate(() => structuredClone(window.__ironRidge.store.getState().game));
const handover = async page => {
  const button = page.getByRole('button', {name: /I AM .*CONTINUE/});
  if (await button.count()) await button.click();
};
const probe = page => page.evaluate(() => {
  const {store} = window.__ironRidge;
  const tick = store.getState().aiTick;
  window.__playtestProbe = {calls:0, errors:[]};
  store.getState().setAiSpeed(20);
  // Bound the smoke test after one real AI tick; this does not edit game state.
  store.setState({aiTick: () => {
    if(window.__playtestProbe.calls >= 1) return;
    tick();
    window.__playtestProbe.calls++;
    if(store.getState().error) window.__playtestProbe.errors.push(store.getState().error);
  }});
});
try {
  const page = await makePage();
  assert.equal(await page.getByLabel('Commander training price (CP)').inputValue(), '15');
  assert.equal(await page.getByRole('button', {name:'START NEW GAME', exact:true}).isEnabled(), true);
  await page.getByRole('button', {name:'ADVANCED SEEDED NODES', exact:true}).click();
  assert.equal(await page.getByLabel('Capture Node price (CP)').inputValue(), '5');
  assert.equal(await page.getByLabel('Raze Node price (CP)').inputValue(), '2');
  await page.getByLabel('Capture Node price (CP)').fill('');
  assert.equal(await page.getByRole('button', {name:'START NEW GAME', exact:true}).isDisabled(), true);
  await page.getByRole('button', {name:/BALANCE LAB/}).click();
  assert.equal(await page.getByRole('button', {name:/Apply & new game/i}).isDisabled(), true);
  await page.getByRole('button', {name:/Back to setup/i}).click();
  assert.equal(await page.getByLabel('Capture Node price (CP)').inputValue(), '');
  report.checks.defaultsAndClearedPriceGate = 'PASS';
  await page.getByRole('button', {name:'USE READY PLAYTEST SETUP', exact:true}).click();
  assert.equal(await page.getByRole('button', {name:'ADVANCED SEEDED NODES', exact:true}).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByLabel('MAP SEED', {exact:true}).inputValue(), '20261101');
  assert.equal(await page.getByLabel('NODE PLACEMENT SEED', {exact:true}).inputValue(), '4277');
  assert.equal(await page.getByLabel('NON-HQ NODES', {exact:true}).inputValue(), '3');
  await shot(page, '01-ready-setup');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name:'DOWNLOAD READY PLAYTEST CONFIG', exact:true}).click();
  const download = await downloaded;
  await download.saveAs(`${out}/strategic-objectives-playtest.json`);
  assert.deepEqual(JSON.parse(await fs.readFile(`${out}/strategic-objectives-playtest.json`, 'utf8')), recipe);
  report.checks.downloadEqualsRepositoryRecipe = 'PASS';
  await page.getByRole('button', {name:/BALANCE LAB/}).click();
  const tank = page.getByTestId('unit-card-ww2_tank');
  assert.equal(await tank.getByLabel(/MAX RNG/).inputValue(), '8');
  const bazooka = page.getByTestId('unit-card-ww2_at_infantry');
  assert.equal(await bazooka.getByLabel(/MAX RNG/).inputValue(), '10');
  assert.equal(await bazooka.getByLabel(/RANGE PROFILE/).inputValue(), 'bazooka');
  assert.equal(await page.getByLabel('mechanics BAZOOKA_ACCURATE_RANGE', {exact:true}).inputValue(), '5');
  assert.equal(await page.getByLabel('mechanics TANK_MOVED_FIRE_ADJUSTMENT', {exact:true}).inputValue(), '-2');
  await shot(page, '02-tank-editable', tank);
  await shot(page, '03-bazooka-editable', bazooka);
  await shot(page, '04-mechanics-editable', page.getByTestId('mechanics-card'));
  await page.getByRole('button', {name:/Back to setup/i}).click();
  assert.equal(await page.getByLabel('NODE PLACEMENT SEED', {exact:true}).inputValue(), '4277');
  assert.equal(await page.getByLabel('NON-HQ NODES', {exact:true}).inputValue(), '3');
  report.checks.readyProfileInLabAndReturnSetup = 'PASS';
  await page.getByRole('button', {name:'START NEW GAME', exact:true}).click();
  await handover(page);
  await page.waitForFunction(() => window.__ironRidge?.scene?.renderer?.info?.render?.calls > 0);
  const game = await read(page);
  assert.deepEqual(game.settings, recipe.settings);
  const facts = await page.evaluate(() => {
    const {engine:e, store, scene} = window.__ironRidge, g=store.getState().game;
    const {world, terrain} = e.worldOf(g);
    const extras=g.infrastructure.sites.filter(s=>s.homeTeam===null);
    const paths={};
    for(const team of ['A','B']) {
      const holder=g.armies.find(a=>a.team===team&&a.kind==='commander');
      const reach=e.commanderReach(g,{...holder,movesLeft:world.subs.length});
      paths[team]={central:reach.get(e.hexKey(world.mainByKey.get('2,2').center)),near:reach.get(e.hexKey(world.mainByKey.get(team==='A'?'0,2':'4,2').center))};
    }
    return {validation:e.validateGameState(g), nodes:g.infrastructure.sites.length, extras:extras.map(s=>s.mainHex), centerHeight:terrain.heights[world.subByKey.get(e.hexKey(world.mainByKey.get('2,2').center)).index], paths, renderCalls:scene.renderer.info.render.calls};
  });
  assert.deepEqual(facts.validation, []);
  assert.equal(facts.nodes, 5);
  assert.deepEqual(facts.extras, ['0,2','2,2','4,2']);
  assert.equal(facts.centerHeight, 7);
  assert.deepEqual(facts.paths, {A:{central:26,near:8},B:{central:26,near:8}});
  await shot(page, '05-regular-human-ai-campaign');
  await fs.writeFile(`${out}/ready-campaign.save.json`, await page.evaluate(() => window.__ironRidge.engine.serializeSave(window.__ironRidge.store.getState().game, 'Ready regular strategic-objectives playtest')));
  await page.reload();
  await page.getByRole('button', {name:'CONTINUE', exact:true}).click();
  await handover(page);
  assert.deepEqual(await read(page), game);
  await page.waitForFunction(() => window.__ironRidge?.scene?.renderer?.info?.render?.calls > 0);
  await shot(page, '06-exact-save-continuation');
  report.checks.regularGeneratedCampaign = facts;
  report.checks.exactSaveReload = 'PASS';
  await probe(page);
  await page.getByRole('button', {name:/END TURN/}).click();
  await page.waitForFunction(() => window.__playtestProbe.calls === 1);
  const humanAi = await page.evaluate(() => ({validation:window.__ironRidge.engine.validateGameState(window.__ironRidge.store.getState().game), probe:window.__playtestProbe, controllers:window.__ironRidge.store.getState().game.settings.controllers}));
  assert.deepEqual(humanAi.validation,[]);
  assert.deepEqual(humanAi.probe.errors,[]);
  report.controllers.push({name:'human-ai',...humanAi});
  await page.close();
  for(const [name, button, controllers] of [['human-human','HOTSEAT 2P',{A:'human',B:'human'}],['ai-ai','AI vs AI',{A:'ai',B:'ai'}]]) {
    const p=await makePage();
    await p.getByRole('button',{name:'USE READY PLAYTEST SETUP',exact:true}).click();
    await p.getByRole('button',{name:button,exact:true}).click();
    if(name==='ai-ai') await probe(p);
    await p.getByRole('button',{name:'START NEW GAME',exact:true}).click();
    await handover(p);
    if(name==='ai-ai') await p.waitForFunction(()=>window.__playtestProbe.calls===1);
    await p.waitForFunction(()=>window.__ironRidge?.scene?.renderer?.info?.render?.calls>0);
    const result=await p.evaluate(()=>({controllers:window.__ironRidge.store.getState().game.settings.controllers,validation:window.__ironRidge.engine.validateGameState(window.__ironRidge.store.getState().game),rules:structuredClone(window.__ironRidge.store.getState().game.settings.rules),nodes:window.__ironRidge.store.getState().game.infrastructure.sites.length,probe:window.__playtestProbe??null}));
    assert.deepEqual(result.controllers,controllers);
    assert.deepEqual(result.validation,[]);
    assert.deepEqual(result.rules,recipe.settings.rules);
    assert.equal(result.nodes,5);
    if(result.probe) assert.deepEqual(result.probe.errors,[]);
    await shot(p,`07-controller-${name}`);
    report.controllers.push({name,...result});
    await p.close();
  }
  assert.deepEqual(report.errors,[]);
  report.completedAt=new Date().toISOString();
  report.status='PASS';
} catch(error) {
  report.status='FAIL';
  report.failure=error.stack;
  throw error;
} finally {
  await fs.writeFile(`${out}/browser-ready-campaign.json`,JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
console.log(JSON.stringify({status:report.status,checks:Object.keys(report.checks),controllers:report.controllers.map(x=>x.name),screenshots:report.screenshots.length,out}));

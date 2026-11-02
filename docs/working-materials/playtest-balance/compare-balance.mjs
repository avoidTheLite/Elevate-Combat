// Run from the product root with Node24; results are evidence, not final balance approval.
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  PLAYTEST_BALANCE_RULES, withRules, previewAttack, resolveAttack, createRng,
  compareRules, unitType, validateRulesOverride,
} from '../../../packages/engine/src/index.ts';
import { flatBattle, mkUnit } from '../../../packages/engine/src/testBattle.ts';
const out = process.argv[2] ?? '/tmp/playtest-balance-comparison.json';
function fixture(type, distance, moved = false, facing = 3, targetType = 'ww2_tank') {
  const key = `${distance},${-Math.floor(distance / 2)}`;
  const attacker = mkUnit('attacker', type, 'A', '0,0');
  attacker.deployed = true;
  attacker.moved = moved;
  const target = mkUnit('target', targetType, 'B', key, facing);
  const spotter = mkUnit('spotter', 'ww2_rifle_infantry', 'A', `${distance - 1},${1 - Math.floor(distance / 2)}`);
  return { ...flatBattle([attacker, target, spotter]), attacker, target, key };
}
const scenarios = [
  ['bazooka front r2', 'ww2_at_infantry', 2],
  ['bazooka front r5', 'ww2_at_infantry', 5],
  ['bazooka front r6', 'ww2_at_infantry', 6],
  ['bazooka front r10', 'ww2_at_infantry', 10],
  ['tank front r5 stationary', 'ww2_tank', 5],
  ['tank front r5 moved', 'ww2_tank', 5, true],
  ['tank side r5 moved', 'ww2_tank', 5, true, 2],
  ['tank front r3 vs artillery', 'ww2_tank', 3, false, 3, 'ww2_artillery'],
  ['bazooka front r3 vs artillery', 'ww2_at_infantry', 3, false, 3, 'ww2_artillery'],
];
function witness(row, rules) {
  return withRules(rules, () => {
    const [, ...args] = row;
    const x = fixture(...args);
    const p = previewAttack(x.ctx, x.battle, x.attacker, x.key);
    let hits = 0, kills = 0, damage = 0;
    const n = 256;
    if (p.legal) for (let seed = 101; seed < 101 + n; seed++) {
      const y = fixture(...args);
      const before = y.target.hp;
      const r = resolveAttack(y.ctx, createRng(seed), y.battle, y.attacker, y.key);
      if ('error' in r) throw new Error(r.error);
      if (r.result === 'direct') hits++;
      kills += y.target.hp <= 0 ? 1 : 0;
      damage += before - y.target.hp;
    }
    return { legal: p.legal, reason: p.reason, distance: p.distance, effectiveRange: p.effectiveRange,
      band: p.band, targetHp: x.target.hp, targetArmor: unitType(x.target.typeId).armorClass,
      tn: p.tn, pDirect: p.pDirect, expectedDamage: p.expectedDamage, arc: p.arc,
      facingDamage: p.facingDamage, modifiers: p.modifiers,
      matchedSeeds: p.legal ? { first:101, count:n, directHits:hits, kills, meanDamage:damage/n } : null };
  });
}
const battles = [
  {name:'bazooka-pair-vs-tank', era:'ww2', attacker:{units:[{typeId:'ww2_at_infantry',count:2}]}, defender:{units:[{typeId:'ww2_tank',count:1}]}, terrain:{kind:'flat'},maxRounds:10},
  {name:'tank-vs-motorized-artillery', era:'ww2', attacker:{units:[{typeId:'ww2_tank',count:1}]}, defender:{units:[{typeId:'ww2_artillery',count:1}]}, terrain:{kind:'flat'},maxRounds:10},
  {name:'mixed-squad', era:'ww2', attacker:{units:[{typeId:'ww2_at_infantry',count:1},{typeId:'ww2_rifle_infantry',count:2}]}, defender:{units:[{typeId:'ww2_tank',count:1},{typeId:'ww2_rifle_infantry',count:1}]}, terrain:{kind:'ridge'},maxRounds:10},
];
if (!validateRulesOverride(PLAYTEST_BALANCE_RULES).ok) throw new Error('Invalid trial profile');
const report = { generatedAt:new Date().toISOString(), implementationSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  scope:'tentative trial: controlled previews + matched seeded legal attacks + actual AI-AI Battle Lab scenarios; not a balance target or population estimate',
  trialRules:PLAYTEST_BALANCE_RULES,
  previews:scenarios.map(row=>({name:row[0],baseline:witness(row),trial:witness(row,PLAYTEST_BALANCE_RULES)})),
  matchedBattles:compareRules(battles,undefined,PLAYTEST_BALANCE_RULES,8,201),
};
await fs.writeFile(out, JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({out,previews:report.previews.map(x=>({name:x.name,baseline:x.baseline.pDirect,trial:x.trial.pDirect,trialKills:x.trial.matchedSeeds?.kills})),matchedBattles:report.matchedBattles},null,2));

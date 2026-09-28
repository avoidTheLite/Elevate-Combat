/* eslint-disable @typescript-eslint/no-explicit-any -- builds raw legacy JSON */
// Regenerate the standard save fixtures in fixtures/saves/.
//   pnpm --filter @iron-ridge/engine fixtures:saves
// Fully deterministic: fixed seeds, fixed `savedAt`, AI-driven play only.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aiStep,
  apply,
  canEngage,
  commanderReach,
  COMMAND,
  createGame,
  hexDistance,
  serializeSave,
  worldOf,
} from '../src/index.ts';
import type { GameAction, GameSettings, GameState } from '../src/index.ts';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/saves');
const SAVED_AT = '2026-01-01T00:00:00.000Z';

function base(over: Partial<GameSettings> = {}): GameSettings {
  return {
    era: 'ww2',
    grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
    seed: 4242,
    controllers: { A: 'human', B: 'ai' },
    fog: true,
    battleRounds: 6,
    battleObjective: { kind: 'capture_point', captureRadius: 1, extractionAtOrigin: true },
    ...over,
  };
}

function act(s: GameState, a: GameAction): GameState {
  const r = apply(s, a);
  if (r.error) throw new Error(`${a.type}: ${r.error}`);
  return r.state;
}

/** One AI decision for whoever is acting, regardless of controllers (fallbacks as runAi). */
function step(s: GameState): GameState {
  const r = apply(s, aiStep(s));
  if (!r.error) return r.state;
  const fallback: GameAction =
    s.phase === 'battle'
      ? s.battle?.phase === 'deploy'
        ? { type: 'finishDeploy' }
        : { type: 'endBattleTurn' }
      : { type: 'endTurn' };
  return act(s, fallback);
}

/** March A's first commander at B's first commander and engage (as game.test's forceBattle). */
function forceEngagement(state: GameState): GameState {
  let s = state;
  for (let i = 0; i < 80 && s.phase === 'strategic'; i++) {
    const army = s.armies.find((a) => a.team === s.active && a.kind === 'commander');
    if (s.active !== 'A' || !army || army.movesLeft <= 0) {
      s = act(s, { type: 'endTurn' });
      continue;
    }
    const target = s.armies.find((a) => a.team === 'B' && a.kind === 'commander')!;
    if (canEngage(s, army, target).ok)
      return act(s, { type: 'engage', armyId: army.id, targetId: target.id });
    const { world } = worldOf(s);
    const goal = world.subByKey.get(target.pos)!.hex;
    const range = COMMAND.engageRange(world.config.subRadius);
    const cells = [...commanderReach(s, army)].filter(([, d]) => d > 0);
    const dist = (k: string): number => hexDistance(world.subByKey.get(k)!.hex, goal);
    const inRange = cells.filter(([k, d]) => dist(k) <= range && d < army.movesLeft);
    const pick = (inRange.length ? inRange : cells).sort(([a, da], [b, db]) =>
      inRange.length ? da - db : dist(a) - dist(b),
    )[0];
    const r = pick ? apply(s, { type: 'moveCommander', armyId: army.id, dest: pick[0] }) : null;
    s = r && !r.error ? r.state : act(s, { type: 'endTurn' });
  }
  if (s.phase !== 'battle-pending') throw new Error('could not force an engagement');
  return s;
}

function until(s: GameState, done: (s: GameState) => boolean, limit = 3000): GameState {
  for (let i = 0; i < limit && !done(s); i++) s = step(s);
  if (!done(s)) throw new Error('condition never reached');
  return s;
}

function write(name: string, text: string): void {
  writeFileSync(resolve(OUT, `${name}.json`), text.endsWith('\n') ? text : `${text}\n`);
  console.log(`  ${name}.json  ${(text.length / 1024).toFixed(1)} KB`);
}

function save(name: string, s: GameState, label: string): void {
  write(name, JSON.stringify(JSON.parse(serializeSave(s, label, SAVED_AT)), null, 1));
}

/** Rewrite a V1 state as the bare V0.9 GameState it would have been. */
function toLegacy(s: GameState): unknown {
  const g = structuredClone(s) as unknown as Record<string, any>;
  g.version = '0.9.0';
  delete g.settings.transferRule;
  delete g.settings.rules;
  const armies: Record<string, any>[] = [];
  for (const a of g.armies) {
    if (a.kind === 'garrison') {
      // V0.9 had no garrisons: recruits formed an army on the HQ hex.
      if (a.units.length)
        armies.push({ id: a.id, team: a.team, at: a.at, units: a.units, movesLeft: 0 });
      continue;
    }
    armies.push({
      id: a.id,
      team: a.team,
      at: a.at,
      units: a.units,
      movesLeft: a.movesLeft > 0 ? 1 : 0,
    });
  }
  g.armies = armies;
  if (g.battle) {
    delete g.battle.objective;
    delete g.battle.extracted;
    for (const u of g.battle.units) {
      u.revealed = u.exposed;
      delete u.exposed;
    }
  }
  return g;
}

mkdirSync(OUT, { recursive: true });
console.log(`Writing save fixtures to ${OUT}`);

// Strategic
const t1 = createGame(base());
save('strategic-t1', t1, 'Turn 1 · fresh campaign');

let mid = createGame(base({ seed: 777 }));
mid = until(
  mid,
  (s) => s.phase === 'over' || (s.phase === 'strategic' && s.turn >= 6 && s.active === 'A'),
);
save('strategic-midgame', mid, 'Midgame after 10 AI turns');

// Battle sequence
const pending = forceEngagement(createGame(base()));
save('battle-pending', pending, 'Assault pending');
const deploy = act(pending, { type: 'startBattle' });
save('battle-deploy', deploy, 'Battle · deployment');
const combat = until(deploy, (s) => s.battle?.phase === 'combat' && s.battle.round >= 2);
save('battle-combat', combat, 'Battle · combat round 2');
const over = until(combat, (s) => s.battle?.phase === 'over' || s.phase !== 'battle');
if (over.battle?.phase !== 'over') throw new Error('battle ended without an over screen');
save('battle-over', over, 'Battle · result');

// Hotseat, fog, mid battle (medieval for era coverage)
const hs = forceEngagement(
  createGame(base({ era: 'medieval', seed: 99, controllers: { A: 'human', B: 'human' } })),
);
const hsCombat = until(
  act(hs, { type: 'startBattle' }),
  (s) => s.battle?.phase === 'combat' && s.battle.round >= 1,
);
save('hotseat-fog', hsCombat, 'Hotseat · medieval battle');

// Rules override (balance-lab settings) carried in the save
let rules = createGame(
  base({
    seed: 31,
    rules: {
      units: { ww2_rifle_infantry: { cost: 2, hp: 12 }, ww2_tank: { move: 5 } },
      mechanics: { MELEE_TN: -1 },
    },
  }),
);
rules = act(rules, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
rules = until(rules, (s) => s.phase === 'strategic' && s.turn >= 3 && s.active === 'A');
save('with-rules-override', rules, 'Rules override · turn 3');

// Legacy V0.9 bare GameState (mid battle: no objective, `revealed` units, main-hex armies)
write('legacy-0.9.0', JSON.stringify(toLegacy(combat), null, 1));

// Broken files
const corrupt = JSON.parse(serializeSave(t1, 'Corrupt', SAVED_AT));
corrupt.state.armies[0].pos = 'nowhere';
corrupt.state.armies[1].units[0] = { id: 7, typeId: 'laser_tank', hp: -3 };
corrupt.state.cp.A = -50;
corrupt.state.phase = 'battle';
write('corrupt', JSON.stringify(corrupt, null, 1));
const full = serializeSave(t1, 'Truncated', SAVED_AT);
writeFileSync(resolve(OUT, 'truncated.json'), full.slice(0, Math.floor(full.length / 2)));
console.log('  truncated.json');

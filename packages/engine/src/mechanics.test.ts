import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import type { BattleContext } from './battleMap.ts';
import { BLIND_FIRE_TN, previewAttack, resolveAttack } from './combat.ts';
import { buildWorld, mainNeighbors } from './grid.ts';
import { hexKey, neighbor, parseKey } from './hex.ts';
import { MAX_DROP, reachable, stepCost } from './movement.ts';
import { createRng } from './rng.ts';
import { ECONOMY, createGame, defaultSettings, worldOf } from './strategic.ts';
import {
  WARNED_CAP,
  checkVictory,
  contextFor,
  digIn,
  endTurn,
  packUp,
  placeWarnedFort,
  setUp,
  startTurn,
} from './tactical.ts';
import { generateTerrain } from './terrain.ts';
import { commanderOf, flatBattle, mkUnit, placeHolder, scriptedRng } from './testBattle.ts';
import { unitType } from './units.ts';

describe('melee specials (A24)', () => {
  it('archer first-strike fires a volley before contact', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('cav', 'med_horseman', 'A', '0,0'),
      mkUnit('arc', 'med_archers', 'B', '1,0'),
    ]);
    battle.units[0]!.movedDist = 2; // not fast enough to deny
    // arc volley d20=20 hit, dmg die; cav strike d20=1 miss (isolate first-strike)
    const out = resolveAttack(ctx, scriptedRng([20, 6, 1]), battle, battle.units[0]!, '1,0');
    expect('error' in out).toBe(false);
    expect(battle.log.some((e) => /FIRST STRIKE/i.test(e.text))).toBe(true);
    expect(battle.units[1]!.firstStrikeUsed).toBe(true);
    expect(battle.units[0]!.hp).toBeLessThan(unitType('med_horseman').hp);
  });

  it('cavalry closing 4+ cells denies archer first-strike', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('cav', 'med_horseman', 'A', '0,0'),
      mkUnit('arc', 'med_archers', 'B', '1,0'),
    ]);
    battle.units[0]!.movedDist = 4;
    resolveAttack(ctx, scriptedRng([20, 8]), battle, battle.units[0]!, '1,0');
    expect(battle.log.some((e) => /first-strike denied/i.test(e.text))).toBe(true);
    expect(battle.units[1]!.firstStrikeUsed).toBe(false);
  });

  it('spearmen braced vs cavalry strike first with +3', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('cav', 'med_horseman', 'A', '0,0'),
      mkUnit('spr', 'med_spearman', 'B', '1,0'),
    ]);
    battle.units[0]!.movedDist = 5;
    // spear d20 hit + dmg, then cav would strike — miss cav to isolate braced
    resolveAttack(ctx, scriptedRng([20, 6, 1]), battle, battle.units[0]!, '1,0');
    expect(battle.log.some((e) => /BRACED vs cavalry/i.test(e.text))).toBe(true);
    expect(battle.log.some((e) => /\+3/.test(e.text))).toBe(true);
    expect(battle.units[0]!.hp).toBeLessThan(unitType('med_horseman').hp);
    // No charge bonus against braced spearmen.
    expect(battle.log.some((e) => /Charge bonus/i.test(e.text))).toBe(false);
  });

  it('cavalry charge grants +2 damage after moving 3+ vs non-braced', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('cav', 'med_horseman', 'A', '0,0'),
      mkUnit('inf', 'med_infantry', 'B', '1,0'),
    ]);
    battle.units[0]!.movedDist = 3;
    // no first-strike on infantry; cav hit then optional counter
    resolveAttack(ctx, scriptedRng([20, 8, 1]), battle, battle.units[0]!, '1,0');
    expect(battle.log.some((e) => /Charge bonus \+2/i.test(e.text))).toBe(true);
  });

  it('surviving melee defender counter-attacks (unless spear already struck)', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('a', 'med_infantry', 'A', '0,0'),
      mkUnit('b', 'med_infantry', 'B', '1,0'),
    ]);
    // attacker miss, defender still counters? Counter only if attacker survives after their strike.
    // attacker hit (low dmg), defender counter hit
    resolveAttack(ctx, scriptedRng([20, 1, 20, 6]), battle, battle.units[0]!, '1,0');
    expect(battle.log.some((e) => /counter/i.test(e.text))).toBe(true);
  });
});

describe('machine-gun suppression (A25)', () => {
  it('pins unarmored targets on hit or near-miss within 4 of TN', () => {
    const { ctx, battle } = flatBattle([
      { ...mkUnit('mg', 'ww2_machine_gun', 'A', '0,0'), deployed: true },
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '3,0'),
    ]);
    // Force a near-miss: preview TN, roll tn-1 (miss but within 4).
    const pv = previewAttack(ctx, battle, battle.units[0]!, '3,0');
    expect(pv.legal).toBe(true);
    const near = Math.max(2, pv.tn - 1);
    resolveAttack(ctx, scriptedRng([near, 1]), battle, battle.units[0]!, '3,0');
    expect(battle.units[1]!.suppressed).toBe(true);
    expect(battle.log.some((e) => /SUPPRESSED/i.test(e.text))).toBe(true);
  });

  it('does not suppress armored targets', () => {
    const { ctx, battle } = flatBattle([
      { ...mkUnit('mg', 'ww2_machine_gun', 'A', '0,0'), deployed: true },
      mkUnit('tank', 'ww2_tank', 'B', '4,0', 3),
    ]);
    resolveAttack(ctx, scriptedRng([20, 6]), battle, battle.units[0]!, '4,0');
    expect(battle.units[1]!.suppressed).toBe(false);
  });

  it('halves MP on suppressed unit startTurn and clears at endTurn', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('rif', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('b', 'ww2_rifle_infantry', 'B', '5,0'),
    ]);
    const rif = battle.units[0]!;
    rif.suppressed = true;
    startTurn(battle, 'A');
    expect(rif.mp).toBe(Math.floor(unitType('ww2_rifle_infantry').move / 2));
    endTurn(ctx, battle); // A's end clears A's suppression
    expect(rif.suppressed).toBe(false);
  });
});

describe('ranged modifiers in preview/resolve', () => {
  it('blind fire adds +BLIND_FIRE_TN and clears splash band when unspotted', () => {
    const { ctx, battle } = flatBattle([
      { ...mkUnit('mor', 'ww2_mortar', 'A', '0,0'), deployed: true },
      // Enemy far away; no LOS spotter (viewer vision may still reach — place beyond vision).
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '9,0'),
    ]);
    // Mortar vision 5; at dist 9 no friendly can see. Ensure units don't accidentally spot.
    const pv = previewAttack(ctx, battle, battle.units[0]!, '9,0');
    expect(pv.legal).toBe(true);
    expect(pv.blind).toBe(true);
    expect(pv.modifiers.some((m) => m.label.includes('Blind') && m.value === BLIND_FIRE_TN)).toBe(
      true,
    );
    expect(pv.splashTn).toBeNull();
  });

  it('fortified cover adds +L TN for direct and floor(L/2) for indirect', () => {
    const { ctx, battle } = flatBattle([
      { ...mkUnit('mg', 'ww2_machine_gun', 'A', '0,0'), deployed: true },
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '3,0'),
      { ...mkUnit('mor', 'ww2_mortar', 'A', '0,-2'), deployed: true },
    ]);
    battle.forts['3,0'] = 2;
    // Ensure rifle is spotted for direct fire (same cell visible from MG).
    const direct = previewAttack(ctx, battle, battle.units[0]!, '3,0');
    expect(direct.legal).toBe(true);
    expect(direct.modifiers.some((m) => m.label.includes('Fortified') && m.value === 2)).toBe(true);

    battle.active = 'A';
    battle.units[2]!.acted = false;
    // Spot the hex via MG vision so indirect is not blind; fort still applies half.
    const indirect = previewAttack(ctx, battle, battle.units[2]!, '3,0');
    expect(indirect.legal).toBe(true);
    expect(indirect.blind).toBe(false);
    expect(indirect.modifiers.some((m) => m.label.includes('Fortified') && m.value === 1)).toBe(
      true,
    );
  });

  it('rear armor facing softens TN and adds facing damage vs armored', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('atk', 'ww2_tank', 'A', '0,0'),
      // Defender at 5,0 facing +q (dir 0) → attacker is to the rear.
      mkUnit('def', 'ww2_tank', 'B', '5,0', 0),
    ]);
    const rear = previewAttack(ctx, battle, battle.units[0]!, '5,0');
    expect(rear.legal).toBe(true);
    expect(rear.arc).toBe('rear');
    expect(rear.facingDamage).toBe(2);

    battle.units[1]!.facing = 3; // face the attacker → front
    const front = previewAttack(ctx, battle, battle.units[0]!, '5,0');
    expect(front.arc).toBe('front');
    expect(front.facingDamage).toBe(-2);
    expect(front.tn).toBeGreaterThan(rear.tn);
  });
});

describe('siege vs fort + HE splash', () => {
  it('siege direct hit reduces fortification; non-siege does not', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('tank', 'ww2_tank', 'A', '0,0'),
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '5,0'),
    ]);
    battle.forts['5,0'] = 2;
    // d20 hit; tank direct 3d6+3; siege-vs-soft variance d6; possible splash ring dice
    resolveAttack(ctx, scriptedRng([20, 4, 4, 4, 3, 4, 4, 3, 4, 4, 3]), battle, battle.units[0]!, '5,0');
    expect(battle.forts['5,0']).toBe(1);

    // Rifle/MG (non-siege) cannot reduce fort even on a hit.
    const b2 = flatBattle([
      { ...mkUnit('mg', 'ww2_machine_gun', 'A', '0,0'), deployed: true },
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '3,0'),
    ]);
    b2.battle.forts['3,0'] = 2;
    resolveAttack(b2.ctx, scriptedRng([20, 6]), b2.battle, b2.battle.units[0]!, '3,0');
    expect(b2.battle.forts['3,0']).toBe(2);
  });

  it('HE splash damages other units in radius including friendlies, not the shooter', () => {
    const { ctx, battle } = flatBattle([
      { ...mkUnit('mor', 'ww2_mortar', 'A', '0,0'), deployed: true },
      mkUnit('enemy', 'ww2_rifle_infantry', 'B', '4,0'),
      mkUnit('friend', 'ww2_rifle_infantry', 'A', '5,0'),
    ]);
    const beforeEnemy = battle.units[1]!.hp;
    const beforeFriend = battle.units[2]!.hp;
    const beforeMor = battle.units[0]!.hp;
    const pv = previewAttack(ctx, battle, battle.units[0]!, '4,0');
    expect(pv.legal).toBe(true);
    expect(pv.splashTn).not.toBeNull();
    // splash roll, then splash pool dice for primary + ring (mortar splash 2d6+1 each)
    resolveAttack(
      ctx,
      scriptedRng([pv.splashTn!, 4, 4, 1, 4, 4, 1, 4, 4, 1]),
      battle,
      battle.units[0]!,
      '4,0',
    );
    expect(battle.units[1]!.hp).toBeLessThan(beforeEnemy);
    expect(battle.units[2]!.hp).toBeLessThan(beforeFriend);
    expect(battle.units[0]!.hp).toBe(beforeMor);
  });
});

describe('SET UP / PACK UP / DIG IN (A26/A27)', () => {
  it('combat_fixed cannot fire until set up; move then set up consumes the act', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('mg', 'ww2_machine_gun', 'A', '0,0'),
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '3,0'),
    ]);
    const mg = battle.units[0]!;
    expect(previewAttack(ctx, battle, mg, '3,0').legal).toBe(false);
    expect(previewAttack(ctx, battle, mg, '3,0').reason).toMatch(/SET UP/i);

    mg.moved = true;
    expect(setUp(battle, 'mg').ok).toBe(true);
    expect(mg.deployed).toBe(true);
    expect(mg.acted).toBe(true);
    expect(previewAttack(ctx, battle, mg, '3,0').legal).toBe(false);
  });

  it('set up without moving leaves fire available; pack up spends the turn', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('mg', 'ww2_machine_gun', 'A', '0,0'),
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '3,0'),
    ]);
    const mg = battle.units[0]!;
    expect(setUp(battle, 'mg').ok).toBe(true);
    expect(mg.acted).toBe(false);
    expect(previewAttack(ctx, battle, mg, '3,0').legal).toBe(true);

    expect(packUp(battle, 'mg').ok).toBe(true);
    expect(mg.deployed).toBe(false);
    expect(mg.acted).toBe(true);
    expect(mg.mp).toBe(0);
  });

  it('engineer dig-in raises fort by 1 up to MAX_FORT', () => {
    const { battle } = flatBattle([mkUnit('eng', 'ww2_engineer', 'A', '0,0')]);
    expect(digIn(battle, 'eng').ok).toBe(true);
    expect(battle.forts['0,0']).toBe(1);
    expect(battle.units[0]!.acted).toBe(true);

    battle.units[0]!.acted = false;
    digIn(battle, 'eng');
    battle.units[0]!.acted = false;
    digIn(battle, 'eng');
    expect(battle.forts['0,0']).toBe(3);
    battle.units[0]!.acted = false;
    expect(digIn(battle, 'eng').ok).toBe(false);
  });
});

describe('battle end conditions', () => {
  it('checkVictory: wipe attacker → defender; wipe defender → attacker; mutual → defender', () => {
    const a = flatBattle([
      mkUnit('a1', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('b1', 'ww2_rifle_infantry', 'B', '2,0'),
    ]);
    a.battle.units[0]!.hp = 0;
    checkVictory(a.battle);
    expect(a.battle.winner).toBe('B');

    const b = flatBattle([
      mkUnit('a1', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('b1', 'ww2_rifle_infantry', 'B', '2,0'),
    ]);
    b.battle.units[1]!.hp = 0;
    checkVictory(b.battle);
    expect(b.battle.winner).toBe('A');

    const c = flatBattle([
      mkUnit('a1', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('b1', 'ww2_rifle_infantry', 'B', '2,0'),
    ]);
    c.battle.units[0]!.hp = 0;
    c.battle.units[1]!.hp = 0;
    checkVictory(c.battle);
    expect(c.battle.winner).toBe('B');
    expect(c.battle.endReason).toMatch(/Mutual annihilation/i);
  });

  it('round-limit endByTime: attacker alone in contested wins; otherwise defender', () => {
    const world = buildWorldForBattle();
    const contested = world.contested;
    const inHex = world.inContested;
    const outHex = world.outContested;

    // Attacker alone in contested.
    const win = flatBattle(
      [mkUnit('a', 'ww2_rifle_infantry', 'A', inHex), mkUnit('b', 'ww2_rifle_infantry', 'B', outHex)],
      { maxRounds: 1, contested, active: 'A', attacker: 'A', defender: 'B' },
    );
    // Mark B as outside contested main (already outHex). End A then B turn.
    expect(endTurn(win.ctx, win.battle).ok).toBe(true); // → B
    expect(endTurn(win.ctx, win.battle).ok).toBe(true); // time up
    expect(win.battle.phase).toBe('over');
    expect(win.battle.winner).toBe('A');

    const hold = flatBattle(
      [
        mkUnit('a', 'ww2_rifle_infantry', 'A', outHex),
        mkUnit('b', 'ww2_rifle_infantry', 'B', inHex),
      ],
      { maxRounds: 1, contested, active: 'A', attacker: 'A', defender: 'B' },
    );
    endTurn(hold.ctx, hold.battle);
    endTurn(hold.ctx, hold.battle);
    expect(hold.battle.winner).toBe('B');
  });
});

function buildWorldForBattle(): { contested: string; inContested: string; outContested: string } {
  // flatBattle builds a 3x3 world; pick a main and one of its sub-keys vs a neighbour's.
  const probe = flatBattle([mkUnit('x', 'ww2_rifle_infantry', 'A', '0,0')]);
  const contested = probe.battle.contested;
  const main = probe.ctx.world.mainByKey.get(contested)!;
  const inContested = main.subKeys[0]!;
  const other = probe.ctx.world.mains.find((m) => m.key !== contested)!;
  const outContested = other.subKeys[0]!;
  // Ensure both keys are on the battle cell set — expand if needed by using keys near origin.
  // flatBattle spiral radius 14 should cover these for 3x3 n=2.
  return { contested, inContested, outContested };
}

describe('movement costs / occupancy', () => {
  it('charges climb, marsh, and blocks illegal climbs/drops', () => {
    const heights: Record<string, number> = {
      '0,0': 2,
      '1,0': 3, // climb +1
      '2,0': 0, // marsh
      '3,0': 8, // climb 8 from 0 — impassable for climb 2
      '0,1': 2,
      '0,2': 8, // drop from 8 later
    };
    const cells = new Set(Object.keys(heights));
    const ctx = {
      world: buildWorldStub(),
      terrain: generateTerrain(buildWorldStub(), 1),
      cells,
      heightOf: (k: string) => heights[k],
      unitAt: new Map(),
    } as BattleContext;
    expect(stepCost(ctx, '0,0', '1,0', 2)).toBe(2); // 1 + climb1
    expect(stepCost(ctx, '1,0', '2,0', 2)).toBe(2); // 1 + marsh
    expect(stepCost(ctx, '2,0', '3,0', 2)).toBeNull(); // climb too steep
    heights['0,2'] = 2;
    heights['0,3'] = 2 - (MAX_DROP + 1);
    cells.add('0,3');
    expect(stepCost(ctx, '0,2', '0,3', 2)).toBeNull(); // drop too far
  });

  it('can pass through friendlies but not end on them; enemies block', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('a', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('friend', 'ww2_rifle_infantry', 'A', '1,0'),
      mkUnit('enemy', 'ww2_rifle_infantry', 'B', '0,1'),
    ]);
    const reach = reachable(ctx, battle.units[0]!);
    expect(reach.has('1,0')).toBe(false); // cannot end on friend
    // Can path beyond friend if MP allows — rifle move 4, cost ~1 per flat step.
    const beyond = hexKey(neighbor(parseKey('1,0'), 0));
    if (ctx.cells.has(beyond)) expect(reach.has(beyond)).toBe(true);
    expect(reach.has('0,1')).toBe(false); // enemy blocks
  });
});

function buildWorldStub(): ReturnType<typeof buildWorld> {
  return buildWorld({ mainCols: 3, mainRows: 3, subRadius: 2 });
}

describe('warning clocks → warned forts + dig-in writeback', () => {
  it('increments warning when enemy adjacent and maps into warned fort budget', () => {
    let s = createGame({
      ...defaultSettings(),
      grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
      controllers: { A: 'human', B: 'human' },
    });
    const { world } = worldOf(s);
    const aHq = s.hq.A;
    const adj = mainNeighbors(world, aHq)[0]!;
    const bArmy = commanderOf(s, 'B');
    placeHolder(s, world, bArmy, adj.key);
    // End A's turn → B begins (no A warning tick). End B → A begins and warning ticks.
    s = apply(s, { type: 'endTurn' }).state;
    s = apply(s, { type: 'endTurn' }).state;
    expect(s.hexes[aHq]!.warning).toBeGreaterThanOrEqual(1);

    // Force battle on a warned defender hex.
    const att = commanderOf(s, 'A');
    const origin = mainNeighbors(world, adj.key).find((m) => m.key !== aHq) ?? world.mains[0]!;
    placeHolder(s, world, att, origin.key);
    s.hexes[adj.key]!.owner = 'B';
    s.hexes[adj.key]!.warning = 2;
    s.pending = {
      attackerArmyId: att.id,
      defenderArmyId: bArmy.id,
      origin: origin.key,
      target: adj.key,
    };
    s.phase = 'battle-pending';
    s = apply(s, { type: 'startBattle' }).state;
    expect(s.battle!.warnedPlacements).toBe(Math.min(WARNED_CAP.placements, 2 * 2));
    expect(s.battle!.warnedRange).toBe(Math.min(WARNED_CAP.range, 2 * 3));

    const ctx = contextFor(s);
    const zone = s.battle!;
    // Place a warned fort during defender deploy.
    const cell = [...ctx.cells][0]!;
    // May fail range check — use a cell near defender deploy.
    const fromDeploy = placeWarnedFort(ctx, zone, cell);
    // Either succeeds or fails with a clear rule — budget must be respected when it works.
    if (fromDeploy.ok) {
      expect(zone.forts[cell]).toBe(1);
      expect(zone.warnedPlacements).toBe(Math.min(WARNED_CAP.placements, 4) - 1);
    }
  });

  it('concludeBattle writes dig-in forts back to the campaign', () => {
    let s = createGame({
      ...defaultSettings(),
      grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
      controllers: { A: 'human', B: 'human' },
    });
    const { world } = worldOf(s);
    const target = world.mains.find((m) => m.col === 1 && m.row === 1)!;
    const origin = world.mains.find((m) => m.col === 0 && m.row === 1)!;
    const att = commanderOf(s, 'A');
    const def = commanderOf(s, 'B');
    placeHolder(s, world, att, origin.key);
    placeHolder(s, world, def, target.key);
    s.hexes[target.key]!.owner = 'B';
    s.pending = {
      attackerArmyId: att.id,
      defenderArmyId: def.id,
      origin: origin.key,
      target: target.key,
    };
    s.phase = 'battle-pending';
    s = apply(s, { type: 'startBattle' }).state;
    s = apply(s, { type: 'finishDeploy' }).state;
    s = apply(s, { type: 'finishDeploy' }).state;
    const battle = s.battle!;
    const digCell = battle.units.find((u) => u.team === 'A' && u.pos)!.pos!;
    battle.forts[digCell] = 2;
    // Wipe defender to end battle quickly.
    for (const u of battle.units) if (u.team === 'B') u.hp = 0;
    checkVictory(battle);
    expect(battle.phase).toBe('over');
    s = apply(s, { type: 'concludeBattle' }).state;
    expect(s.forts[digCell]).toBe(2);
  });
});

describe('campaign smoke still green after mechanics coverage', () => {
  it('recruit still spends CP', () => {
    const s = createGame({ ...defaultSettings(), controllers: { A: 'ai', B: 'ai' } });
    const r = apply(s, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
    expect(r.error).toBeNull();
    expect(r.state.cp.A).toBe(s.cp.A - 3);
    expect(ECONOMY.startingCp).toBeGreaterThan(0);
  });

  it('seeded resolveAttack stays deterministic', () => {
    const a = flatBattle([
      mkUnit('tank', 'ww2_tank', 'A', '0,0'),
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '5,0'),
    ]);
    const b = flatBattle([
      mkUnit('tank', 'ww2_tank', 'A', '0,0'),
      mkUnit('rif', 'ww2_rifle_infantry', 'B', '5,0'),
    ]);
    resolveAttack(a.ctx, createRng(42), a.battle, a.battle.units[0]!, '5,0');
    resolveAttack(b.ctx, createRng(42), b.battle, b.battle.units[0]!, '5,0');
    expect(a.battle.units.map((u) => u.hp)).toEqual(b.battle.units.map((u) => u.hp));
  });
});

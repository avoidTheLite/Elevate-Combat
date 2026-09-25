import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import { ECONOMY, createGame, defaultSettings, income, worldOf } from './strategic.ts';
import { lineOfSight, arcClearance } from './los.ts';
import { holdsCaptureZone, contextFor, secureObjective, extractFromBattle } from './tactical.ts';
import { isHexRevealed } from './visibility.ts';

describe('review fixes', () => {
  it('grants turn-1 income to the first player at createGame', () => {
    const s = createGame(defaultSettings());
    expect(s.cp.A).toBe(ECONOMY.startingCp + income(s, 'A'));
    expect(s.cp.B).toBe(ECONOMY.startingCp);
  });

  it('blocks LOS through off-map hexes', () => {
    const heightOf = (k: string): number | undefined =>
      k === '0,0' || k === '3,0' ? 0 : undefined;
    const los = lineOfSight({ q: 0, r: 0 }, { q: 3, r: 0 }, heightOf);
    expect(los.status).toBe('blocked');
    const arc = arcClearance({ q: 0, r: 0 }, { q: 3, r: 0 }, heightOf);
    expect(arc.status).toBe('blocked');
  });

  it('treats fire-exposed enemies as hex-revealed for indirect fire', () => {
    let s = createGame({
      ...defaultSettings(),
      grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
      controllers: { A: 'ai', B: 'ai' },
    });
    // Force a pending battle by moving A onto B's HQ neighbour quickly is heavy —
    // synthesise a mini battle via startPending path is awkward; unit-level check:
    const { world } = worldOf(s);
    const target = world.mains.find((m) => m.col === 1 && m.row === 1)!;
    const origin = world.mains.find((m) => m.col === 0 && m.row === 1)!;
    const att = s.armies.find((a) => a.team === 'A')!;
    const def = s.armies.find((a) => a.team === 'B')!;
    att.at = origin.key;
    def.at = target.key;
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
    const ctx = contextFor(s);
    const enemy = battle.units.find((u) => u.team === 'B' && u.pos)!;
    enemy.exposed = true;
    // Even if no friendly canSee that hex, exposure reveals it for HE.
    expect(isHexRevealed(ctx, battle, 'A', enemy.pos!)).toBe(true);
  });
});

describe('capture point objective', () => {
  it('SECURE wins when the attacker alone holds the capture zone', () => {
    let s = createGame({
      ...defaultSettings(),
      grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
      controllers: { A: 'human', B: 'human' },
    });
    const { world } = worldOf(s);
    const target = world.mains.find((m) => m.col === 1 && m.row === 1)!;
    const origin = world.mains.find((m) => m.col === 0 && m.row === 1)!;
    const att = s.armies.find((a) => a.team === 'A')!;
    const def = s.armies.find((a) => a.team === 'B')!;
    att.at = origin.key;
    def.at = target.key;
    s.hexes[target.key]!.owner = 'B';
    s.pending = {
      attackerArmyId: att.id,
      defenderArmyId: def.id,
      origin: origin.key,
      target: target.key,
    };
    s.phase = 'battle-pending';
    s = apply(s, { type: 'startBattle' }).state;
    s = apply(s, { type: 'finishDeploy' }).state; // defender
    s = apply(s, { type: 'finishDeploy' }).state; // attacker
    const battle = s.battle!;
    const ctx = contextFor(s);
    const cap = battle.objective.captureKey!;
    // Clear defenders from the zone and park an attacker on the point.
    for (const u of battle.units) {
      if (u.team === 'B' && u.pos) u.pos = null;
    }
    const aUnit = battle.units.find((u) => u.team === 'A')!;
    aUnit.pos = cap;
    expect(holdsCaptureZone(ctx, battle, 'A')).toBe(true);
    const res = secureObjective(ctx, battle);
    expect(res.ok).toBe(true);
    expect(battle.winner).toBe('A');
    expect(battle.endReason).toMatch(/secured/i);
  });

  it('EXTRACT returns the army to origin after capture', () => {
    let s = createGame({
      ...defaultSettings(),
      grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
      controllers: { A: 'human', B: 'human' },
    });
    const { world } = worldOf(s);
    const target = world.mains.find((m) => m.col === 1 && m.row === 1)!;
    const origin = world.mains.find((m) => m.col === 0 && m.row === 1)!;
    const att = s.armies.find((a) => a.team === 'A')!;
    const def = s.armies.find((a) => a.team === 'B')!;
    att.at = origin.key;
    def.at = target.key;
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
    const ctx = contextFor(s);
    for (const u of battle.units) {
      if (u.team === 'B' && u.pos) u.pos = null;
    }
    battle.units.find((u) => u.team === 'A')!.pos = battle.objective.captureKey!;
    expect(extractFromBattle(ctx, battle).ok).toBe(true);
    s = apply(s, { type: 'concludeBattle' }).state;
    const army = s.armies.find((a) => a.id === att.id)!;
    expect(army.at).toBe(origin.key);
    expect(s.hexes[target.key]!.owner).toBe('A');
  });
});

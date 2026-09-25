// V1.0 command layer: commanders on the sub-grid, garrisons, engagement,
// strategic LOS fog and unit transfers.

import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import {
  canEngage,
  canTransfer,
  commanderReach,
  engageOrigin,
  transferTargets,
} from './command.ts';
import { mainDistance, mainNeighbors } from './grid.ts';
import { DIRECTIONS, hexAdd, hexDistance, hexKey, hexScale, neighbors } from './hex.ts';
import { aiStep, isAiTurn } from './runner.ts';
import {
  COMMAND,
  ECONOMY,
  centerKey,
  createGame,
  defaultSettings,
  garrisonOf,
  holderSees,
  makeUnit,
  setHolderPos,
  visibleArmies,
  worldOf,
} from './strategic.ts';
import { checkVictory } from './tactical.ts';
import { commanderOf } from './testBattle.ts';
import type { Army, GameSettings, GameState, Team } from './types.ts';

function game(over: Partial<GameSettings> = {}): GameState {
  return createGame({
    ...defaultSettings(),
    grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human', B: 'human' },
    fog: false,
    ...over,
  });
}

function mainAt(s: GameState, col: number, row: number): string {
  return worldOf(s).world.mains.find((m) => m.col === col && m.row === row)!.key;
}

function put(s: GameState, army: Army, key: string): void {
  setHolderPos(worldOf(s).world, army, key);
}

/** Cell `k` steps from a main hex centre in direction `dir`. */
function fromCentre(s: GameState, main: string, dir: number, k: number): string {
  const c = worldOf(s).world.mainByKey.get(main)!.center;
  return hexKey(hexAdd(c, hexScale(DIRECTIONS[dir]!, k)));
}

function addCommander(s: GameState, team: Team, pos: string, units = 1): Army {
  const army: Army = {
    id: `${team}test${s.nextId++}`,
    team,
    kind: 'commander',
    pos,
    at: '',
    units: [],
    movesLeft: COMMAND.commandMove(s.settings.grid.subRadius),
  };
  for (let i = 0; i < units; i++) army.units.push(makeUnit(s, team, 'ww2_rifle_infantry'));
  put(s, army, pos);
  s.armies.push(army);
  return army;
}

/** Engage, open the battle, wipe the defender (optionally leaving survivors) and conclude. */
function winBattle(state: GameState, attId: string, defId: string, survivors = 0): GameState {
  let s = apply(state, { type: 'engage', armyId: attId, targetId: defId }).state;
  expect(s.phase).toBe('battle-pending');
  s = apply(s, { type: 'startBattle' }).state;
  s = apply(s, { type: 'finishDeploy' }).state;
  s = apply(s, { type: 'finishDeploy' }).state;
  const b = s.battle!;
  for (const u of b.units.filter((x) => x.team === b.defender).slice(survivors)) u.hp = 0;
  if (survivors === 0) checkVictory(b);
  else {
    b.winner = b.attacker;
    b.phase = 'over';
    b.endReason = 'test';
  }
  expect(b.phase).toBe('over');
  return apply(s, { type: 'concludeBattle' }).state;
}

describe('holders at game start', () => {
  it('each HQ has an empty garrison on its centre and a commander next to it', () => {
    const s = game();
    const { world } = worldOf(s);
    for (const team of ['A', 'B'] as Team[]) {
      const g = garrisonOf(s, team)!;
      expect(g.kind).toBe('garrison');
      expect(g.building).toBe('hq');
      expect(g.units).toHaveLength(0);
      expect(g.pos).toBe(centerKey(world, s.hq[team]));
      const c = commanderOf(s, team);
      expect(c.units.length).toBeGreaterThan(0);
      expect(hexDistance(world.subByKey.get(c.pos)!.hex, world.subByKey.get(g.pos)!.hex)).toBe(1);
      for (const h of [g, c]) expect(world.subByKey.get(h.pos)!.main).toBe(h.at);
    }
    expect(commanderOf(s, 'A').movesLeft).toBe(COMMAND.commandMove(2));
  });
});

describe('commander movement', () => {
  it('reach is bounded by movesLeft sub-steps and spends steps on the move', () => {
    const s = game();
    const c = commanderOf(s, 'A');
    const reach = commanderReach(s, c);
    expect(Math.max(...reach.values())).toBe(c.movesLeft);
    const far = [...reach].find(([, d]) => d === c.movesLeft)![0];
    const r = apply(s, { type: 'moveCommander', armyId: c.id, dest: far });
    expect(r.error).toBeNull();
    const moved = r.state.armies.find((a) => a.id === c.id)!;
    expect(moved.pos).toBe(far);
    expect(moved.movesLeft).toBe(0);
    expect(moved.at).toBe(worldOf(s).world.subByKey.get(far)!.main);
  });

  it('rejects cells beyond reach, occupied cells and off-map cells', () => {
    const s = game();
    const c = commanderOf(s, 'A');
    const { world } = worldOf(s);
    const reach = commanderReach(s, c);
    const beyond = world.subs.find((x) => !reach.has(x.key))!.key;
    expect(apply(s, { type: 'moveCommander', armyId: c.id, dest: beyond }).error).toMatch(/reach/);
    const g = garrisonOf(s, 'A')!;
    expect(apply(s, { type: 'moveCommander', armyId: c.id, dest: g.pos }).error).toMatch(
      /occupied/,
    );
    expect(apply(s, { type: 'moveCommander', armyId: c.id, dest: '999,999' }).error).toMatch(
      /Off map/,
    );
  });

  it('other holders block the path', () => {
    const s = game();
    const mid = mainAt(s, 2, 1);
    const c = addCommander(s, 'A', centerKey(worldOf(s).world, mid));
    // Box the commander in with friendly and enemy holders.
    neighbors(worldOf(s).world.subByKey.get(c.pos)!.hex).forEach((h, i) =>
      addCommander(s, i % 2 ? 'A' : 'B', hexKey(h)),
    );
    expect([...commanderReach(s, c).keys()]).toEqual([c.pos]);
  });

  it('garrisons cannot move', () => {
    const s = game();
    const g = garrisonOf(s, 'A')!;
    const dest = hexKey(neighbors(worldOf(s).world.subByKey.get(g.pos)!.hex)[3]!);
    expect(apply(s, { type: 'moveCommander', armyId: g.id, dest }).error).toMatch(/Garrison/);
  });

  it('ending in an unheld main hex captures it; an enemy holder there prevents capture', () => {
    const s = game();
    const mid = mainAt(s, 2, 1);
    const c = addCommander(s, 'A', fromCentre(s, mid, 3, 2));
    s.hexes[c.at]!.owner = 'A';
    let r = apply(s, {
      type: 'moveCommander',
      armyId: c.id,
      dest: centerKey(worldOf(s).world, mid),
    });
    expect(r.error).toBeNull();
    expect(r.state.hexes[mid]!.owner).toBe('A');

    const s2 = game();
    const c2 = addCommander(s2, 'A', fromCentre(s2, mid, 3, 2));
    addCommander(s2, 'B', fromCentre(s2, mid, 0, 2));
    r = apply(s2, {
      type: 'moveCommander',
      armyId: c2.id,
      dest: centerKey(worldOf(s2).world, mid),
    });
    expect(r.error).toBeNull();
    expect(r.state.hexes[mid]!.owner).toBeNull();
  });

  it('the V0.9 moveArmy order steps into an adjacent main hex', () => {
    const s = game();
    const c = commanderOf(s, 'A');
    const next = mainAt(s, 1, 1);
    const r = apply(s, { type: 'moveArmy', armyId: c.id, dest: next });
    expect(r.error).toBeNull();
    expect(r.state.armies.find((a) => a.id === c.id)!.at).toBe(next);
  });
});

describe('engagement', () => {
  it('needs the target within engageRange sub-hexes', () => {
    const s = game();
    const n = s.settings.grid.subRadius;
    const mid = mainAt(s, 2, 1);
    const att = addCommander(s, 'A', centerKey(worldOf(s).world, mid));
    const far = addCommander(s, 'B', fromCentre(s, mid, 0, n + 1));
    expect(canEngage(s, att, far).ok).toBe(false);
    expect(apply(s, { type: 'engage', armyId: att.id, targetId: far.id }).error).toMatch(/range/);
    const near = addCommander(s, 'B', fromCentre(s, mid, 3, n));
    const r = apply(s, { type: 'engage', armyId: att.id, targetId: near.id });
    expect(r.error).toBeNull();
    expect(r.state.phase).toBe('battle-pending');
    const p = r.state.pending!;
    expect(p.target).toBe(near.at);
    const { world } = worldOf(s);
    expect(mainDistance(world, p.origin, p.target)).toBe(1);
    if (att.at !== near.at) expect(p.origin).toBe(att.at);
  });

  it('same-main engagements originate from the neighbour hex nearest the attacker', () => {
    const s = game();
    const mid = mainAt(s, 2, 1);
    const att = addCommander(s, 'A', fromCentre(s, mid, 3, 2));
    const def = addCommander(s, 'B', centerKey(worldOf(s).world, mid));
    const { world } = worldOf(s);
    const origin = engageOrigin(world, att, def);
    const west = mainNeighbors(world, mid).sort(
      (a, b) =>
        hexDistance(a.center, world.subByKey.get(att.pos)!.hex) -
        hexDistance(b.center, world.subByKey.get(att.pos)!.hex),
    )[0]!;
    expect(origin).toBe(west.key);
  });

  it('costs attack CP and refuses friendly or empty targets', () => {
    const s = game();
    const mid = mainAt(s, 2, 1);
    const att = addCommander(s, 'A', centerKey(worldOf(s).world, mid));
    const friend = addCommander(s, 'A', fromCentre(s, mid, 0, 1));
    expect(canEngage(s, att, friend).ok).toBe(false);
    const def = addCommander(s, 'B', fromCentre(s, mid, 3, 1));
    s.cp.A = 0;
    expect(canEngage(s, att, def).ok).toBe(false);
  });

  it('a beaten garrison is emptied but persists; the HQ falls', () => {
    let s = game();
    const hqB = s.hq.B;
    s.armies = s.armies.filter((a) => !(a.team === 'B' && a.kind === 'commander'));
    const g = garrisonOf(s, 'B')!;
    g.units.push(makeUnit(s, 'B', 'ww2_rifle_infantry'), makeUnit(s, 'B', 'ww2_machine_gun'));
    const att = addCommander(s, 'A', fromCentre(s, hqB, 3, 2), 3);
    const pending = apply(s, { type: 'engage', armyId: att.id, targetId: g.id }).state.pending!;
    expect(pending.target).toBe(hqB);
    expect(mainDistance(worldOf(s).world, pending.origin, hqB)).toBe(1);
    s = winBattle(s, att.id, g.id);
    const after = garrisonOf(s, 'B')!;
    expect(after).toBeDefined();
    expect(after.units).toHaveLength(0);
    expect(after.pos).toBe(g.pos);
    expect(s.hexes[hqB]!.owner).toBe('A');
    expect(s.winner).toBe('A');
    const a = s.armies.find((x) => x.id === att.id)!;
    expect(a.at).toBe(hqB);
  });

  it('a beaten commander falls back to a free cell on adjacent friendly ground', () => {
    let s = game();
    const target = mainAt(s, 3, 1);
    s.hexes[target]!.owner = 'B';
    const def = commanderOf(s, 'B');
    put(s, def, centerKey(worldOf(s).world, target));
    const att = addCommander(s, 'A', fromCentre(s, target, 3, 2), 4);
    s = winBattle(s, att.id, def.id, 1); // one defender survives, beaten
    const { world } = worldOf(s);
    const d = s.armies.find((x) => x.id === def.id)!;
    expect(d.units).toHaveLength(1);
    expect(mainDistance(world, d.at, target)).toBe(1);
    expect(s.hexes[d.at]!.owner).toBe('B');
    expect(world.subByKey.get(d.pos)!.main).toBe(d.at);
    expect(s.hexes[target]!.owner).toBe('A');
    const a = s.armies.find((x) => x.id === att.id)!;
    expect(a.at).toBe(target);
    expect(new Set(s.armies.map((x) => x.pos)).size).toBe(s.armies.length);
  });
});

describe('strategic line-of-sight fog', () => {
  function losGame(): GameState {
    const s = game({ fog: true, grid: { mainCols: 7, mainRows: 5, subRadius: 4 } });
    for (const k of Object.keys(s.hexes)) s.hexes[k]!.owner = null; // no territory vision
    return s;
  }

  it('sees enemies in range with clear LOS; a ridge blocks sight; fog:false shows all', () => {
    const s = losGame();
    const { world, terrain } = worldOf(s);
    const eye = commanderOf(s, 'A');
    const foe = commanderOf(s, 'B');
    s.armies = [eye, foe];
    const range = COMMAND.sightRange(world.config.subRadius);
    // Find a blocked pair (a ridge between) and a clear pair within sight range.
    let blocked: [string, string] | null = null;
    let clear: [string, string] | null = null;
    for (const a of world.subs) {
      if (blocked && clear) break;
      for (const b of world.subs) {
        const d = hexDistance(a.hex, b.hex);
        if (d < 3 || d > range) continue;
        put(s, eye, a.key);
        put(s, foe, b.key);
        const sees = holderSees(world, terrain, eye, foe);
        if (!sees && !blocked) blocked = [a.key, b.key];
        if (sees && !clear) clear = [a.key, b.key];
        if (blocked && clear) break;
      }
    }
    expect(blocked).not.toBeNull();
    expect(clear).not.toBeNull();
    put(s, eye, blocked![0]);
    put(s, foe, blocked![1]);
    expect(visibleArmies(s, 'A').map((a) => a.id)).toEqual([eye.id]);
    s.settings.fog = false;
    expect(visibleArmies(s, 'A').map((a) => a.id)).toContain(foe.id);
    s.settings.fog = true;
    put(s, eye, clear![0]);
    put(s, foe, clear![1]);
    expect(visibleArmies(s, 'A').map((a) => a.id)).toContain(foe.id);
  });

  it('enemies beyond sight range stay hidden unless next to owned territory', () => {
    const s = losGame();
    const eye = commanderOf(s, 'A');
    const foe = commanderOf(s, 'B');
    s.armies = [eye, foe];
    const { world } = worldOf(s);
    expect(
      hexDistance(world.subByKey.get(eye.pos)!.hex, world.subByKey.get(foe.pos)!.hex),
    ).toBeGreaterThan(COMMAND.sightRange(4));
    expect(visibleArmies(s, 'A').map((a) => a.id)).toEqual([eye.id]);
    s.hexes[mainNeighbors(world, foe.at)[0]!.key]!.owner = 'A';
    expect(visibleArmies(s, 'A').map((a) => a.id)).toContain(foe.id);
  });
});

describe('garrisons and recruiting', () => {
  it('recruits join the HQ garrison and never spawn a commander', () => {
    let s = game();
    const before = s.armies.length;
    s = apply(s, { type: 'recruit', typeId: 'ww2_rifle_infantry' }).state;
    s = apply(s, { type: 'recruit', typeId: 'ww2_machine_gun' }).state;
    expect(s.armies).toHaveLength(before);
    expect(garrisonOf(s, 'A')!.units.map((u) => u.typeId)).toEqual([
      'ww2_rifle_infantry',
      'ww2_machine_gun',
    ]);
  });

  it('the garrison cap stops recruiting', () => {
    const s = game();
    const g = garrisonOf(s, 'A')!;
    while (g.units.length < COMMAND.garrisonCap)
      g.units.push(makeUnit(s, 'A', 'ww2_rifle_infantry'));
    s.cp.A = 100;
    const r = apply(s, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
    expect(r.error).toMatch(/full/);
  });

  for (const garrisoned of [true, false]) {
    it(`elimination counts garrison units (garrison ${garrisoned ? 'manned' : 'empty'})`, () => {
      let s = game();
      for (const k of Object.keys(s.hexes)) if (k !== s.hq.B) s.hexes[k]!.owner = null;
      const mid = mainAt(s, 2, 1);
      const def = commanderOf(s, 'B');
      put(s, def, centerKey(worldOf(s).world, mid));
      if (garrisoned) garrisonOf(s, 'B')!.units.push(makeUnit(s, 'B', 'ww2_rifle_infantry'));
      s.cp.B = 0;
      const att = addCommander(s, 'A', fromCentre(s, mid, 3, 2), 4);
      s = winBattle(s, att.id, def.id);
      expect(s.armies.find((a) => a.id === def.id)).toBeUndefined();
      expect(garrisonOf(s, 'B')).toBeDefined(); // never filtered out, even when empty
      expect(s.winner).toBe(garrisoned ? null : 'A');
    });
  }
});

describe('transfers', () => {
  it('holders must be within the radius AND in the same main hex (each check can be switched off)', () => {
    const s = game();
    const n = s.settings.grid.subRadius;
    const mid = mainAt(s, 2, 1);
    const east = mainAt(s, 3, 1);
    const { world } = worldOf(s);
    // Across a border: 1 cell apart, different main hexes.
    const edge = fromCentre(s, mid, 0, n);
    const across = hexKey(neighbors(world.subByKey.get(edge)!.hex)[0]!);
    expect(world.subByKey.get(across)!.main).toBe(east);
    const a = addCommander(s, 'A', edge);
    const b = addCommander(s, 'A', across);
    expect(canTransfer(s, a, b).ok).toBe(false);
    s.settings.transferRule = { sameMainHex: false };
    expect(canTransfer(s, a, b).ok).toBe(true);
    // Same main hex, 2n apart: radius fails unless switched off.
    s.settings.transferRule = undefined;
    const c = addCommander(s, 'A', fromCentre(s, mid, 3, n));
    expect(canTransfer(s, a, c).ok).toBe(false);
    s.settings.transferRule = { radius: null };
    expect(canTransfer(s, a, c).ok).toBe(true);
    s.settings.transferRule = { radius: null, sameMainHex: false };
    expect(canTransfer(s, b, c).ok).toBe(true);
  });

  it('only the active team, in the strategic phase, within caps', () => {
    const s = game();
    const g = garrisonOf(s, 'A')!;
    const c = commanderOf(s, 'A');
    g.units.push(makeUnit(s, 'A', 'ww2_rifle_infantry'));
    expect(canTransfer(s, g, c).ok).toBe(true);
    expect(canTransfer(s, g, c, ECONOMY.armyCap).ok).toBe(false);
    expect(transferTargets(s, g.id).map((x) => x.id)).toEqual([c.id]);
    expect(canTransfer(s, garrisonOf(s, 'B')!, commanderOf(s, 'B')).ok).toBe(false);
    expect(canTransfer(s, g, commanderOf(s, 'B')).ok).toBe(false);
    s.phase = 'battle-pending';
    expect(canTransfer(s, g, c).ok).toBe(false);
  });

  it('transferUnits moves units, takes min movesLeft and removes emptied commanders', () => {
    let s = game();
    const g = garrisonOf(s, 'A')!;
    const c = commanderOf(s, 'A');
    g.units.push(makeUnit(s, 'A', 'ww2_rifle_infantry'));
    const uid = g.units[0]!.id;
    let r = apply(s, { type: 'transferUnits', fromId: g.id, toId: c.id, unitIds: [uid] });
    expect(r.error).toBeNull();
    s = r.state;
    const c2 = s.armies.find((a) => a.id === c.id)!;
    expect(c2.units.map((u) => u.id)).toContain(uid);
    expect(c2.movesLeft).toBe(0); // garrison units have no moves this turn
    expect(garrisonOf(s, 'A')!.units).toHaveLength(0); // garrison persists empty
    // Empty the commander into the garrison: the commander disappears.
    r = apply(s, {
      type: 'transferUnits',
      fromId: c.id,
      toId: g.id,
      unitIds: c2.units.map((u) => u.id),
    });
    expect(r.error).toBeNull();
    expect(r.state.armies.find((a) => a.id === c.id)).toBeUndefined();
    expect(garrisonOf(r.state, 'A')!.units).toHaveLength(c2.units.length);
    // Garrison cap applies to the receiver.
    const full = garrisonOf(r.state, 'A')!;
    expect(full.units.length).toBeLessThanOrEqual(COMMAND.garrisonCap);
  });

  it('rejects unknown or duplicate unit ids', () => {
    const s = game();
    const g = garrisonOf(s, 'A')!;
    const c = commanderOf(s, 'A');
    const uid = c.units[0]!.id;
    expect(
      apply(s, { type: 'transferUnits', fromId: g.id, toId: c.id, unitIds: ['nope'] }).error,
    ).toBeTruthy();
    expect(
      apply(s, { type: 'transferUnits', fromId: c.id, toId: g.id, unitIds: [uid, uid] }).error,
    ).toBeTruthy();
  });
});

describe('formCommander', () => {
  it('splits garrison units into a new commander next to it with 0 moves', () => {
    let s = game();
    const g = garrisonOf(s, 'A')!;
    for (let i = 0; i < 3; i++) g.units.push(makeUnit(s, 'A', 'ww2_rifle_infantry'));
    const ids = g.units.slice(0, 2).map((u) => u.id);
    const r = apply(s, { type: 'formCommander', fromId: g.id, unitIds: ids });
    expect(r.error).toBeNull();
    s = r.state;
    const fresh = s.armies[s.armies.length - 1]!;
    const { world } = worldOf(s);
    expect(fresh.kind).toBe('commander');
    expect(fresh.units.map((u) => u.id)).toEqual(ids);
    expect(fresh.movesLeft).toBe(0);
    expect(fresh.at).toBe(g.at);
    expect(hexDistance(world.subByKey.get(fresh.pos)!.hex, world.subByKey.get(g.pos)!.hex)).toBe(1);
    expect(garrisonOf(s, 'A')!.units).toHaveLength(1);
  });

  it('a split commander keeps its moves; it cannot give away every unit', () => {
    const s = game();
    const c = commanderOf(s, 'A');
    const ids = c.units.map((u) => u.id);
    expect(apply(s, { type: 'formCommander', fromId: c.id, unitIds: ids }).error).toBeTruthy();
    const r = apply(s, { type: 'formCommander', fromId: c.id, unitIds: ids.slice(0, 2) });
    expect(r.error).toBeNull();
    const fresh = r.state.armies[r.state.armies.length - 1]!;
    expect(fresh.movesLeft).toBe(c.movesLeft);
  });

  it('respects the commander cap and fails when the main hex has no free cell', () => {
    const s = game();
    const g = garrisonOf(s, 'A')!;
    while (g.units.length < ECONOMY.armyCap + 1)
      g.units.push(makeUnit(s, 'A', 'ww2_rifle_infantry'));
    expect(
      apply(s, { type: 'formCommander', fromId: g.id, unitIds: g.units.map((u) => u.id) }).error,
    ).toMatch(/at most/);
    const { world } = worldOf(s);
    const taken = new Set(s.armies.map((a) => a.pos));
    for (const k of world.mainByKey.get(g.at)!.subKeys) if (!taken.has(k)) addCommander(s, 'A', k);
    expect(
      apply(s, { type: 'formCommander', fromId: g.id, unitIds: [g.units[0]!.id] }).error,
    ).toMatch(/free cell/);
  });
});

describe('AI on the command layer', () => {
  it('plays a campaign to the end keeping holder invariants', { timeout: 60000 }, () => {
    let s = createGame({
      ...defaultSettings(),
      era: 'medieval',
      seed: 7,
      grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
      controllers: { A: 'ai', B: 'ai' },
    });
    const { world } = worldOf(s);
    let formed = 0;
    for (let i = 0; i < 20000 && isAiTurn(s); i++) {
      const action = aiStep(s);
      const r = apply(s, action);
      expect(r.error).toBeNull();
      if (action.type === 'formCommander') formed++;
      s = r.state;
      expect(new Set(s.armies.map((a) => a.pos)).size).toBe(s.armies.length);
      for (const a of s.armies) expect(world.subByKey.get(a.pos)!.main).toBe(a.at);
      expect(s.cp.A).toBeGreaterThanOrEqual(0);
      expect(s.cp.B).toBeGreaterThanOrEqual(0);
    }
    expect(s.phase).toBe('over');
    expect(formed).toBeGreaterThan(0);
  });
});

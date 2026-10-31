// V1.0 command layer: commanders on the sub-grid, garrisons, engagement,
// strategic LOS fog and unit transfers.

import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import {
  canEngage,
  canMoveCommander,
  canTransfer,
  commanderReach,
  engageOrigin,
  transferTargets,
  transferUnits,
  formCommander,
  moveCommander,
  moveArmy,
  engage,
  holderCapacity,
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
import { unitType } from './units.ts';
import {
  campaignBuildingData,
  constructCampaignNodeRequest,
  createCampaignInfrastructure,
  refreshCampaignNodeSnapshot,
} from './foundation/campaignNodes.ts';
import { quoteCampaignRecruitment } from './foundation/campaignRecruitment.ts';
import { beginFoundationCapture } from './foundation/capture.ts';
import { createFoundationPlaytestConfiguration } from './foundation/playtestProfile.ts';

function game(over: Partial<GameSettings> = {}): GameState {
  return createGame({
    ...defaultSettings(),
    grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
    commanderTrainingCp: 11,
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

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: holders at game start', () => {
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

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: commander movement', () => {
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

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: engagement', () => {
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

describe('GAMES-ELEVATE-WORLD-UC-002: strategic line-of-sight fog', () => {
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

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: garrisons and recruiting', () => {
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

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: transfers', () => {
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

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: temporary garrison retrieval', () => {
  function stationed(s: GameState, pos: string): Army {
    const holder: Army = {
      id: `stationed-${s.nextId++}`,
      team: 'A',
      kind: 'garrison',
      building: 'temporary',
      at: '',
      pos,
      movesLeft: 0,
      units: [makeUnit(s, 'A', 'ww2_rifle_infantry')],
    };
    put(s, holder, pos);
    s.armies.push(holder);
    return holder;
  }

  it('retrieves into an existing nearby friendly commander and removes the emptied tile holder', () => {
    const s = game();
    const commander = commanderOf(s, 'A');
    const temp = stationed(s, fromCentre(s, s.hq.A, 3, 1));
    const unit = temp.units[0];
    expect(canTransfer(s, temp, commander)).toMatchObject({ ok: true });
    expect(transferUnits(s, temp.id, commander.id, [unit.id])).toMatchObject({ ok: true });
    expect(commander.units).toContainEqual(unit);
    expect(commander.movesLeft).toBe(0);
    expect(s.armies.some((a) => a.id === temp.id)).toBe(false);
    expect(garrisonOf(s, 'A')).toBeDefined();
    expect(transferTargets(s, temp.id)).toEqual([]);
  });

  it('uses the normal garrison interaction distance and same-MainHex restrictions', () => {
    const s = game();
    const commander = commanderOf(s, 'A');
    const temp = stationed(s, fromCentre(s, s.hq.A, 3, 1));
    const { world } = worldOf(s);
    const far = world.mainByKey
      .get(temp.at)!
      .subKeys.find(
        (key) =>
          hexDistance(world.subByKey.get(key)!.hex, world.subByKey.get(temp.pos)!.hex) >
          COMMAND.transferRule(s.settings.grid.subRadius).radius!,
      )!;
    put(s, commander, far);
    const before = JSON.stringify(s);
    expect(canTransfer(s, temp, commander)).toMatchObject({
      ok: false,
      error: expect.stringContaining('within'),
    });
    expect(transferUnits(s, temp.id, commander.id, [temp.units[0].id]).ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
    s.settings.transferRule = { radius: null, sameMainHex: true };
    expect(canTransfer(s, temp, commander).ok).toBe(true);
    put(s, commander, centerKey(world, mainAt(s, 2, 1)));
    expect(canTransfer(s, temp, commander)).toMatchObject({
      ok: false,
      error: expect.stringContaining('share a main hex'),
    });
  });

  it('permits only friendly commander retrieval and preserves commander capacity limits', () => {
    const s = game();
    const commander = commanderOf(s, 'A');
    const temp = stationed(s, fromCentre(s, s.hq.A, 3, 1));
    const hq = garrisonOf(s, 'A')!;
    expect(canTransfer(s, temp, hq)).toMatchObject({
      ok: false,
      error: expect.stringContaining('commander'),
    });
    expect(canTransfer(s, temp, commanderOf(s, 'B'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('enemy'),
    });
    while (commander.units.length < ECONOMY.armyCap)
      commander.units.push(makeUnit(s, 'A', 'ww2_rifle_infantry'));
    expect(canTransfer(s, temp, commander)).toMatchObject({
      ok: false,
      error: `Receiver would exceed ${ECONOMY.armyCap} units`,
    });
  });

  it('enforces capacity one and never creates stationing through ordinary transfers', () => {
    const s = game();
    const commander = commanderOf(s, 'A');
    const temp = stationed(s, fromCentre(s, s.hq.A, 3, 1));
    expect(canTransfer(s, commander, temp)).toMatchObject({
      ok: false,
      error: 'Receiver would exceed 1 units',
    });
    temp.units = [];
    const before = JSON.stringify(s);
    expect(transferUnits(s, commander.id, temp.id, [commander.units[0].id])).toMatchObject({
      ok: false,
      error: expect.stringContaining('deliberate post-battle stationing'),
    });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('cannot form a freestanding commander, move or initiate combat from a stationed unit', () => {
    const s = game();
    const temp = stationed(s, fromCentre(s, s.hq.A, 3, 1));
    const before = JSON.stringify(s);
    expect(formCommander(s, temp.id, [temp.units[0].id])).toMatchObject({
      ok: false,
      error: expect.stringContaining('commander must retrieve'),
    });
    expect(moveCommander(s, temp.id, fromCentre(s, s.hq.A, 3, 2)).ok).toBe(false);
    expect(engage(s, temp.id, commanderOf(s, 'B').id).ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('blocks direct ordinary command APIs while an independent capture choice is pending', () => {
    const s = game();
    const commander = commanderOf(s, 'A');
    const hq = garrisonOf(s, 'A')!;
    const { world } = worldOf(s);
    const config = createFoundationPlaytestConfiguration(7, 3);
    const base = createCampaignInfrastructure(s, world, config.nodes);
    const node = base.capture.nodes.find((n) => n.owner === 'B')!;
    const pending = beginFoundationCapture(
      base.capture,
      { requestId: 'pending-command-test', expectedVersion: 0 },
      {
        snapshotVersion: 0,
        ownerTurn: { team: 'A', id: base.ownerTurns.A },
        costs: config.nodes.captureCosts,
        event: { kind: 'manual-battle-end', battleId: 'frozen-test-battle' },
        candidates: [
          {
            nodeId: node.id,
            liveGarrisonUnitIds: [],
            liveCenterOccupants: [{ unitId: commander.units[0].id, team: 'A' }],
            liveHostileMainHexUnitIds: [],
            commanders: [],
          },
        ],
      },
    );
    if (!pending.ok) throw new Error(pending.reason);
    s.infrastructure = { ...base, capture: pending.state };
    const dest = fromCentre(s, s.hq.A, 3, 2);
    const before = JSON.stringify(s);
    for (const result of [
      canMoveCommander(s, commander, dest),
      moveCommander(s, commander.id, dest),
      moveArmy(s, commander.id, mainAt(s, 1, 1)),
      canEngage(s, commander, commanderOf(s, 'B')),
      engage(s, commander.id, commanderOf(s, 'B').id),
      canTransfer(s, commander, hq),
      transferUnits(s, commander.id, hq.id, [commander.units[0].id]),
      formCommander(s, commander.id, [commander.units[0].id]),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining('pending foundation event'),
      });
    }
    expect([...commanderReach(s, commander)]).toEqual([[commander.pos, 0]]);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: node garrison capacity', () => {
  it('combines fractional housing exactly before the shared whole-unit boundary', () => {
    const base = createFoundationPlaytestConfiguration(7, 3);
    const effects = { ...base.effects };
    for (const [id, housing] of [
      ['generic', 0.7],
      ['barracks', 0.2],
      ['workshop', 0.1],
    ] as const) {
      effects[id] = { ...effects[id], 1: { ...effects[id][1]!, housing } };
    }
    let s = game({ infrastructure: { ...base, effects } });
    s.cp.A = 100;
    refreshCampaignNodeSnapshot(s);
    const site = s.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'A')!;
    const engineer = commanderOf(s, 'A').units.find((unit) => unitType(unit.typeId).engineer)!;
    for (const [index, definitionId] of ['barracks', 'workshop'].entries()) {
      const built = apply(s, {
        type: 'nodeWork',
        request: constructCampaignNodeRequest(s, {
          kind: 'build',
          nodeId: site.nodeId,
          definitionId,
          subHex: site.annexSubHexes[index],
          tier: 1,
          engineerUnitId: index === 0 ? null : engineer.id,
        }),
      });
      expect(built.error).toBeNull();
      s = built.state;
    }
    const hq = garrisonOf(s, 'A')!;
    const commander = commanderOf(s, 'A');
    expect(0.7 + 0.2 + 0.1).toBeLessThan(1); // The previous number-only quote rejected this slot.
    expect(holderCapacity(s, hq)).toBe(1);
    expect(quoteCampaignRecruitment(s, 'ww2_rifle_infantry', site.nodeId)).toMatchObject({
      housing: 1,
      allowed: true,
    });
    expect(canTransfer(s, commander, hq).ok).toBe(true);
    expect(transferUnits(s, commander.id, hq.id, [commander.units[0].id]).ok).toBe(true);
    expect(canTransfer(s, commander, hq)).toMatchObject({
      ok: false,
      error: 'Receiver would exceed 1 units',
    });
  });

  it('uses identical configured HQ housing for recruitment, transfers and presentation', () => {
    let s = game({ infrastructure: createFoundationPlaytestConfiguration(7, 3) });
    const site = s.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'A')!;
    expect(holderCapacity(s, garrisonOf(s, 'A')!)).toBe(12);
    expect(quoteCampaignRecruitment(s, 'ww2_rifle_infantry', site.nodeId).housing).toBe(12);
    const nodeWork = constructCampaignNodeRequest(s, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'barracks',
      subHex: site.annexSubHexes[2],
      tier: 1,
      engineerUnitId: null,
    });
    const built = apply(s, { type: 'nodeWork', request: nodeWork });
    expect(built.error).toBeNull();
    s = built.state;
    const hq = garrisonOf(s, 'A')!;
    const commander = commanderOf(s, 'A');
    expect(holderCapacity(s, hq)).toBe(16);
    expect(quoteCampaignRecruitment(s, 'ww2_rifle_infantry', site.nodeId).housing).toBe(16);
    while (hq.units.length < 15) hq.units.push(makeUnit(s, 'A', 'ww2_rifle_infantry'));
    expect(canTransfer(s, commander, hq)).toMatchObject({ ok: true });
    expect(transferUnits(s, commander.id, hq.id, [commander.units[0].id])).toMatchObject({
      ok: true,
    });
    expect(hq.units).toHaveLength(16);
    expect(canTransfer(s, commander, hq)).toMatchObject({
      ok: false,
      error: 'Receiver would exceed 16 units',
    });
    const f = s.infrastructure!;
    s.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((node) =>
          node.id === site.nodeId
            ? {
                ...node,
                buildings: node.buildings.map((building) =>
                  campaignBuildingData(building).placement === 'center'
                    ? { ...building, ruined: true }
                    : building,
                ),
              }
            : node,
        ),
      },
    };
    expect(holderCapacity(s, hq)).toBe(0);
    expect(quoteCampaignRecruitment(s, 'ww2_rifle_infantry', site.nodeId).housing).toBe(0);
    expect(canTransfer(s, commander, hq)).toMatchObject({
      ok: false,
      error: 'Receiver would exceed 0 units',
    });
    expect(hq.units).toHaveLength(16);
    const classic = game();
    expect(holderCapacity(classic, garrisonOf(classic, 'A')!)).toBe(12);
  });

  it('quotes active node housing for transfers rather than the legacy HQ capacity', () => {
    const s = game();
    const { world } = worldOf(s);
    const config = createFoundationPlaytestConfiguration(7, 3);
    const base = createCampaignInfrastructure(s, world, config.nodes);
    const site = base.sites.find((item) => item.homeTeam === null)!;
    const node = base.capture.nodes.find((item) => item.id === site.nodeId)!;
    const centerData = node.buildings[0].data;
    if (!centerData || typeof centerData !== 'object' || Array.isArray(centerData))
      throw new Error('Expected center payload');
    s.infrastructure = {
      ...base,
      configuration: {
        ...config,
        effects: {
          ...config.effects,
          generic: {
            ...config.effects.generic,
            1: { ...config.effects.generic[1]!, housing: 2 },
          },
        },
      },
      capture: {
        ...base.capture,
        nodes: base.capture.nodes.map((item) =>
          item.id === node.id
            ? {
                ...item,
                owner: 'A',
                buildings: [{ ...item.buildings[0], data: { ...centerData, active: true } }],
              }
            : item,
        ),
      },
    };
    const commander = commanderOf(s, 'A');
    put(s, commander, site.annexSubHexes[0]);
    const garrison: Army = {
      id: 'node-test-garrison',
      team: 'A',
      kind: 'garrison',
      building: 'node',
      nodeId: node.id,
      at: site.mainHex,
      pos: site.centerSubHex,
      movesLeft: 0,
      units: [makeUnit(s, 'A', 'ww2_rifle_infantry')],
    };
    s.armies.push(garrison);
    expect(canTransfer(s, commander, garrison)).toMatchObject({ ok: true });
    expect(transferUnits(s, commander.id, garrison.id, [commander.units[0].id])).toMatchObject({
      ok: true,
    });
    expect(garrison.units).toHaveLength(2);
    expect(canTransfer(s, commander, garrison)).toMatchObject({
      ok: false,
      error: 'Receiver would exceed 2 units',
    });
    const f = s.infrastructure;
    s.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((item) =>
          item.id === node.id
            ? {
                ...item,
                buildings: item.buildings.map((building) => ({ ...building, ruined: true })),
              }
            : item,
        ),
      },
    };
    expect(canTransfer(s, commander, garrison)).toMatchObject({
      ok: false,
      error: 'Receiver would exceed 0 units',
    });
    expect(garrison.units).toHaveLength(2); // Capacity loss does not delete deployed troops.
    garrison.nodeId = 'missing-node';
    expect(canTransfer(s, commander, garrison)).toMatchObject({
      ok: false,
      error: 'Receiver would exceed 0 units',
    });
    expect(COMMAND.garrisonCap).toBe(12);
  });
});

describe('AI on the command layer', () => {
  it('plays a campaign to the end keeping holder invariants', { timeout: 60000 }, () => {
    let s = createGame({
      ...defaultSettings(),
      era: 'medieval',
      seed: 7,
      grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
      commanderTrainingCp: 11,
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

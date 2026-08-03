import type { Era, GameState, MapDef, Team, UnitInstance } from '@iron-ridge/types';
import { v4 as uuidv4 } from 'uuid';
import { UNIT_DEFS, BASE_HP } from './unitDefs.ts';
import { resolveAttack } from './services/combatService.ts';
import type { AttackOpts } from './services/combatService.ts';

// ── Map-01 "The Defile" ───────────────────────────────────────────────────────

export const MAP_01: MapDef = {
  id: 'map_01',
  name: 'Map-01 "The Defile"',
  cols: 20,
  rows: 12,
  hm: [
    [2, 3, 4, 4, 4, 3, 2, 2, 6, 7, 8, 7, 6, 2, 2, 3, 4, 4, 3, 2],
    [2, 3, 4, 5, 5, 4, 2, 3, 6, 7, 8, 7, 6, 3, 2, 4, 5, 4, 3, 2],
    [3, 4, 5, 5, 5, 4, 2, 3, 6, 7, 8, 7, 6, 3, 2, 4, 5, 5, 4, 3],
    [3, 4, 5, 5, 5, 4, 2, 4, 6, 7, 8, 7, 6, 4, 2, 4, 5, 5, 4, 3],
    [3, 4, 5, 5, 5, 4, 2, 4, 6, 7, 8, 7, 6, 4, 2, 4, 5, 5, 4, 3],
    [3, 4, 5, 5, 5, 4, 2, 4, 6, 7, 8, 7, 6, 4, 2, 4, 5, 5, 4, 3],
    [3, 4, 5, 5, 5, 4, 2, 4, 6, 7, 8, 7, 6, 4, 2, 4, 5, 5, 4, 3],
    [3, 4, 5, 5, 5, 4, 2, 4, 6, 7, 8, 7, 6, 4, 2, 4, 5, 5, 4, 3],
    [3, 4, 5, 5, 5, 4, 2, 4, 6, 7, 8, 7, 6, 4, 2, 4, 5, 5, 4, 3],
    [3, 4, 5, 5, 5, 4, 2, 3, 6, 7, 8, 7, 6, 3, 2, 4, 5, 5, 4, 3],
    [2, 3, 4, 5, 5, 4, 2, 3, 6, 7, 8, 7, 6, 3, 2, 4, 5, 4, 3, 2],
    [2, 3, 4, 4, 4, 3, 2, 2, 6, 7, 8, 7, 6, 2, 2, 3, 4, 4, 3, 2],
  ],
};

// ── Unit factory ──────────────────────────────────────────────────────────────

function makeUnit(
  defId: string,
  team: Team,
  col: number,
  row: number,
  label: string,
  idSuffix: string,
): UnitInstance {
  const def = UNIT_DEFS[defId];
  if (!def) throw new Error(`Unknown unit def: ${defId}`);
  const maxHp = BASE_HP[def.armorClass] ?? 10;
  return {
    id: `${team}_${defId}_${idSuffix}`,
    defId,
    team,
    col,
    row,
    label,
    hp: maxHp,
    maxHp,
    moved: false,
    fired: false,
  };
}

function buildDefaultUnits(): UnitInstance[] {
  return [
    // Team A (WW2)
    makeUnit('ww2_tank', 'A', 2, 4, 'TK-1', '0'),
    makeUnit('ww2_tank', 'A', 2, 7, 'TK-2', '1'),
    makeUnit('ww2_artillery', 'A', 1, 5, 'ART', '0'),
    makeUnit('ww2_rifle_infantry', 'A', 5, 5, 'SPT', '0'),
    // Team B (WW2)
    makeUnit('ww2_tank', 'B', 17, 4, 'TK-1', '0'),
    makeUnit('ww2_tank', 'B', 17, 7, 'TK-2', '1'),
    makeUnit('ww2_artillery', 'B', 18, 5, 'ART', '0'),
  ];
}

// ── In-memory game store ──────────────────────────────────────────────────────

const games = new Map<string, GameState>();

// ── CRUD helpers ──────────────────────────────────────────────────────────────

export function createGame(era: Era = 'ww2'): GameState {
  const id = uuidv4();
  const game: GameState = {
    id,
    era,
    phase: 'setup',
    turn: 1,
    activeTeam: 'A',
    units: buildDefaultUnits(),
    combatLog: [],
    map: MAP_01,
  };
  games.set(id, game);
  return game;
}

export function getGame(id: string): GameState | undefined {
  return games.get(id);
}

export function endTurn(id: string): GameState | undefined {
  const game = games.get(id);
  if (!game) return undefined;

  const nextTeam: Team = game.activeTeam === 'A' ? 'B' : 'A';
  const nextTurn = nextTeam === 'A' ? game.turn + 1 : game.turn;
  const resetUnits = game.units.map((u) =>
    u.team === game.activeTeam ? { ...u, moved: false, fired: false } : u,
  );

  const updated: GameState = {
    ...game,
    activeTeam: nextTeam,
    turn: nextTurn,
    units: resetUnits,
    phase: 'combat',
  };
  games.set(id, updated);
  return updated;
}

export function attack(
  id: string,
  attackerId: string,
  defenderId: string,
  opts?: AttackOpts,
): { game: GameState; result: ReturnType<typeof resolveAttack> } | undefined {
  const game = games.get(id);
  if (!game) return undefined;

  const attacker = game.units.find((u) => u.id === attackerId);
  const defender = game.units.find((u) => u.id === defenderId);
  if (!attacker || !defender) return undefined;

  const result = resolveAttack(attacker, defender, game.map.hm, opts);

  const newLog = [
    `--- Turn: ${game.turn} | ${attacker.label} → ${defender.label} ---`,
    ...result.log,
    '',
    ...game.combatLog,
  ].slice(0, 80);

  const newUnits = game.units.map((u) => {
    if (u.id === attackerId) return { ...u, fired: true };
    if (u.id === defenderId) {
      return { ...u, hp: Math.max(0, u.hp - result.finalDamage) };
    }
    return u;
  });

  const updated: GameState = { ...game, units: newUnits, combatLog: newLog };
  games.set(id, updated);
  return { game: updated, result };
}

export function resetGame(id: string): GameState | undefined {
  const game = games.get(id);
  if (!game) return undefined;
  const reset: GameState = {
    ...game,
    phase: 'setup',
    turn: 1,
    activeTeam: 'A',
    units: buildDefaultUnits(),
    combatLog: [],
  };
  games.set(id, reset);
  return reset;
}

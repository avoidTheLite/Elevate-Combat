import { create } from "zustand";
import type { GameState, UnitInstance, Team, Era } from "../types/game";
import { MAP_01 } from "../data/maps";
import { UNIT_DEFS, BASE_HP } from "../data/unitDefs";
import { resolveAttack } from "../lib/combat";

function makeUnit(
  defId: string,
  team: Team,
  col: number,
  row: number,
  label: string,
  idSuffix: string
): UnitInstance {
  const def = UNIT_DEFS[defId];
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
    makeUnit("ww2_tank",          "A",  2, 4, "TK-1", "0"),
    makeUnit("ww2_tank",          "A",  2, 7, "TK-2", "1"),
    makeUnit("ww2_artillery",     "A",  1, 5, "ART",  "0"),
    makeUnit("ww2_rifle_infantry","A",  5, 5, "SPT",  "0"),
    // Team B (WW2)
    makeUnit("ww2_tank",          "B", 17, 4, "TK-1", "0"),
    makeUnit("ww2_tank",          "B", 17, 7, "TK-2", "1"),
    makeUnit("ww2_artillery",     "B", 18, 5, "ART",  "0"),
  ];
}

interface GameStore extends GameState {
  map: typeof MAP_01;
  // actions
  selectUnit: (id: string | null) => void;
  setEra: (era: Era) => void;
  resetGame: () => void;
  endTurn: () => void;
  attack: (attackerId: string, defenderId: string) => void;
}

const initialState = (): Omit<GameStore, keyof { selectUnit: unknown; setEra: unknown; resetGame: unknown; endTurn: unknown; attack: unknown }> => ({
  era: "ww2",
  phase: "setup",
  turn: 1,
  activeTeam: "A",
  units: buildDefaultUnits(),
  selectedUnitId: null,
  combatLog: [],
  map: MAP_01,
});

export const useGameStore = create<GameStore>((set, get) => ({
  ...initialState(),

  selectUnit(id) {
    set({ selectedUnitId: id });
  },

  setEra(era) {
    set({ era });
  },

  resetGame() {
    set({ ...initialState() });
  },

  endTurn() {
    const { activeTeam, turn, units } = get();
    const nextTeam: Team = activeTeam === "A" ? "B" : "A";
    const nextTurn = nextTeam === "A" ? turn + 1 : turn;
    const resetUnits = units.map((u) =>
      u.team === activeTeam ? { ...u, moved: false, fired: false } : u
    );
    set({
      activeTeam: nextTeam,
      turn: nextTurn,
      units: resetUnits,
      selectedUnitId: null,
      phase: "combat",
    });
  },

  attack(attackerId, defenderId) {
    const { units, map, combatLog } = get();
    const attacker = units.find((u) => u.id === attackerId);
    const defender = units.find((u) => u.id === defenderId);
    if (!attacker || !defender) return;

    const result = resolveAttack(attacker, defender, map.hm, {
      attackerMoved: attacker.moved,
    });

    const newLog = [
      `--- Turn: ${get().turn} | ${attacker.label} → ${defender.label} ---`,
      ...result.log,
      "",
      ...combatLog,
    ].slice(0, 80); // keep last 80 lines

    const newUnits = units.map((u) => {
      if (u.id === attackerId) return { ...u, fired: true };
      if (u.id === defenderId) {
        const newHp = Math.max(0, u.hp - result.finalDamage);
        return { ...u, hp: newHp };
      }
      return u;
    });

    set({ units: newUnits, combatLog: newLog, selectedUnitId: null });
  },
}));

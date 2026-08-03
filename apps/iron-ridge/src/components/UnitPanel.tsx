import type { UnitInstance } from "../types/game";
import { UNIT_DEFS } from "../data/unitDefs";

interface Props {
  unit: UnitInstance | null;
  allUnits: UnitInstance[];
  activeTeam: "A" | "B";
  onAttack: (defenderId: string) => void;
}

export function UnitPanel({ unit, allUnits, activeTeam, onAttack }: Props) {
  if (!unit) {
    return (
      <div className="border border-[#002233] p-3 font-mono text-[#003344] text-xs">
        <div className="text-[#006677]">// SELECT A UNIT</div>
        <div className="mt-1">Click a unit on the map to inspect it.</div>
      </div>
    );
  }

  const def = UNIT_DEFS[unit.defId];
  const isActive = unit.team === activeTeam;
  const clr = unit.team === "A" ? "text-[#00ffff]" : "text-[#ff3355]";
  const enemies = allUnits.filter(
    (u) => u.team !== unit.team && u.hp > 0
  );

  return (
    <div className="border border-[#002233] p-3 font-mono text-xs space-y-2">
      <div className={`text-sm font-bold ${clr}`}>
        [{unit.label}] {def?.name ?? unit.defId}
      </div>
      <div className="text-[#006677] grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span>Team:</span>         <span className={clr}>{unit.team === "A" ? "Alpha" : "Bravo"}</span>
        <span>Class:</span>        <span className="text-[#00aacc]">{def?.unitClass}</span>
        <span>Armor:</span>        <span className="text-[#00aacc]">{def?.armorClass}</span>
        <span>Damage:</span>       <span className="text-[#00aacc]">{def?.damageType}</span>
        <span>Attack:</span>       <span className="text-[#00aacc]">{def?.attackType}</span>
        <span>Placement:</span>    <span className="text-[#00aacc]">{def?.placementCategory}</span>
        <span>Position:</span>     <span className="text-[#00aacc]">col:{unit.col} row:{unit.row}</span>
        <span>HP:</span>
        <span>
          <span className={unit.hp / unit.maxHp > 0.5 ? "text-[#00ff66]" : "text-[#ffaa00]"}>
            {unit.hp}
          </span>
          <span className="text-[#003344]">/{unit.maxHp}</span>
        </span>
        <span>Moved:</span>        <span className={unit.moved ? "text-[#ffaa00]" : "text-[#00ff66]"}>{unit.moved ? "yes" : "no"}</span>
        <span>Fired:</span>        <span className={unit.fired ? "text-[#ffaa00]" : "text-[#00ff66]"}>{unit.fired ? "yes" : "no"}</span>
      </div>

      {def?.specialRules.length ? (
        <div>
          <div className="text-[#005566]">// SPECIAL RULES</div>
          {def.specialRules.map((r, i) => (
            <div key={i} className="text-[#004455] leading-snug">› {r}</div>
          ))}
        </div>
      ) : null}

      {isActive && !unit.fired && unit.hp > 0 && enemies.length > 0 ? (
        <div>
          <div className="text-[#005566] mb-1">// FIRE AT</div>
          <div className="flex flex-wrap gap-1">
            {enemies.map((e) => (
              <button
                key={e.id}
                onClick={() => onAttack(e.id)}
                className="border border-[#ff3355] text-[#ff3355] px-2 py-0.5 text-[10px]
                           hover:bg-[#ff3355] hover:text-[#000810] transition-colors cursor-pointer"
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!isActive && (
        <div className="text-[#003344]">// NOT YOUR TURN</div>
      )}
      {unit.fired && (
        <div className="text-[#003344]">// ALREADY FIRED THIS TURN</div>
      )}
    </div>
  );
}

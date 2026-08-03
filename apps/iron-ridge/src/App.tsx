import { useGameStore } from "./store/gameStore";
import { MapCanvas } from "./components/MapCanvas";
import { UnitPanel } from "./components/UnitPanel";
import { CombatLog } from "./components/CombatLog";

export default function App() {
  const {
    map,
    units,
    selectedUnitId,
    activeTeam,
    turn,
    combatLog,
    selectUnit,
    endTurn,
    attack,
    resetGame,
  } = useGameStore();

  const selectedUnit = units.find((u) => u.id === selectedUnitId) ?? null;

  const handleUnitClick = (id: string) => {
    selectUnit(selectedUnitId === id ? null : id);
  };

  const handleAttack = (defenderId: string) => {
    if (selectedUnitId) attack(selectedUnitId, defenderId);
  };

  const aliveA = units.filter((u) => u.team === "A" && u.hp > 0).length;
  const aliveB = units.filter((u) => u.team === "B" && u.hp > 0).length;
  const gameOver = aliveA === 0 || aliveB === 0;

  return (
    <div
      className="min-h-screen bg-[#000810] text-[#00ddff] font-mono flex flex-col items-center"
      style={{ padding: "10px 6px" }}
    >
      {/* Header */}
      <div className="w-full max-w-[1100px] flex items-center justify-between mb-3">
        <div>
          <span className="text-[#009aaa] font-bold text-sm tracking-widest">
            ▲ IRON RIDGE
          </span>
          <span className="text-[#003344] text-xs ml-4">
            TACTICAL COMBAT PROTOTYPE
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-[#006677]">TURN {turn}</span>
          <span
            className={`font-bold ${activeTeam === "A" ? "text-[#00ffff]" : "text-[#ff3355]"}`}
          >
            {activeTeam === "A" ? "◈ ALPHA" : "◈ BRAVO"} ACTIVE
          </span>
          <span className="text-[#006677]">
            α:{aliveA} β:{aliveB}
          </span>
        </div>
      </div>

      {/* Game over banner */}
      {gameOver && (
        <div className="w-full max-w-[1100px] border border-[#ffaa00] text-[#ffaa00] text-center py-2 mb-3 text-sm font-bold tracking-widest">
          {aliveA === 0 ? "◈ BRAVO WINS" : "◈ ALPHA WINS"} — ENGAGEMENT COMPLETE
        </div>
      )}

      {/* Main layout */}
      <div className="w-full max-w-[1100px] flex gap-4">
        {/* Map */}
        <div className="flex-1">
          <MapCanvas
            hm={map.hm}
            units={units}
            selectedId={selectedUnitId}
            activeTeam={activeTeam}
            onUnitClick={handleUnitClick}
          />
        </div>

        {/* Sidebar */}
        <div className="w-[260px] flex flex-col gap-3 flex-shrink-0">
          {/* Controls */}
          <div className="border border-[#002233] p-3 flex flex-col gap-2">
            <div className="text-[#006677] text-xs">// CONTROLS</div>
            <button
              onClick={endTurn}
              disabled={gameOver}
              className="border border-[#009aaa] text-[#009aaa] px-3 py-1.5 text-xs
                         hover:bg-[#009aaa] hover:text-[#000810] transition-colors
                         cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              END TURN →
            </button>
            <button
              onClick={resetGame}
              className="border border-[#444466] text-[#444466] px-3 py-1.5 text-xs
                         hover:border-[#ff4455] hover:text-[#ff4455] transition-colors cursor-pointer"
            >
              RESET GAME
            </button>
          </div>

          {/* Unit detail */}
          <UnitPanel
            unit={selectedUnit}
            allUnits={units}
            activeTeam={activeTeam}
            onAttack={handleAttack}
          />

          {/* Combat log */}
          <CombatLog log={combatLog} />
        </div>
      </div>

      {/* Footer */}
      <div className="w-full max-w-[1100px] mt-3 text-[#002233] text-[8px] space-y-0.5">
        <div>// IRON RIDGE — COMBAT PROTOTYPE v0.1 | Click a unit, then select a target to fire</div>
        <div>// Rules: Iron Ridge Ranged Combat v1 — d20 to-hit, dice pool damage, armor reduction</div>
      </div>
    </div>
  );
}

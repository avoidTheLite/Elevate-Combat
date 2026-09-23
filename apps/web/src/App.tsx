import { useState } from 'react';
import type { UnitInstance } from '@iron-ridge/types';
import { MapCanvas } from './components/game/MapCanvas.tsx';
import { UnitPanel } from './components/game/UnitPanel.tsx';
import { CombatLog } from './components/game/CombatLog.tsx';
import { Button } from './components/ui/Button.tsx';
import { useCreateGame, useGameQuery, useAttack, useEndTurn, useResetGame } from './hooks/useGameQuery.ts';
import { useGameUIStore } from './stores/useGameUIStore.ts';

export default function App(): React.ReactElement {
  const [gameId, setGameId] = useState<string | null>(null);
  const { selectedUnitId, selectUnit } = useGameUIStore();

  const createGame = useCreateGame();
  const { data } = useGameQuery(gameId);

  const game = data?.game ?? null;

  const attack = useAttack(gameId ?? '');
  const endTurn = useEndTurn(gameId ?? '');
  const resetGame = useResetGame(gameId ?? '');

  const units: UnitInstance[] = game?.units ?? [];
  const selectedUnit = units.find((u) => u.id === selectedUnitId) ?? null;

  const aliveA = units.filter((u) => u.team === 'A' && u.hp > 0).length;
  const aliveB = units.filter((u) => u.team === 'B' && u.hp > 0).length;
  const gameOver = game !== null && (aliveA === 0 || aliveB === 0);

  const handleUnitClick = (id: string): void => {
    selectUnit(selectedUnitId === id ? null : id);
  };

  const handleAttack = (defenderId: string): void => {
    if (!selectedUnitId || !gameId) return;
    const attacker = units.find((u) => u.id === selectedUnitId);
    attack.mutate({ attackerId: selectedUnitId, defenderId, attackerMoved: attacker?.moved });
    selectUnit(null);
  };

  if (!gameId) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6">
        <div className="text-2xl font-bold tracking-widest">▲ IRON RIDGE</div>
        <div className="text-[hsl(var(--muted-foreground))] text-sm">TACTICAL COMBAT PROTOTYPE</div>
        <Button
          onClick={() => createGame.mutate(undefined, { onSuccess: (d) => setGameId(d.game.id) })}
          disabled={createGame.isPending}
          size="lg"
        >
          {createGame.isPending ? 'INITIALIZING...' : 'START NEW GAME'}
        </Button>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-[hsl(var(--muted-foreground))]">LOADING...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center" style={{ padding: '10px 6px' }}>
      {/* Header */}
      <div className="w-full max-w-[1100px] flex items-center justify-between mb-3">
        <div>
          <span className="text-[hsl(var(--muted-foreground))] font-bold text-sm tracking-widest">
            ▲ IRON RIDGE
          </span>
          <span className="text-[hsl(var(--muted-foreground))] text-xs ml-4">TACTICAL COMBAT PROTOTYPE</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">TURN {game.turn}</span>
          <span
            className={`font-bold ${game.activeTeam === 'A' ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--secondary))]'}`}
          >
            {game.activeTeam === 'A' ? '◈ ALPHA' : '◈ BRAVO'} ACTIVE
          </span>
          <span className="text-[hsl(var(--muted-foreground))]">
            α:{aliveA} β:{aliveB}
          </span>
        </div>
      </div>

      {/* Game over banner */}
      {gameOver && (
        <div className="w-full max-w-[1100px] border border-[hsl(var(--warning))] text-[hsl(var(--warning))] text-center py-2 mb-3 text-sm font-bold tracking-widest">
          {aliveA === 0 ? '◈ BRAVO WINS' : '◈ ALPHA WINS'} — ENGAGEMENT COMPLETE
        </div>
      )}

      {/* Main layout */}
      <div className="w-full max-w-[1100px] flex gap-4">
        <div className="flex-1">
          <MapCanvas
            hm={game.map.hm}
            units={units}
            selectedId={selectedUnitId}
            activeTeam={game.activeTeam}
            onUnitClick={handleUnitClick}
          />
        </div>

        <div className="w-[260px] flex flex-col gap-3 flex-shrink-0">
          <div className="border border-[hsl(var(--border))] p-3 flex flex-col gap-2">
            <div className="text-[hsl(var(--muted-foreground))] text-xs">// CONTROLS</div>
            <Button
              onClick={() => { endTurn.mutate(); selectUnit(null); }}
              disabled={gameOver || endTurn.isPending}
            >
              END TURN →
            </Button>
            <Button
              variant="ghost"
              onClick={() => resetGame.mutate()}
              disabled={resetGame.isPending}
            >
              RESET GAME
            </Button>
          </div>

          <UnitPanel
            unit={selectedUnit}
            allUnits={units}
            activeTeam={game.activeTeam}
            onAttack={handleAttack}
          />

          <CombatLog log={game.combatLog} />
        </div>
      </div>

      <div className="w-full max-w-[1100px] mt-3 text-[hsl(var(--muted-foreground))] text-[8px] space-y-0.5">
        <div>// IRON RIDGE — COMBAT PROTOTYPE v0.2 | Click a unit, then select a target to fire</div>
        <div>// Rules: Iron Ridge Ranged Combat v1 — d20 to-hit, dice pool damage, armor reduction</div>
      </div>
    </div>
  );
}

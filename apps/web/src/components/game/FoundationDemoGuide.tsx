import { useMemo } from 'react';
import type { GameState } from '@iron-ridge/engine';
import { apply, foundationHasPending } from '@iron-ridge/engine';
import {
  FOUNDATION_DEMO_SCENARIOS,
  foundationDemoFocus,
  foundationDemoScenarioId,
} from '../../foundation/demoScenarios.ts';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';

export function FoundationDemoGuide({ game }: { game: GameState }): React.ReactElement | null {
  const dispatch = useGameStore((state) => state.dispatch);
  const setUi = useGameStore((state) => state.setUi);
  const id = foundationDemoScenarioId(game);
  const focus = useMemo(() => foundationDemoFocus(game), [game]);
  const site = game.infrastructure?.sites.find((site) => site.mainHex === focus.selectedMain);
  const move = useMemo(() => {
    if (
      id !== 'capture-move' ||
      !site ||
      !focus.selectedArmy ||
      game.phase !== 'strategic' ||
      game.active !== 'A' ||
      foundationHasPending(game)
    )
      return null;
    const action = {
      type: 'moveCommander' as const,
      armyId: focus.selectedArmy,
      dest: site.centerSubHex,
    };
    return { action, error: apply(game, action).error };
  }, [id, site, focus.selectedArmy, game]);
  if (!id) return null;
  const label = FOUNDATION_DEMO_SCENARIOS.find((scenario) => scenario.value === id)!.label;
  return (
    <div
      role="region"
      aria-label="Prepared demo guide"
      className="border-b border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px]"
    >
      <div className="flex-1 min-w-[220px] leading-4">
        <strong className="text-[hsl(var(--warning))]">PREPARED DEMO · {label}</strong>
        <p>
          {id === 'capture-start'
            ? 'Choose Capture Node, Raze Node or Do nothing independently for all three outposts, then confirm. Save & Quit can resume unfinished choices exactly. Inspect a captured node to try its building order.'
            : id === 'capture-move'
              ? 'Move Alpha to the enemy center, then choose its outcome. Capture after movement updates network benefits now; building work and deployment wait until the next owner turn.'
              : 'Your selected Alpha unit stands on the enemy Workshop. Click Raze Tile (1 ACT, 0 CP), then Save or SECURE → RETURN TO CAMPAIGN. Resolve node and garrison choices; inspect the saved Workshop ruin afterward.'}
        </p>
        <p className="text-[hsl(var(--muted-foreground))]">
          Prepared positions · normal game actions and saves · provisional playtest tuning · CP is
          earned normally. Restart a scenario from MENU → Abandon → setup.
        </p>
      </div>
      <div className="flex gap-1 items-center">
        {id === 'capture-move' && (
          <Button
            size="sm"
            disabled={!move || !!move.error}
            title={move?.error ?? 'Move through the normal commander action'}
            onClick={() => {
              if (move && !move.error && dispatch(move.action))
                setUi({ selectedArmy: focus.selectedArmy, selectedMain: focus.selectedMain });
            }}
          >
            MOVE TO NODE CENTER
          </Button>
        )}
        {id === 'annex-raid' && game.battle?.phase === 'combat' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!focus.selectedUnit}
            onClick={() => setUi({ selectedUnit: focus.selectedUnit })}
          >
            SELECT RAID UNIT
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={game.phase !== 'strategic' || foundationHasPending(game)}
          onClick={() => setUi({ selectedMain: focus.selectedMain, selectedArmy: null })}
        >
          INSPECT DEMO NODE
        </Button>
      </div>
    </div>
  );
}

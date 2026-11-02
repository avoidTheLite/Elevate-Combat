import { useMemo } from 'react';
import type { GameState } from '@iron-ridge/engine';
import { campaignRazeTileOptions } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';

export function RazeTileControl({
  game,
  unitId,
  canAct,
}: {
  game: GameState;
  unitId: string;
  canAct: boolean;
}): React.ReactElement | null {
  const dispatch = useGameStore((state) => state.dispatch);
  const options = useMemo(() => campaignRazeTileOptions(game, unitId), [game, unitId]);
  if (!game.infrastructure || game.battle?.phase !== 'combat') return null;
  const unit = game.battle.units.find((candidate) => candidate.id === unitId);
  const quote = options.find((candidate) => candidate.subHex === unit?.pos);
  return (
    <div
      role="region"
      aria-label="Raze Tile"
      className="mt-2 border-t border-[hsl(var(--border-bright))] pt-2 flex flex-col gap-1"
    >
      {quote?.label && <p className="text-[10px]">Side-tile upgrade: {quote.label}</p>}
      <Button
        size="sm"
        variant="destructive"
        disabled={!canAct || !quote?.eligible}
        title={
          quote?.reason ??
          (quote
            ? 'Leave this upgrade as a repairable ruin'
            : 'Stand on an enemy annex upgrade to Raze Tile')
        }
        onClick={() => {
          if (canAct && quote?.eligible)
            dispatch({ type: 'razeTile', unitId, buildingId: quote.buildingId });
        }}
      >
        Raze Tile{quote ? ` (${quote.actionCost} ACT · ${quote.cpCost} CP)` : ''}
      </Button>
      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
        {quote?.reason ??
          (quote
            ? 'Uses this activation’s ACT and ends movement. The upgrade becomes a repairable ruin; its tier, upgrades and equipment stay recorded.'
            : 'Stand on an enemy annex upgrade to Raze Tile. Center choices are Capture Node and Raze Node.')}
      </p>
    </div>
  );
}

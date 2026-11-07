import { useMemo } from 'react';
import type { GameAction, GameState } from '@iron-ridge/engine';
import { apply, isAiTurn, actingTeam, foundationHasPending } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';

export function TurnControls({
  game,
  blocked = false,
}: {
  game: GameState;
  blocked?: boolean;
}): React.ReactElement {
  const dispatch = useGameStore((s) => s.dispatch);
  const actions = useMemo((): { label: string; action: GameAction; reason: string | null }[] => {
    const list: { label: string; action: GameAction }[] =
      game.phase === 'strategic'
        ? [{ label: 'END TURN →', action: { type: 'endTurn' } }]
        : game.phase === 'battle' && game.battle?.phase === 'combat'
          ? [
              { label: 'END TURN →', action: { type: 'endBattleTurn' } },
              { label: 'RETREAT', action: { type: 'retreat' } },
            ]
          : game.phase === 'battle' && game.battle?.phase === 'deploy'
            ? [{ label: 'READY ▶', action: { type: 'finishDeploy' } }]
            : [];
    if (
      game.phase === 'battle' &&
      game.battle?.phase === 'combat' &&
      !apply(game, { type: 'secureObjective' }).error
    ) {
      list.push(
        { label: 'SECURE', action: { type: 'secureObjective' } },
        { label: 'EXTRACT', action: { type: 'extract' } },
      );
    }
    return list.map((item) => ({ ...item, reason: apply(game, item.action).error }));
  }, [game]);
  const team = actingTeam(game);
  const allowed =
    !blocked &&
    !foundationHasPending(game) &&
    !isAiTurn(game) &&
    !!team &&
    game.settings.controllers[team] === 'human';
  return (
    <div role="group" aria-label="Turn actions" className="flex gap-1 shrink-0">
      {actions.map((item) => (
        <Button
          key={item.label}
          size="sm"
          variant={item.label === 'RETREAT' ? 'destructive' : 'default'}
          disabled={!allowed || !!item.reason}
          title={
            !allowed
              ? 'Turn action unavailable while waiting or resolving a choice'
              : (item.reason ?? undefined)
          }
          onClick={() => {
            if (
              item.action.type !== 'retreat' ||
              window.confirm('Withdraw from the battle? The other side wins the hex.')
            )
              dispatch(item.action);
          }}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

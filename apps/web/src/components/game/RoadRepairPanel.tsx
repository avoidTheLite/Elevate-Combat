import { useMemo, useState } from 'react';
import type { GameState, Team } from '@iron-ridge/engine';
import { campaignRoadRepairOptions } from '@iron-ridge/engine';
import { useGameStore, viewTeam } from '../../stores/useGameStore.ts';
import { strategicKnowledge } from '../../lib/strategicVisibility.ts';
import { Button } from '../ui/Button.tsx';
import { Panel } from '../ui/Panel.tsx';

export function RoadRepairPanel({
  game,
  mainHex,
  canAct,
  engineerUnitId,
  view,
}: {
  game: GameState;
  mainHex: string | null;
  canAct: boolean;
  engineerUnitId?: string | null;
  view?: Team | null;
}): React.ReactElement | null {
  const dispatch = useGameStore((state) => state.dispatch);
  const [selectedId, setSelectedId] = useState('');
  const observer = view === undefined ? viewTeam(game) : view;
  const knowledge = useMemo(
    () => (game.phase === 'strategic' ? strategicKnowledge(game, observer) : null),
    [game, observer],
  );
  const options = useMemo(
    () =>
      campaignRoadRepairOptions(game).filter(
        (option) =>
          (mainHex === null || option.mainHex === mainHex) &&
          (engineerUnitId === undefined || option.engineerUnitId === engineerUnitId) &&
          (!knowledge ||
            !!game.infrastructure?.supply?.roads
              .find((road) => road.id === option.roadId)
              ?.path.every((key) => knowledge.cells.has(key))),
      ),
    [game, mainHex, engineerUnitId, knowledge],
  );
  if (options.length === 0) return null;
  const selected = options.find((option) => option.request?.requestId === selectedId);
  return (
    <Panel id="roads" title="ROAD REPAIR">
      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
        Repairing one damaged road section spends its quoted CP and one engineer action. It does not
        use a node building operation.
        {game.phase === 'battle' &&
          ' In battle it also spends 1 ACT and ends movement. Tactical rounds and reload do not refresh the strategic engineer action.'}
      </p>
      <label className="text-[10px] flex flex-col gap-1">
        <span>Road repair order</span>
        <select
          value={selected?.request?.requestId ?? ''}
          onChange={(event) => setSelectedId(event.target.value)}
          className="bg-[hsl(var(--panel))] border border-[hsl(var(--border-bright))] p-1"
        >
          <option value="">Choose a road and engineer…</option>
          {options.map((option) => (
            <option
              key={option.request?.requestId ?? option.roadId}
              value={option.request?.requestId ?? ''}
              disabled={option.request === null}
            >
              {option.roadId} · {option.engineerLabel ?? 'Engineer required'} ·{' '}
              {option.cpCost ?? '—'} CP
            </option>
          ))}
        </select>
      </label>
      {options
        .filter((option) => option.request === null)
        .map((option) => (
          <p key={option.roadId} className="text-[10px] text-[hsl(var(--warning))]">
            {option.roadId}: {option.reason}
          </p>
        ))}
      {selected && (
        <>
          {!selected.allowed && (
            <p className="text-[10px] text-[hsl(var(--warning))]">{selected.reason}</p>
          )}
          <Button
            size="sm"
            disabled={!canAct || !selected.allowed || selected.request === null}
            onClick={() => {
              if (
                canAct &&
                selected.allowed &&
                selected.request &&
                dispatch({ type: 'repairRoad', request: selected.request })
              )
                setSelectedId('');
            }}
          >
            Repair road ({game.phase === 'battle' ? '1 ACT · ' : ''}
            {selected.cpCost} CP)
          </Button>
        </>
      )}
    </Panel>
  );
}

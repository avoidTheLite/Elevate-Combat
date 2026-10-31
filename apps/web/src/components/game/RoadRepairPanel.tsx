import { useMemo, useState } from 'react';
import type { GameState } from '@iron-ridge/engine';
import { campaignRoadRepairOptions } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';
import { Panel } from '../ui/Panel.tsx';

export function RoadRepairPanel({
  game,
  mainHex,
  canAct,
}: {
  game: GameState;
  mainHex: string | null;
  canAct: boolean;
}): React.ReactElement | null {
  const dispatch = useGameStore((state) => state.dispatch);
  const [selectedId, setSelectedId] = useState('');
  const options = useMemo(
    () =>
      campaignRoadRepairOptions(game).filter(
        (option) => mainHex === null || option.mainHex === mainHex,
      ),
    [game, mainHex],
  );
  if (options.length === 0) return null;
  const selected = options.find((option) => option.request?.requestId === selectedId);
  return (
    <Panel id="roads" title="ROAD REPAIR">
      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
        Repairing one damaged road section spends its quoted CP and one engineer action. It does not
        use a node building operation.
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
            Repair road ({selected.cpCost} CP)
          </Button>
        </>
      )}
    </Panel>
  );
}

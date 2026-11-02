import type { Team } from '@iron-ridge/engine';
import { TEAM_NAME, unitType } from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';

export interface StationingUnitOption {
  unitId: string;
  label: string;
  typeId: string;
  subHex: string;
  tileKind: 'road' | 'outpost' | 'fort';
  hp: number;
}

export interface StationingPanelProps {
  team: Team;
  currentTeam: Team | null;
  candidates: readonly StationingUnitOption[];
  selectedUnitIds: readonly string[];
  onToggle: (unitId: string, selected: boolean) => void;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
}

const TILE_LABELS = { road: 'Road', outpost: 'Outpost', fort: 'Fortified tile' };

/** Selection is owned by the saved engine transaction, never by local checkbox state. */
export function StationingPanel({
  team,
  currentTeam,
  candidates,
  selectedUnitIds,
  onToggle,
  onConfirm,
  busy = false,
  error,
}: StationingPanelProps): React.ReactElement {
  const canChoose = currentTeam === team && !busy;
  const selected = new Set(selectedUnitIds);
  const selectedCount = candidates.filter((candidate) => selected.has(candidate.unitId)).length;
  return (
    <div role="region" aria-label="Station survivors" aria-busy={busy}>
      <Panel title="STATION SURVIVORS" right={TEAM_NAME[team]}>
        <p className="text-xs">
          Choose which survivors stay on their tiles as one-unit garrisons. Leave any number,
          including none.
        </p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Stationed troops stay when their commander leaves. They can fire in a battle here but
          cannot move or pursue. A commander can retrieve them using normal garrison interaction
          distance.
        </p>
        <div className="flex flex-col gap-2">
          {candidates.map((candidate) => (
            <label
              key={candidate.unitId}
              className="border border-[hsl(var(--border))] p-2 flex gap-2 items-start text-xs"
            >
              <input
                type="checkbox"
                checked={selected.has(candidate.unitId)}
                disabled={!canChoose}
                onChange={(event) => onToggle(candidate.unitId, event.target.checked)}
                aria-label={`Station ${candidate.label} at ${candidate.subHex}`}
                className="accent-[hsl(var(--primary))]"
              />
              <span className="flex flex-col gap-1">
                <span>
                  {candidate.label} · {unitType(candidate.typeId).name}
                </span>
                <span className="text-[hsl(var(--muted-foreground))]">
                  {TILE_LABELS[candidate.tileKind]} · {candidate.subHex} · {candidate.hp} HP
                </span>
              </span>
            </label>
          ))}
        </div>
        {candidates.length === 0 && (
          <p className="text-xs">No survivors stand on a garrisonable tile.</p>
        )}
        <Stat label="Units staying behind" value={selectedCount} />
        {currentTeam !== team && (
          <p className="text-xs">Waiting for {TEAM_NAME[team]} to choose.</p>
        )}
        {error && (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {error}
          </p>
        )}
        <Button
          disabled={!canChoose}
          onClick={() => {
            if (canChoose) onConfirm();
          }}
        >
          {busy
            ? 'Confirming stationing…'
            : selectedCount
              ? 'Confirm stationed units'
              : 'Continue without stationing'}
        </Button>
      </Panel>
    </div>
  );
}

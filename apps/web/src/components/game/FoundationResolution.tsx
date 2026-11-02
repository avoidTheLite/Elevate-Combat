import type { GameState, Team } from '@iron-ridge/engine';
import { TEAM_NAME, foundationPendingTeam, getFreeShotPrompt } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';
import { CaptureChoicePanel } from './CaptureChoicePanel.tsx';
import { FreeShotPanel, type FreeShotActorLabel } from './FreeShotPanel.tsx';
import { SaveMenu } from './SaveMenu.tsx';
import { StationingPanel } from './StationingPanel.tsx';

function shotActorLabels(game: GameState): Record<string, FreeShotActorLabel> {
  const labels: Record<string, FreeShotActorLabel> = {};
  for (const holder of game.armies) {
    labels[holder.id] = {
      label: `${TEAM_NAME[holder.team]} ${holder.kind === 'commander' ? 'Commander' : 'Garrison'}`,
      detail: `${holder.units.filter((unit) => unit.hp > 0).length} units · ${holder.pos}`,
    };
    for (const unit of holder.units)
      labels[unit.id] = { label: unit.label, detail: `${unit.hp} HP` };
  }
  for (const unit of game.battle?.units ?? []) {
    labels[unit.id] = {
      label: unit.label,
      detail: `${unit.hp} HP · ${unit.pos ?? 'not deployed'}`,
    };
  }
  return labels;
}

/** All decisions below pass through apply/autosave, including uncommitted selections. */
export function FoundationResolution({ game }: { game: GameState }): React.ReactElement | null {
  const dispatch = useGameStore((state) => state.dispatch);
  const error = useGameStore((state) => state.error);
  const saveAndQuit = useGameStore((state) => state.saveAndQuit);
  const infrastructure = game.infrastructure;
  const team = foundationPendingTeam(game);
  if (!infrastructure || team === null || game.settings.controllers[team] !== 'human') return null;
  const currentTeam: Team = team;
  const capture = infrastructure.capture.pending;
  const stationing = infrastructure.garrisons?.pendingStationing;
  const shot = infrastructure.garrisons
    ? getFreeShotPrompt(infrastructure.garrisons.freeShots)
    : null;

  const panel = capture ? (
    <CaptureChoicePanel
      batch={capture}
      currentTeam={currentTeam}
      commandPoints={game.cp[capture.team]}
      onSelect={(nodeId, outcome) => dispatch({ type: 'captureChoice', nodeId, outcome })}
      onConfirm={() => dispatch({ type: 'captureCommit' })}
      error={error ?? undefined}
    />
  ) : stationing ? (
    <StationingPanel
      team={stationing.winner}
      currentTeam={currentTeam}
      candidates={stationing.candidates}
      selectedUnitIds={stationing.selectedUnitIds}
      onToggle={(unitId) => dispatch({ type: 'stationingToggle', unitId })}
      onConfirm={() => dispatch({ type: 'stationingCommit' })}
      error={error}
    />
  ) : shot?.ok && shot.status !== 'complete' ? (
    <FreeShotPanel
      prompt={shot}
      currentTeam={currentTeam}
      actors={shotActorLabels(game)}
      onSelectTarget={(targetId) => dispatch({ type: 'freeShotTarget', targetId })}
      onResolve={() => dispatch({ type: 'freeShotResolve' })}
      error={error}
    />
  ) : null;
  if (!panel) return null;

  return (
    <div className="fixed inset-0 z-20 bg-[hsl(var(--background)/0.86)] p-4 flex items-center justify-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Campaign decision"
        className="w-full max-w-[600px] max-h-[90dvh] overflow-y-auto border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-4 flex flex-col gap-3"
      >
        {panel}
        <div className="border-t border-[hsl(var(--border-bright))] pt-3 flex flex-wrap items-center gap-2">
          <SaveMenu />
          <Button variant="ghost" onClick={saveAndQuit}>
            Save &amp; Quit
          </Button>
        </div>
      </div>
    </div>
  );
}

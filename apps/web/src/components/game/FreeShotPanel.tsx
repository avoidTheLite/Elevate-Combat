import type { FreeShotPrompt, Team } from '@iron-ridge/engine';
import { TEAM_NAME } from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';

export type PendingFreeShotPrompt = Extract<
  FreeShotPrompt,
  { status: 'choose-target' | 'selected' }
>;

export interface FreeShotActorLabel {
  label: string;
  detail?: string;
}

export interface FreeShotPanelProps {
  prompt: PendingFreeShotPrompt;
  currentTeam: Team | null;
  actors: Readonly<Record<string, FreeShotActorLabel>>;
  onSelectTarget: (targetId: string) => void;
  onResolve: () => void;
  busy?: boolean;
  error?: string | null;
}

/** The queue, legal targets and saved selection are authoritative engine outputs. */
export function FreeShotPanel({
  prompt,
  currentTeam,
  actors,
  onSelectTarget,
  onResolve,
  busy = false,
  error,
}: FreeShotPanelProps): React.ReactElement {
  const ownsShot = currentTeam === prompt.team;
  const canChoose = ownsShot && !busy && prompt.status === 'choose-target';
  const canFire = ownsShot && !busy && prompt.status === 'selected' && prompt.selection !== null;
  const selectedTarget = prompt.selection?.request.targetId ?? null;
  return (
    <div role="region" aria-label="Garrison free shot" aria-busy={busy}>
      <Panel title="GARRISON FREE SHOT" right={TEAM_NAME[prompt.team]}>
        <Stat label="Garrison" value={actors[prompt.shooterId]?.label ?? prompt.shooterId} />
        <p className="text-xs">
          {prompt.trigger === 'strategic-after-income'
            ? 'Choose an enemy commander in firing range.'
            : 'Choose an enemy deployed in firing range before tactical turns begin.'}{' '}
          This shot uses the garrison’s shared free-shot allowance and leaves its normal tactical
          actions available.
        </p>
        <div className="flex flex-col gap-2" aria-label="Free-shot targets">
          {prompt.targetIds.map((targetId) => (
            <Button
              key={targetId}
              variant={selectedTarget === targetId ? 'default' : 'ghost'}
              className="justify-between text-left"
              aria-pressed={selectedTarget === targetId}
              disabled={!canChoose}
              onClick={() => onSelectTarget(targetId)}
            >
              <span>{actors[targetId]?.label ?? targetId}</span>
              {actors[targetId]?.detail && (
                <span className="text-[10px]">{actors[targetId].detail}</span>
              )}
            </Button>
          ))}
        </div>
        {!ownsShot && (
          <p className="text-xs">Waiting for {TEAM_NAME[prompt.team]} to choose a target.</p>
        )}
        {error && (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {error}
          </p>
        )}
        <Button
          disabled={!canFire}
          onClick={() => {
            if (canFire) onResolve();
          }}
        >
          {busy ? 'Resolving shot…' : 'Fire free shot'}
        </Button>
      </Panel>
    </div>
  );
}

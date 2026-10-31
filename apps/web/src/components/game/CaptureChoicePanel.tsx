import { useId } from 'react';
import type { FoundationCaptureBatch, FoundationCaptureOutcome, Team } from '@iron-ridge/engine';
import {
  currentFoundationCaptureChoices,
  TEAM_NAME,
  validateFoundationCaptureCosts,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';

export interface CaptureChoicePanelProps {
  batch: FoundationCaptureBatch | null;
  currentTeam: Team;
  commandPoints: number;
  onSelect: (nodeId: string, outcome: FoundationCaptureOutcome) => void;
  onConfirm: (batchId: string) => void;
  nodeLabels?: Readonly<Record<string, string>>;
  busy?: boolean;
  error?: string;
}

const PHASE_EXPLANATION: Record<FoundationCaptureBatch['event']['kind'], string> = {
  'turn-start-after-income':
    'Income has already resolved. Capture grants building work for this turn: one ordinary operation, up to two with an eligible engineer. It grants no income, deployment or resupply this turn.',
  'manual-battle-end':
    'After this battle, Capture updates network benefits for later actions. It grants no building work, income, deployment or resupply this turn.',
  'strategic-movement':
    'After movement, Capture updates network benefits for later actions. It grants no building work, income, deployment or resupply this turn.',
};

/**
 * Controlled review surface: the controller owns choices, authoritative prices and atomic commit.
 * No option is selected automatically, and this component never mutates a game or grants rewards.
 */
export function CaptureChoicePanel({
  batch,
  currentTeam,
  commandPoints,
  onSelect,
  onConfirm,
  nodeLabels,
  busy = false,
  error,
}: CaptureChoicePanelProps): React.ReactElement | null {
  const summaryId = useId();
  const phaseId = useId();
  if (batch === null) return null;

  const choices = new Map(
    currentFoundationCaptureChoices(batch).map((choice) => [
      choice.request.nodeId,
      choice.request.outcome,
    ]),
  );
  const pricingValid = validateFoundationCaptureCosts(batch.costs) === null;
  const budgetValid = Number.isSafeInteger(commandPoints) && commandPoints >= 0;
  const selectedCount = batch.candidates.filter(({ node }) => choices.has(node.id)).length;
  const totalCost = pricingValid
    ? batch.candidates.reduce((sum, { node }) => {
        const outcome = choices.get(node.id);
        return sum + (outcome ? batch.costs[outcome] : 0);
      }, 0)
    : null;
  const safeTotal = totalCost !== null && Number.isSafeInteger(totalCost);
  const minimumCost = pricingValid ? batch.costs.raze * batch.candidates.length : null;
  const noAffordableSet =
    budgetValid &&
    minimumCost !== null &&
    (!Number.isSafeInteger(minimumCost) || minimumCost > commandPoints);
  const affordable = budgetValid && safeTotal && totalCost <= commandPoints;
  const allSelected = batch.candidates.length > 0 && selectedCount === batch.candidates.length;
  const ownsBatch = currentTeam === batch.team;
  const canConfirm = ownsBatch && !busy && allSelected && affordable;
  const canChoose = ownsBatch && !busy && pricingValid && budgetValid;

  return (
    <div role="region" aria-label="Capture or Raze" aria-describedby={phaseId} aria-busy={busy}>
      <Panel title="CAPTURE OR RAZE" right={TEAM_NAME[batch.team]}>
        <p id={phaseId} className="text-xs text-[hsl(var(--foreground))]">
          {PHASE_EXPLANATION[batch.event.kind]}
        </p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Capture takes control of surviving buildings. Raze damages buildings and leaves the node
          unowned; troops stay in place. Raze costs CP and uses no node work.
        </p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Choose independently for each node. You can change any choice before confirming. All
          choices take effect together.
        </p>

        {batch.candidates.map(({ node }) => {
          const name = nodeLabels?.[node.id] ?? node.id;
          const selected = choices.get(node.id);
          return (
            <fieldset key={node.id} className="border border-[hsl(var(--border))] p-2">
              <legend className="px-1 text-xs text-[hsl(var(--primary))]">{name}</legend>
              <p className="mb-2 text-[11px] text-[hsl(var(--muted-foreground))]">
                MainHex {node.mainHex}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  aria-label={`Capture ${name}${pricingValid ? ` (${batch.costs.capture} CP)` : ''}`}
                  aria-pressed={selected === 'capture'}
                  disabled={!canChoose}
                  className={selected === 'capture' ? 'bg-[hsl(var(--primary)/0.15)]' : undefined}
                  onClick={() => onSelect(node.id, 'capture')}
                >
                  Capture · {pricingValid ? `${batch.costs.capture} CP` : 'cost unavailable'}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  aria-label={`Raze ${name}${pricingValid ? ` (${batch.costs.raze} CP)` : ''}`}
                  aria-pressed={selected === 'raze'}
                  disabled={!canChoose}
                  className={selected === 'raze' ? 'bg-[hsl(var(--destructive)/0.15)]' : undefined}
                  onClick={() => onSelect(node.id, 'raze')}
                >
                  Raze · {pricingValid ? `${batch.costs.raze} CP` : 'cost unavailable'}
                </Button>
              </div>
              <p className="mt-2 text-xs">
                Choice:{' '}
                {selected === 'capture' ? 'Capture' : selected === 'raze' ? 'Raze' : 'Not chosen'}
              </p>
            </fieldset>
          );
        })}

        <div id={summaryId} role="status" aria-live="polite" aria-atomic="true">
          <Stat label="Choices" value={`${selectedCount}/${batch.candidates.length}`} />
          <Stat label="Available CP" value={budgetValid ? commandPoints : 'Unavailable'} />
          <Stat label="Selected cost" value={safeTotal ? `${totalCost} CP` : 'Unavailable'} />
          <Stat
            label="CP after confirmation"
            value={affordable ? commandPoints - totalCost : '—'}
          />
        </div>

        {(!pricingValid || !safeTotal || !budgetValid) && (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            Costs or available CP are unavailable. Confirmation is paused.
          </p>
        )}
        {noAffordableSet ? (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            There is no affordable complete selection with {commandPoints} CP. These choices remain
            pending.
          </p>
        ) : budgetValid && safeTotal && !affordable ? (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            Selected choices need {totalCost - commandPoints} more CP. Change your choices before
            confirming.
          </p>
        ) : null}
        {!ownsBatch && (
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Waiting for {TEAM_NAME[batch.team]} to resolve these choices.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {error}
          </p>
        )}
        <Button
          type="button"
          disabled={!canConfirm}
          aria-describedby={summaryId}
          onClick={() => {
            if (canConfirm) onConfirm(batch.request.requestId);
          }}
        >
          {busy ? 'Confirming choices…' : 'Confirm all choices'}
        </Button>
      </Panel>
    </div>
  );
}

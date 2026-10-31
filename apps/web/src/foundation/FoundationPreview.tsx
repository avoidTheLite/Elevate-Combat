import { useState } from 'react';
import {
  chooseFoundationCapture,
  commitFoundationCapture,
  validateFoundationCaptureState,
} from '@iron-ridge/engine';
import type {
  FoundationCaptureEvent,
  FoundationCaptureOutcome,
  FoundationCaptureState,
} from '@iron-ridge/engine';
import { CaptureChoicePanel } from '../components/game/CaptureChoicePanel.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Panel, Stat } from '../components/ui/Panel.tsx';
import {
  capturePreviewControl,
  createCapturePreview,
  PREVIEW_LABELS,
  PREVIEW_TURN,
} from './previewFixture.ts';

export function FoundationPreview(): React.ReactElement {
  const [event, setEvent] = useState<FoundationCaptureEvent['kind']>('manual-battle-end');
  const [state, setState] = useState(() => createCapturePreview('manual-battle-end'));
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState('');
  const control = capturePreviewControl(state, event);

  function select(nodeId: string, outcome: FoundationCaptureOutcome): void {
    if (!state.pending) return;
    const result = chooseFoundationCapture(state, {
      requestId: `preview-choice-${state.version}`,
      expectedVersion: state.version,
      batchId: state.pending.request.requestId,
      nodeId,
      outcome,
    });
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError('');
    setState(result.state);
  }

  function confirm(batchId: string): void {
    const result = commitFoundationCapture(
      state,
      {
        requestId: 'preview-commit',
        expectedVersion: state.version,
        batchId,
      },
      { snapshotVersion: state.version, ownerTurn: PREVIEW_TURN },
    );
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError('');
    setState(result.state);
  }

  function reset(nextEvent = event): void {
    setEvent(nextEvent);
    setState(createCapturePreview(nextEvent));
    setError('');
  }

  function restore(): void {
    if (!saved) return;
    const parsed: FoundationCaptureState = JSON.parse(saved);
    const problem = validateFoundationCaptureState(parsed);
    if (problem) {
      setError(problem);
      return;
    }
    setState(parsed);
    const restoredEvent = parsed.pending?.event.kind ?? parsed.receipts[0]?.batch.event.kind;
    if (restoredEvent) setEvent(restoredEvent);
    setError('');
  }

  return (
    <main className="mx-auto max-w-5xl p-5 flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl tracking-widest text-glow">STRATEGIC INFRASTRUCTURE</h1>
        <p className="text-sm">
          Choose the fate of two enemy nodes, then commit both outcomes together.
        </p>
        <p className="text-xs text-[hsl(var(--warning))]">
          Interactive review fixture: 10 CP, Capture 7 CP, Raze 3 CP. These example prices are not
          final balance values.
        </p>
      </header>
      <Panel title="CAPTURE TIMING">
        <label className="text-xs flex gap-3 items-center">
          Scenario
          <select
            className="bg-[hsl(var(--muted))] border p-1"
            value={event}
            onChange={(e) => reset(e.target.value as FoundationCaptureEvent['kind'])}
          >
            <option value="manual-battle-end">Manual battle ended</option>
            <option value="turn-start-after-income">Turn start, after income</option>
            <option value="strategic-movement">Later strategic movement</option>
          </select>
        </label>
        <p className="text-xs">
          {event === 'manual-battle-end'
            ? 'Both garrisons are defeated and your survivors hold the centers. Enemy field troops remain: capture can transfer the node while territory remains contested.'
            : 'No enemy troops remain in these MainHexes. Your commanders meet the capture position requirement.'}
        </p>
      </Panel>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          {state.nodes.map((node) => {
            const cell = control[node.mainHex];
            const ledger = state.work.nodeSpending.find((entry) => entry.nodeId === node.id);
            return (
              <Panel key={node.id} title={PREVIEW_LABELS[node.id as keyof typeof PREVIEW_LABELS]}>
                <Stat label="Node owner" value={node.owner ?? 'Unowned'} />
                <Stat label="Territorial claim" value={cell.claim ?? 'None'} />
                <Stat label="Troop presence" value={cell.presentTeams.join(' + ')} />
                <Stat label="Contested" value={cell.contested ? 'Yes' : 'No'} />
                <Stat label="Center" value={node.buildings[0].ruined ? 'Ruined' : 'Intact'} />
                <Stat
                  label="Building window"
                  value={ledger?.buildingWindow ?? 'No new allowance'}
                />
              </Panel>
            );
          })}
          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={() => {
                setSaved(JSON.stringify(state));
                setError('');
              }}
            >
              Save review state
            </Button>
            <Button disabled={!saved} onClick={restore}>
              Restore review state
            </Button>
            <Button variant="ghost" onClick={() => reset()}>
              Reset scenario
            </Button>
          </div>
          {saved && (
            <p role="status" className="text-xs">
              Review snapshot saved.
            </p>
          )}
        </div>
        <div>
          {state.pending ? (
            <CaptureChoicePanel
              batch={state.pending}
              currentTeam="A"
              commandPoints={state.work.commandPoints.A}
              onSelect={select}
              onConfirm={confirm}
              error={error}
              nodeLabels={PREVIEW_LABELS}
            />
          ) : (
            <Panel title="OUTCOMES COMMITTED">
              <Stat label="CP remaining" value={state.work.commandPoints.A} />
              <p role="status" className="text-xs">
                Both choices committed atomically. No income, deployment or resupply was granted by
                this capture.
              </p>
              <p className="text-xs">
                {event === 'turn-start-after-income'
                  ? 'Captured nodes have their ordinary building point, with an engineer enabling a second operation.'
                  : 'Captured nodes receive no building operations this turn. Network effects can update for later actions.'}
              </p>
            </Panel>
          )}
        </div>
      </div>
    </main>
  );
}

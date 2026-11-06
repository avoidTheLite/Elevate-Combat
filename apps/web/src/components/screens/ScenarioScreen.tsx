import { useState } from 'react';
import type { Era } from '@iron-ridge/engine';
import { DEFAULT_CAMPAIGN_PRICES, serializeSave } from '@iron-ridge/engine';
import {
  FOUNDATION_DEMO_SCENARIOS,
  createFoundationDemoScenario,
  foundationDemoFocus,
} from '../../foundation/demoScenarios.ts';
import type { FoundationDemoScenarioId } from '../../foundation/demoScenarios.ts';
import { regularPlaytestSettings } from '../../lib/campaignScenarios.ts';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';

export function ScenarioScreen({ onHome }: { onHome: () => void }): React.ReactElement {
  const [scenario, setScenario] = useState<FoundationDemoScenarioId | 'ready-regular'>(
    'ready-regular',
  );
  const [era, setEra] = useState<Era>('ww2');
  const [commanderPrice, setCommanderPrice] = useState(
    String(DEFAULT_CAMPAIGN_PRICES.commanderTraining),
  );
  const [capturePrice, setCapturePrice] = useState(String(DEFAULT_CAMPAIGN_PRICES.captureNode));
  const [razePrice, setRazePrice] = useState(String(DEFAULT_CAMPAIGN_PRICES.razeNode));
  const [error, setError] = useState<string | null>(null);
  const commander = Number(commanderPrice),
    capture = Number(capturePrice),
    raze = Number(razePrice);
  const ready = scenario === 'ready-regular';
  const valid =
    ready ||
    ([commander, capture, raze].every((value) => Number.isSafeInteger(value) && value > 0) &&
      capture > raze);
  const start = (): void => {
    try {
      const store = useGameStore.getState();
      if (scenario === 'ready-regular') store.newGame(regularPlaytestSettings());
      else {
        const game = createFoundationDemoScenario(scenario, capture, raze, era, commander);
        if (store.importSave(serializeSave(game, `Prepared demo: ${scenario}`)))
          store.setUi(foundationDemoFocus(game));
        else setError(store.loadError ?? 'Scenario could not start.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Scenario could not start.');
    }
  };
  return (
    <div className="min-h-screen flex flex-col items-center gap-5 p-4 py-8 scanlines">
      <header className="w-full max-w-[680px] flex justify-between items-center gap-3">
        <h1 className="text-xl tracking-widest text-glow">PLAY SCENARIO</h1>
        <Button variant="ghost" onClick={onHome}>
          ← HOME
        </Button>
      </header>
      <main className="w-full max-w-[680px] border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-4 flex flex-col gap-4">
        <p className="text-[11px] leading-4">
          Choose a prepared scenario. Each scenario declares the map and rules it fixes before you
          start.
        </p>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs mb-2">SCENARIO</legend>
          <Button
            variant={ready ? 'default' : 'ghost'}
            aria-pressed={ready}
            onClick={() => setScenario('ready-regular')}
          >
            READY REGULAR CAMPAIGN
          </Button>
          {FOUNDATION_DEMO_SCENARIOS.filter((entry) => entry.value !== 'standard').map((entry) => (
            <div
              key={entry.value}
              className="border border-[hsl(var(--border))] p-3 flex flex-col gap-2"
            >
              <Button
                variant={scenario === entry.value ? 'default' : 'ghost'}
                aria-pressed={scenario === entry.value}
                onClick={() => setScenario(entry.value as FoundationDemoScenarioId)}
              >
                {entry.label}
              </Button>
              <p className="text-[11px] leading-4">{entry.description}</p>
            </div>
          ))}
        </fieldset>
        {ready ? (
          <section aria-label="Scenario rules" className="text-[11px] leading-5">
            <h2 className="text-xs tracking-widest">READY REGULAR · FIXED CAMPAIGN SETTINGS</h2>
            <p>
              Generated WW2 campaign · Human Alpha vs AI Bravo · fog on · 7×5 map, radius 4 ·
              terrain seed 20261101 · Advanced nodes, 3 non-HQ objectives + 2 HQs · node seed 4277.
            </p>
            <p>
              Capture 5 CP · Raze 2 CP · commander training 15 CP · battle round limit 10 ·
              tentative combat profile · multi-commander engagements enabled. Ordinary starting
              forces and income apply. This scenario uses its own rules; applied or draft Balance
              Lab tuning is not added.
            </p>
            <p>
              To change these settings first, use Home → Create Campaign → Ready Regular preset.
            </p>
          </section>
        ) : (
          <>
            <section aria-label="Scenario rules" className="text-[11px] leading-5">
              <h2 className="text-xs tracking-widest">FOUNDATION SCENARIO · FIXED RULES</h2>
              <p>
                Prepared positions · 3×3 map, radius 2 · terrain seed 1 · simple nodes · fog off ·
                two human players · baseline combat rules · standard engagements. Applied or draft
                Balance Lab tuning is not added. Infrastructure is activated and built through
                normal actions; CP comes from normal income. No battle result is awarded.
              </p>
              <p>
                Your era and all three CP prices below are kept exactly. Commander training uses the
                entered price, including scenario preparation.
              </p>
            </section>
            <label className="flex flex-col gap-1 text-[11px]">
              ERA
              <select
                aria-label="Scenario era"
                value={era}
                onChange={(event) => setEra(event.target.value as Era)}
                className="bg-[hsl(var(--panel))] border border-[hsl(var(--border-bright))] p-2"
              >
                <option value="ww2">WW2</option>
                <option value="medieval">MEDIEVAL</option>
              </select>
            </label>
            {[
              {
                label: 'Commander training price (CP)',
                value: commanderPrice,
                change: setCommanderPrice,
              },
              { label: 'Capture Node price (CP)', value: capturePrice, change: setCapturePrice },
              { label: 'Raze Node price (CP)', value: razePrice, change: setRazePrice },
            ].map((field) => (
              <label key={field.label} className="text-[11px] flex flex-col gap-1">
                {field.label}
                <input
                  aria-label={field.label}
                  type="number"
                  min={1}
                  step={1}
                  value={field.value}
                  onChange={(event) => field.change(event.target.value)}
                  required
                  className="w-full bg-transparent border border-[hsl(var(--border-bright))] p-1"
                />
              </label>
            ))}
            {!valid && (
              <p className="text-[11px]">
                Enter positive whole CP prices, with Raze lower than Capture.
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {error}
          </p>
        )}
        <Button size="lg" onClick={start} disabled={!valid}>
          START SCENARIO
        </Button>
      </main>
    </div>
  );
}

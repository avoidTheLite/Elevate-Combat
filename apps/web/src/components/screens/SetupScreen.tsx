import { useEffect, useState } from 'react';
import { configurationDocument, parseCampaignConfiguration } from '../../lib/campaignScenarios.ts';
import type { Controller, Era, GameSettings } from '@iron-ridge/engine';
import {
  GRID_LIMITS,
  EXPERIMENTAL_ENGAGEMENT_PROFILE,
  clusterSize,
  createFoundationPlaytestConfiguration,
  defaultSettings,
  serializeSave,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import type { SetupSelection } from '../../balance/store.ts';
import { newCampaignProblem, useBalanceStore, withActiveRules } from '../../balance/store.ts';
import { LabEntry } from '../balance/LabEntry.tsx';
import { LoadList } from './LoadList.tsx';
import {
  FOUNDATION_DEMO_SCENARIOS,
  createFoundationDemoScenario,
  foundationDemoFocus,
} from '../../foundation/demoScenarios.ts';
import type { FoundationDemoSelection } from '../../foundation/demoScenarios.ts';

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  hint?: string;
}): React.ReactElement {
  const id = `f-${props.label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-[11px]">
      <span className="text-[hsl(var(--muted-foreground))] tracking-widest">{props.label}</span>
      <div className="flex items-center gap-2">
        <input
          id={id}
          aria-label={props.label}
          type="range"
          min={props.min}
          max={props.max}
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))}
          className="flex-1 accent-[hsl(var(--primary))]"
        />
        <span className="w-8 text-right text-[hsl(var(--primary))] font-bold">{props.value}</span>
      </div>
      {props.hint && (
        <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{props.hint}</span>
      )}
    </label>
  );
}

function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): React.ReactElement {
  return (
    <fieldset className="min-w-0 flex flex-col gap-1 text-[11px]">
      <legend className="text-[hsl(var(--muted-foreground))] tracking-widest">{props.label}</legend>
      <div className="flex gap-1 flex-wrap">
        {props.options.map((o) => (
          <Button
            key={o.value}
            size="sm"
            variant={props.value === o.value ? 'default' : 'ghost'}
            onClick={() => props.onChange(o.value)}
            aria-pressed={props.value === o.value}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

type Mode = 'ai' | 'hotseat' | 'spectate';
type CampaignMode = 'classic' | 'simple' | 'advanced';

export function SetupScreen(): React.ReactElement {
  const newGame = useGameStore((s) => s.newGame);
  const importSave = useGameStore((s) => s.importSave);
  const loadSaved = useGameStore((s) => s.loadSaved);
  useGameStore((s) => s.saveRev); // re-render when a slot changes (CONTINUE visibility)
  const hasSave = useGameStore((s) => s.hasSave)();
  const [restored] = useState(() => useBalanceStore.getState().setupSelection);
  useEffect(() => {
    useBalanceStore.getState().clearSetupSelection();
  }, []);
  const [settings, setSettings] = useState<GameSettings>(restored?.settings ?? defaultSettings());
  const [mode, setMode] = useState<Mode>(restored?.mode ?? 'ai');
  const [campaignMode, setCampaignMode] = useState<CampaignMode>(
    restored?.campaignMode ?? 'classic',
  );
  const [demoScenario, setDemoScenario] = useState<FoundationDemoSelection>('standard');
  const [demoError, setDemoError] = useState<string | null>(null);
  const [commanderPrice, setCommanderPrice] = useState(restored?.commanderPrice ?? '');
  const commanderCp = Number(commanderPrice);
  const validCommanderPrice =
    commanderPrice.trim() !== '' && Number.isSafeInteger(commanderCp) && commanderCp > 0;
  const [additionalNodes, setAdditionalNodes] = useState(restored?.additionalNodes ?? 16);
  const [capturePrice, setCapturePrice] = useState(restored?.capturePrice ?? '');
  const [razePrice, setRazePrice] = useState(restored?.razePrice ?? '');
  const captureCp = Number(capturePrice);
  const razeCp = Number(razePrice);
  const validPrices =
    capturePrice.trim() !== '' &&
    razePrice.trim() !== '' &&
    Number.isSafeInteger(captureCp) &&
    Number.isSafeInteger(razeCp) &&
    razeCp > 0 &&
    captureCp > razeCp;
  const setupProblem = !validCommanderPrice
    ? 'Enter a positive whole commander training CP price in setup before starting a game.'
    : campaignMode !== 'classic' && !validPrices
      ? 'The selected infrastructure mode needs positive whole Capture/Raze CP prices, with Raze lower than Capture.'
      : null;
  const canStart = setupProblem === null;
  const selection = (): SetupSelection => ({
    settings,
    mode,
    campaignMode,
    additionalNodes,
    commanderPrice,
    capturePrice,
    razePrice,
  });
  const prepared = demoScenario !== 'standard';
  const maximumAdditionalNodes = settings.grid.mainCols * settings.grid.mainRows - 3;
  const advancedCount = Math.min(additionalNodes, maximumAdditionalNodes);

  const g = settings.grid;
  const perMain = clusterSize(g.subRadius);
  const total = perMain * g.mainCols * g.mainRows;
  const setGrid = (patch: Partial<GameSettings['grid']>): void =>
    setSettings({ ...settings, grid: { ...settings.grid, ...patch } });

  const configured = (): GameSettings | null => {
    if (!canStart) return null;
    const controllers: Record<'A' | 'B', Controller> =
      mode === 'ai'
        ? { A: 'human', B: 'ai' }
        : mode === 'hotseat'
          ? { A: 'human', B: 'human' }
          : { A: 'ai', B: 'ai' };
    const candidate: GameSettings = {
      ...settings,
      controllers,
      ...(validCommanderPrice ? { commanderTrainingCp: commanderCp } : {}),
      ...(campaignMode !== 'classic' && validPrices
        ? {
            infrastructure: {
              ...createFoundationPlaytestConfiguration(captureCp, razeCp),
              nodes: {
                ...createFoundationPlaytestConfiguration(captureCp, razeCp).nodes,
                placement:
                  campaignMode === 'advanced'
                    ? {
                        mode: 'advanced' as const,
                        seed: settings.seed,
                        additionalNodes: advancedCount,
                      }
                    : { mode: 'simple' as const },
              },
            },
          }
        : {}),
    };
    return newCampaignProblem(candidate) ? null : candidate;
  };
  // Balance-lab overrides (if applied) ride along in settings.rules.
  const start = (): void => {
    const setup = configured();
    if (!setup) return;
    setDemoError(null);
    if (prepared) {
      try {
        const game = createFoundationDemoScenario(
          demoScenario,
          captureCp,
          razeCp,
          settings.era,
          commanderCp,
        );
        if (importSave(serializeSave(game, `Prepared demo: ${demoScenario}`)))
          useGameStore.getState().setUi(foundationDemoFocus(game));
      } catch (error) {
        setDemoError(error instanceof Error ? error.message : 'Prepared demo could not start');
      }
    } else newGame(withActiveRules(setup));
  };

  const exportConfiguration = (): void => {
    const setup = configured();
    if (!setup) return;
    const blob = new Blob(
      [JSON.stringify(configurationDocument(withActiveRules(setup)), null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'iron-ridge-campaign-configuration.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  const loadConfiguration = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('Configuration file is too large (maximum 2 MB)');
      newGame(parseCampaignConfiguration(await file.text()));
    } catch (error) {
      setDemoError(error instanceof Error ? error.message : 'Could not start configuration');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-4 scanlines">
      <div className="text-center">
        <div className="text-3xl font-bold tracking-[0.4em] text-glow">▲ IRON RIDGE</div>
        <div className="text-[hsl(var(--muted-foreground))] text-xs tracking-widest mt-1">
          // TRAINING SIMULATION :: V1.0 :: STRATEGIC + TACTICAL
        </div>
      </div>

      <div className="w-full max-w-[560px] border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-4 flex flex-col gap-4">
        <div className="text-[11px] text-[hsl(var(--primary))] tracking-widest">
          [ NEW CAMPAIGN ]
        </div>

        <Choice<Era>
          label="ERA"
          value={settings.era}
          options={[
            { value: 'ww2', label: 'WW2' },
            { value: 'medieval', label: 'MEDIEVAL' },
          ]}
          onChange={(era) => setSettings({ ...settings, era })}
        />
        {!prepared && (
          <Choice<Mode>
            label="OPPONENT"
            value={mode}
            options={[
              { value: 'ai', label: 'VS AI' },
              { value: 'hotseat', label: 'HOTSEAT 2P' },
              { value: 'spectate', label: 'AI vs AI' },
            ]}
            onChange={setMode}
          />
        )}

        {!prepared && (
          <fieldset className="flex flex-col gap-1 text-[11px]">
            <legend className="text-[hsl(var(--muted-foreground))] tracking-widest">
              ENGAGEMENT RULES
            </legend>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                aria-label="Experimental multi-commander engagements"
                checked={settings.engagement?.profile === 'multi-commander-v1'}
                onChange={(event) => {
                  const { engagement: _previous, ...rest } = settings;
                  void _previous;
                  setSettings(
                    event.target.checked
                      ? { ...rest, engagement: { ...EXPERIMENTAL_ENGAGEMENT_PROFILE } }
                      : rest,
                  );
                }}
                className="accent-[hsl(var(--primary))]"
              />
              <span>Experimental multi-commander engagements</span>
            </label>
            <p className="text-[10px] leading-4 text-[hsl(var(--muted-foreground))]">
              Choose each side’s commanders before deployment. Trial attack price: 5 CP plus 2 per
              additional attacker. Initial defense is free; each additional defender costs 2 CP.
              Additional commanders keep their position and movement; their units deploy around
              their own commander. Move before engaging to reposition a zone. These trial prices are
              separate from new commander training.
            </p>
          </fieldset>
        )}

        <Choice<CampaignMode>
          label="INFRASTRUCTURE"
          value={campaignMode}
          options={[
            { value: 'classic', label: 'CLASSIC' },
            { value: 'simple', label: 'SIMPLE NODES' },
            { value: 'advanced', label: 'ADVANCED SEEDED NODES' },
          ]}
          onChange={(value) => {
            setCampaignMode(value);
            setDemoScenario('standard');
          }}
        />
        <p className="text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
          {campaignMode === 'classic'
            ? 'Classic: HQ recruitment and territory fortification. No infrastructure nodes, node buildings or supply network.'
            : campaignMode === 'simple'
              ? 'Simple: one seven-tile node site in every MainHex. Select your HQ or any node in game to activate, build, upgrade and repair.'
              : 'Advanced: nodes on a seeded selection of MainHexes, including both Home HQs. Other MainHexes retain territory and movement rules.'}
        </p>
        <label className="text-[11px] flex flex-col gap-1">
          <span>Commander training price (CP)</span>
          <input
            aria-label="Commander training price (CP)"
            aria-describedby="commander-price-hint"
            type="number"
            min="1"
            step="1"
            value={commanderPrice}
            onChange={(event) => setCommanderPrice(event.target.value)}
            required
            className="w-full bg-transparent border border-[hsl(var(--border-bright))] p-1"
          />
          <span
            id="commander-price-hint"
            className="text-[10px] text-[hsl(var(--muted-foreground))]"
          >
            Enter a positive whole CP price for each NEW COMMANDER order, including splits. No
            balance price is preselected.
          </span>
        </label>
        {campaignMode === 'advanced' && !prepared && (
          <NumberField
            label="NON-HQ NODES"
            value={advancedCount}
            min={0}
            max={maximumAdditionalNodes}
            onChange={setAdditionalNodes}
            hint={`${advancedCount + 2} nodes total; both Home HQs are guaranteed. Map seed controls placement.`}
          />
        )}
        {campaignMode !== 'classic' && (
          <div className="border border-[hsl(var(--border-bright))] p-3 flex flex-col gap-3">
            <p className="text-[11px] text-[hsl(var(--warning))] leading-4">
              Playtest nodes, supply and stationed garrisons with provisional balance values. Choose
              the CP prices for Capture Node and Raze Node; Raze Node must be cheaper. Do nothing
              remains free.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-[11px] flex flex-col gap-1">
                <span>Capture Node price (CP)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={capturePrice}
                  onChange={(event) => setCapturePrice(event.target.value)}
                  className="w-full bg-transparent border border-[hsl(var(--border-bright))] p-1"
                  required
                />
              </label>
              <label className="text-[11px] flex flex-col gap-1">
                <span>Raze Node price (CP)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={razePrice}
                  onChange={(event) => setRazePrice(event.target.value)}
                  className="w-full bg-transparent border border-[hsl(var(--border-bright))] p-1"
                  required
                />
              </label>
            </div>
            {!validPrices && (
              <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                Enter positive whole CP prices, with Raze Node lower than Capture Node, to start
                this playtest.
              </p>
            )}
          </div>
        )}

        <div className="border border-[hsl(var(--border))] p-3 flex flex-col gap-2">
          <Choice<FoundationDemoSelection>
            label="TEAM SCENARIOS"
            value={demoScenario}
            options={FOUNDATION_DEMO_SCENARIOS}
            onChange={(value) => {
              setDemoScenario(value);
              if (value !== 'standard') setCampaignMode('simple');
            }}
          />
          <p className="text-[11px] leading-4">
            {
              FOUNDATION_DEMO_SCENARIOS.find((scenario) => scenario.value === demoScenario)
                ?.description
            }
          </p>
          {prepared && (
            <p className="text-[10px] text-[hsl(var(--warning))] leading-4">
              Prepared demo positions, not a completed campaign: 3×3 map, radius 2, seed 1, no fog
              and two human players. Infrastructure is activated and built through normal actions.
              CP comes from normal income; your prices are kept exactly. Commander training uses
              your CP price. Other tuning is playtest. Standard campaign keeps your map and opponent
              settings.
            </p>
          )}
        </div>

        {!prepared && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <NumberField
                label="MAIN COLS"
                value={g.mainCols}
                min={GRID_LIMITS.mainCols.min}
                max={GRID_LIMITS.mainCols.max}
                onChange={(v) => setGrid({ mainCols: v })}
              />
              <NumberField
                label="MAIN ROWS"
                value={g.mainRows}
                min={GRID_LIMITS.mainRows.min}
                max={GRID_LIMITS.mainRows.max}
                onChange={(v) => setGrid({ mainRows: v })}
              />
              <NumberField
                label="SUB-GRID RADIUS"
                value={g.subRadius}
                min={GRID_LIMITS.subRadius.min}
                max={GRID_LIMITS.subRadius.max}
                onChange={(v) => setGrid({ subRadius: v })}
              />
            </div>
            <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
              {g.mainCols}×{g.mainRows} main hexes · {perMain} sub-hexes each ·{' '}
              {total.toLocaleString()} tactical cells. Every main hex is a radius-{g.subRadius}{' '}
              cluster on one shared sub-hex lattice, so sub-hexes line up exactly across every
              main-hex border.
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <NumberField
                label="BATTLE ROUND LIMIT"
                value={settings.battleRounds}
                min={4}
                max={20}
                onChange={(v) => setSettings({ ...settings, battleRounds: v })}
              />
              <label className="flex flex-col gap-1 text-[11px]" htmlFor="f-seed">
                <span className="text-[hsl(var(--muted-foreground))] tracking-widest">
                  MAP SEED
                </span>
                <div className="flex gap-2">
                  <input
                    id="f-seed"
                    aria-label="MAP SEED"
                    type="number"
                    value={settings.seed}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        seed: Math.min(
                          0xffffffff,
                          Math.abs(Math.floor(Number(e.target.value) || 0)),
                        ),
                      })
                    }
                    className="min-w-0 flex-1 bg-transparent border border-[hsl(var(--border-bright))] px-2 py-1 text-[hsl(var(--primary))]"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setSettings({ ...settings, seed: Math.floor(Math.random() * 1e6) })
                    }
                  >
                    RANDOM
                  </Button>
                </div>
              </label>
            </div>

            <label className="flex items-center gap-2 text-[11px] cursor-pointer">
              <input
                type="checkbox"
                checked={settings.fog}
                onChange={(e) => setSettings({ ...settings, fog: e.target.checked })}
                className="accent-[hsl(var(--primary))]"
              />
              <span className="tracking-widest text-[hsl(var(--muted-foreground))]">
                FOG OF WAR (LOS-based spotting)
              </span>
            </label>
          </>
        )}

        {demoError && (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {demoError}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <Button size="lg" onClick={start} className="flex-1" disabled={!canStart}>
            START NEW GAME
          </Button>
          {hasSave && (
            <Button size="lg" variant="ghost" onClick={() => loadSaved()}>
              CONTINUE
            </Button>
          )}
        </div>
        {!prepared && (
          <Button variant="ghost" onClick={exportConfiguration} disabled={!canStart}>
            EXPORT NEW-RUN CONFIGURATION
          </Button>
        )}
        <label className="text-[11px] flex flex-col gap-2">
          <span>START FROM CUSTOM CONFIGURATION (.json)</span>
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Start from campaign configuration"
            className="w-full min-w-0 text-[10px]"
            onChange={(event) => {
              void loadConfiguration(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
            Starts a fresh run from the file's map, rules and CP prices. Export a configuration
            above to customize or share. To resume exact progress, use saved games below.
          </span>
        </label>
        {!prepared && (
          <LabEntry settings={configured} problem={setupProblem} selection={selection} />
        )}
      </div>

      <LoadList />

      <div className="text-[10px] text-[hsl(var(--muted-foreground))] max-w-[560px] text-center leading-4">
        Capture the enemy HQ. Move armies across the strategic hex map; attacking an occupied hex
        opens a tactical battle on the sub-hex grid of that hex and its neighbours. Elevation drives
        line of sight, movement and fire.
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { Controller, Era, GameSettings, RulesOverride } from '@iron-ridge/engine';
import {
  GRID_LIMITS,
  DEFAULT_CAMPAIGN_PRICES,
  EXPERIMENTAL_ENGAGEMENT_PROFILE,
  clusterSize,
  createFoundationPlaytestConfiguration,
  defaultSettings,
} from '@iron-ridge/engine';
import { configurationDocument, parseCampaignConfiguration } from '../../lib/campaignScenarios.ts';
import {
  applyPlayerPreset,
  builtInPresets,
  createPlayerPreset,
  loadPlayerPresets,
  parsePlayerPreset,
  persistPlayerPresets,
  PLAYER_PRESETS_LIMIT,
  selectionFromSettings,
} from '../../lib/playerPresets.ts';
import type { PlayerPreset, PresetScope } from '../../lib/playerPresets.ts';
import { Button } from '../ui/Button.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import type { SetupSelection } from '../../balance/store.ts';
import { newCampaignProblem, useBalanceStore, withActiveRules } from '../../balance/store.ts';
import { LabEntry } from '../balance/LabEntry.tsx';

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

type Mode = SetupSelection['mode'];
type CampaignMode = SetupSelection['campaignMode'];
type RuleSelection = SetupSelection & {
  ruleSource?: 'active' | 'snapshot';
  activeRulesAtOpen?: RulesOverride;
};

export function SetupScreen({ onHome }: { onHome?: () => void }): React.ReactElement {
  const newGame = useGameStore((s) => s.newGame);
  const activeRules = useBalanceStore((s) => s.active);
  const [restored] = useState(
    () => useBalanceStore.getState().setupSelection as RuleSelection | null,
  );
  useEffect(() => {
    useBalanceStore.getState().clearSetupSelection();
  }, []);
  const [settings, setSettings] = useState<GameSettings>(restored?.settings ?? defaultSettings());
  const [mode, setMode] = useState<Mode>(restored?.mode ?? 'ai');
  const [campaignMode, setCampaignMode] = useState<CampaignMode>(
    restored?.campaignMode ?? 'classic',
  );
  const [commanderPrice, setCommanderPrice] = useState(
    restored?.commanderPrice ?? String(DEFAULT_CAMPAIGN_PRICES.commanderTraining),
  );
  const [capturePrice, setCapturePrice] = useState(
    restored?.capturePrice ?? String(DEFAULT_CAMPAIGN_PRICES.captureNode),
  );
  const [razePrice, setRazePrice] = useState(
    restored?.razePrice ?? String(DEFAULT_CAMPAIGN_PRICES.razeNode),
  );
  const [additionalNodes, setAdditionalNodes] = useState(restored?.additionalNodes ?? 16);
  const [nodePlacementSeed, setNodePlacementSeed] = useState(
    restored?.nodePlacementSeed ?? settings.seed,
  );
  const [ruleSource, setRuleSource] = useState<'active' | 'snapshot'>(() =>
    restored?.ruleSource === 'snapshot' &&
    JSON.stringify(restored.activeRulesAtOpen) === JSON.stringify(activeRules)
      ? 'snapshot'
      : 'active',
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [builtins] = useState(builtInPresets);
  const [playerPresets, setPlayerPresets] = useState(loadPlayerPresets);
  const [presetId, setPresetId] = useState('builtin-ready-regular');
  const [presetName, setPresetName] = useState('');
  const [saveScope, setSaveScope] = useState<PresetScope>('campaign');
  const importedPlayers =
    mode === 'spectate' && settings.controllers.A === 'ai' && settings.controllers.B === 'human';
  const presets = [...builtins, ...playerPresets];
  const selectedPreset = presets.find((preset) => preset.id === presetId) ?? presets[0]!;
  const commanderCp = Number(commanderPrice),
    captureCp = Number(capturePrice),
    razeCp = Number(razePrice);
  const validCommanderPrice =
    commanderPrice.trim() !== '' && Number.isSafeInteger(commanderCp) && commanderCp > 0;
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
  const maximumAdditionalNodes = settings.grid.mainCols * settings.grid.mainRows - 3;
  const advancedCount = Math.min(additionalNodes, maximumAdditionalNodes);
  const g = settings.grid,
    perMain = clusterSize(g.subRadius),
    total = perMain * g.mainCols * g.mainRows;
  const setGrid = (patch: Partial<GameSettings['grid']>): void =>
    setSettings({ ...settings, grid: { ...settings.grid, ...patch } });

  const configured = (): GameSettings | null => {
    if (setupProblem) return null;
    const controllers: Record<'A' | 'B', Controller> = importedPlayers
      ? structuredClone(settings.controllers)
      : mode === 'ai'
        ? { A: 'human', B: 'ai' }
        : mode === 'hotseat'
          ? { A: 'human', B: 'human' }
          : { A: 'ai', B: 'ai' };
    const { infrastructure: previousInfrastructure, ...base } = settings;
    const infrastructure =
      campaignMode === 'classic'
        ? undefined
        : (previousInfrastructure ?? createFoundationPlaytestConfiguration(captureCp, razeCp));
    const candidate: GameSettings = {
      ...base,
      controllers,
      commanderTrainingCp: commanderCp,
      ...(infrastructure
        ? {
            infrastructure: {
              ...infrastructure,
              nodes: {
                ...infrastructure.nodes,
                captureCosts: { capture: captureCp, raze: razeCp },
                placement:
                  campaignMode === 'advanced'
                    ? {
                        mode: 'advanced' as const,
                        seed: nodePlacementSeed,
                        additionalNodes: advancedCount,
                      }
                    : { mode: 'simple' as const },
              },
            },
          }
        : {}),
    };
    const effective = ruleSource === 'active' ? withActiveRules(candidate) : candidate;
    return newCampaignProblem(effective) ? null : effective;
  };
  const selection = (): RuleSelection => ({
    settings,
    mode,
    campaignMode,
    additionalNodes,
    nodePlacementSeed,
    commanderPrice,
    capturePrice,
    razePrice,
    ruleSource,
    activeRulesAtOpen: structuredClone(activeRules),
  });
  const canStart = setupProblem === null && configured() !== null;
  const loadSelection = (next: SetupSelection): void => {
    setSettings(structuredClone(next.settings));
    setMode(next.mode);
    setCampaignMode(next.campaignMode);
    setAdditionalNodes(next.additionalNodes);
    setNodePlacementSeed(next.nodePlacementSeed ?? next.settings.seed);
    setCommanderPrice(next.commanderPrice);
    setCapturePrice(next.capturePrice);
    setRazePrice(next.razePrice);
    setError(null);
  };
  const applyPreset = (preset: PlayerPreset): void => {
    loadSelection(applyPlayerPreset(preset, selection()));
    if (preset.scope === 'campaign') setRuleSource('snapshot');
    setNotice(
      `${preset.name} applied. ${preset.scope === 'map' ? 'Era, opponent and independent rules retained.' : 'Campaign settings replaced.'} All settings remain editable.`,
    );
  };
  const savePreset = (): void => {
    const setup = configured();
    if (!setup) return;
    try {
      const snapshot: SetupSelection = {
        ...selection(),
        settings: setup,
        additionalNodes: advancedCount,
      };
      const preset = createPlayerPreset(saveScope, presetName, snapshot);
      const next = [...playerPresets, preset];
      persistPlayerPresets(next);
      setPlayerPresets(next);
      setPresetId(preset.id);
      setPresetName('');
      setError(null);
      setNotice(`${preset.name} saved in this browser as a ${saveScope} snapshot.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save preset');
    }
  };
  const deletePreset = (): void => {
    if (selectedPreset.builtin) return;
    try {
      const next = playerPresets.filter((preset) => preset.id !== selectedPreset.id);
      persistPlayerPresets(next);
      setPlayerPresets(next);
      setPresetId('builtin-ready-regular');
      setError(null);
      setNotice(`${selectedPreset.name} deleted. Current editable settings retained.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete preset');
    }
  };
  const exportConfiguration = (): void => {
    const setup = configured();
    if (!setup) return;
    const blob = new Blob([JSON.stringify(configurationDocument(setup), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = 'iron-ridge-campaign-configuration.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  const loadConfiguration = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('Configuration file is too large (maximum 2 MB)');
      const text = await file.text();
      const doc = JSON.parse(text) as { kind?: string };
      if (doc?.kind === 'iron-ridge-player-preset') applyPreset(parsePlayerPreset(text));
      else {
        loadSelection(selectionFromSettings(parseCampaignConfiguration(text)));
        setRuleSource('snapshot');
        setNotice('Configuration loaded for editing. Review the summary, then Start New Game.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load configuration');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center gap-5 p-4 py-8 scanlines">
      <div className="w-full max-w-[680px] flex justify-between items-center gap-3">
        <h1 className="text-xl tracking-widest text-glow">CREATE CAMPAIGN</h1>
        {onHome && (
          <Button variant="ghost" onClick={onHome}>
            ← HOME
          </Button>
        )}
      </div>
      <main className="w-full max-w-[680px] border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-4 flex flex-col gap-5">
        <section
          aria-label="Presets"
          className="border border-[hsl(var(--border-bright))] p-3 flex flex-col gap-3"
        >
          <h2 className="text-sm tracking-widest">PRESETS</h2>
          <label className="text-xs flex flex-col gap-2">
            Choose a preset
            <select
              aria-label="Choose a preset"
              value={selectedPreset.id}
              onChange={(event) => setPresetId(event.target.value)}
              className="w-full bg-[hsl(var(--panel))] border border-[hsl(var(--border-bright))] p-2"
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.scope === 'map' ? '▧ Map' : '◆ Campaign'} · {preset.name}
                  {preset.builtin ? ' · Built-in' : ' · Yours'}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11px] leading-4" data-testid="preset-scope">
            {selectedPreset.scope === 'map'
              ? '▧ Replaces Map: dimensions, terrain seed, infrastructure mode, node count, node seed and Capture/Raze CP. Retains Era, Opponent and independent rules, including fog.'
              : '◆ Replaces Campaign: Era, Opponent, Map and independent rules, including fog, commander CP and combat tuning.'}
          </p>
          {selectedPreset.id === 'builtin-ready-regular' && (
            <p className="text-[11px] leading-4">
              Ready Regular: generated WW2 campaign, 7×5 map, seed 20261101, two HQs and three extra
              objectives; separate node seed 4277. Trial combat profile and multi-commander
              engagements, Capture 5 CP, Raze 2 CP, commander training 15 CP.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => applyPreset(selectedPreset)}>APPLY PRESET</Button>
            {selectedPreset.builtin ? (
              <span className="text-[10px] self-center">Built-in · read-only</span>
            ) : (
              <Button variant="ghost" onClick={deletePreset}>
                DELETE PRESET
              </Button>
            )}
          </div>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
            Apply copies a snapshot into the controls below. You can edit it before starting;
            presets never reference live settings.
          </p>
          <div className="border-t border-[hsl(var(--border))] pt-3 flex flex-col gap-2">
            <label className="text-[11px] flex flex-col gap-1">
              Preset name
              <input
                aria-label="Preset name"
                value={presetName}
                maxLength={60}
                onChange={(event) => setPresetName(event.target.value)}
                className="min-w-0 bg-transparent border border-[hsl(var(--border-bright))] p-2"
              />
            </label>
            <Choice<PresetScope>
              label="SAVE SCOPE"
              value={saveScope}
              options={[
                { value: 'map', label: '▧ MAP ONLY' },
                { value: 'campaign', label: '◆ WHOLE CAMPAIGN' },
              ]}
              onChange={setSaveScope}
            />
            <Button
              variant="ghost"
              onClick={savePreset}
              disabled={
                !canStart || !presetName.trim() || playerPresets.length >= PLAYER_PRESETS_LIMIT
              }
            >
              SAVE PLAYER PRESET
            </Button>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
              {playerPresets.length}/{PLAYER_PRESETS_LIMIT} saved in this browser. Delete a player
              preset to free space. Built-ins remain available.
            </p>
          </div>
          <label className="text-[11px] flex flex-col gap-2">
            IMPORT CONFIGURATION OR PRESET (.json)
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Import campaign configuration or preset"
              className="w-full min-w-0 text-[10px]"
              onChange={(event) => {
                void loadConfiguration(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
            Imports load editable settings without starting a game. Campaign configurations keep
            their own rules, including baseline when omitted. Use Home → Resume Game for exact saved
            progress.
          </p>
        </section>
        {notice && (
          <p role="status" className="text-[11px] leading-4">
            {notice}
          </p>
        )}
        <Choice<Era>
          label="ERA"
          value={settings.era}
          options={[
            { value: 'ww2', label: 'WW2' },
            { value: 'medieval', label: 'MEDIEVAL' },
          ]}
          onChange={(era) => setSettings({ ...settings, era })}
        />
        <Choice<Mode | 'imported'>
          label="OPPONENT"
          value={importedPlayers ? 'imported' : mode}
          options={[
            { value: 'ai', label: 'VS AI' },
            { value: 'hotseat', label: 'HOTSEAT 2P' },
            { value: 'spectate', label: 'AI vs AI' },
            ...(importedPlayers
              ? [{ value: 'imported' as const, label: 'IMPORTED: AI ALPHA vs HUMAN BRAVO' }]
              : []),
          ]}
          onChange={(next) => {
            if (next === 'imported') return;
            setMode(next);
            setSettings({
              ...settings,
              controllers:
                next === 'ai'
                  ? { A: 'human', B: 'ai' }
                  : next === 'hotseat'
                    ? { A: 'human', B: 'human' }
                    : { A: 'ai', B: 'ai' },
            });
          }}
        />
        <section
          aria-label="Map"
          className="border border-[hsl(var(--border))] p-3 flex flex-col gap-4"
        >
          <h2 className="text-sm tracking-widest">▧ MAP</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <NumberField
              label="MAIN COLS"
              value={g.mainCols}
              min={GRID_LIMITS.mainCols.min}
              max={GRID_LIMITS.mainCols.max}
              onChange={(mainCols) => setGrid({ mainCols })}
            />
            <NumberField
              label="MAIN ROWS"
              value={g.mainRows}
              min={GRID_LIMITS.mainRows.min}
              max={GRID_LIMITS.mainRows.max}
              onChange={(mainRows) => setGrid({ mainRows })}
            />
            <NumberField
              label="SUB-GRID RADIUS"
              value={g.subRadius}
              min={GRID_LIMITS.subRadius.min}
              max={GRID_LIMITS.subRadius.max}
              onChange={(subRadius) => setGrid({ subRadius })}
            />
          </div>
          <p className="text-[10px] leading-4">
            {g.mainCols}×{g.mainRows} main hexes · {perMain} sub-hexes each ·{' '}
            {total.toLocaleString()} tactical cells. Sub-hexes share one lattice across MainHex
            borders.
          </p>
          <label className="flex flex-col gap-1 text-[11px]">
            MAP SEED
            <div className="flex gap-2">
              <input
                aria-label="MAP SEED"
                type="number"
                value={settings.seed}
                min={0}
                max={0xffffffff}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    seed: Math.min(
                      0xffffffff,
                      Math.abs(Math.floor(Number(event.target.value) || 0)),
                    ),
                  })
                }
                className="min-w-0 flex-1 bg-transparent border border-[hsl(var(--border-bright))] p-1"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSettings({ ...settings, seed: Math.floor(Math.random() * 1e6) })}
              >
                RANDOM
              </Button>
            </div>
          </label>
          <Choice<CampaignMode>
            label="INFRASTRUCTURE"
            value={campaignMode}
            options={[
              { value: 'classic', label: 'CLASSIC' },
              { value: 'simple', label: 'SIMPLE NODES' },
              { value: 'advanced', label: 'ADVANCED SEEDED NODES' },
            ]}
            onChange={setCampaignMode}
          />
          <p className="text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
            {campaignMode === 'classic'
              ? 'Classic: HQ recruitment and territory fortification. No infrastructure nodes, node buildings or supply network.'
              : campaignMode === 'simple'
                ? 'Simple: one seven-tile node site in every MainHex. Select your HQ or any node to activate, build, upgrade and repair.'
                : 'Advanced: nodes on a seeded selection of MainHexes, including both Home HQs. Other MainHexes retain territory and movement rules.'}
          </p>
          {campaignMode === 'advanced' && (
            <>
              <NumberField
                label="NON-HQ NODES"
                value={advancedCount}
                min={0}
                max={maximumAdditionalNodes}
                onChange={setAdditionalNodes}
                hint={`${advancedCount + 2} nodes total; both Home HQs are guaranteed.`}
              />
              <label className="text-[11px] flex flex-col gap-1">
                NODE PLACEMENT SEED
                <input
                  aria-label="NODE PLACEMENT SEED"
                  type="number"
                  min={0}
                  max={0xffffffff}
                  value={nodePlacementSeed}
                  onChange={(event) =>
                    setNodePlacementSeed(
                      Math.min(0xffffffff, Math.abs(Math.floor(Number(event.target.value) || 0))),
                    )
                  }
                  className="bg-transparent border border-[hsl(var(--border-bright))] p-1"
                />
                <span className="text-[10px]">
                  Independent from terrain. Editing or randomizing MAP SEED keeps this seed.
                </span>
              </label>
            </>
          )}
          {campaignMode !== 'classic' && (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] leading-4">
                Playtest nodes, supply and stationed garrisons. Raze must cost less than Capture; Do
                nothing stays free.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    label: 'Capture Node price (CP)',
                    value: capturePrice,
                    change: setCapturePrice,
                  },
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
                      className="w-full bg-transparent border border-[hsl(var(--border-bright))] p-1"
                      required
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </section>
        <section
          aria-label="Independent rules"
          className="border border-[hsl(var(--border))] p-3 flex flex-col gap-4"
        >
          <h2 className="text-sm tracking-widest">◆ INDEPENDENT RULES</h2>
          <label className="text-[11px] flex flex-col gap-1">
            Commander training price (CP)
            <input
              aria-label="Commander training price (CP)"
              type="number"
              min={1}
              step={1}
              value={commanderPrice}
              onChange={(event) => setCommanderPrice(event.target.value)}
              required
              className="w-full bg-transparent border border-[hsl(var(--border-bright))] p-1"
            />
            <span className="text-[10px]">
              Default 15 CP per new commander, including splits. Existing saves retain their price.
            </span>
          </label>
          <NumberField
            label="BATTLE ROUND LIMIT"
            value={settings.battleRounds}
            min={1}
            max={100}
            onChange={(battleRounds) => setSettings({ ...settings, battleRounds })}
          />
          <label className="flex items-start gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={settings.fog}
              onChange={(event) => setSettings({ ...settings, fog: event.target.checked })}
              className="accent-[hsl(var(--primary))]"
            />
            <span>FOG OF WAR (LOS-based spotting)</span>
          </label>
          <label className="flex items-start gap-2 text-[11px]">
            <input
              type="checkbox"
              aria-label="Experimental multi-commander engagements"
              checked={settings.engagement?.profile === 'multi-commander-v1'}
              onChange={(event) => {
                const { engagement: _old, ...rest } = settings;
                void _old;
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
          <p className="text-[10px] leading-4">
            Choose each side’s commanders before deployment. Trial attack price: 5 CP plus 2 per
            additional attacker; initial defense is free, each additional defender costs 2 CP.
            Additional commanders keep position and movement.
          </p>
          <p className="text-[11px]">
            Combat tuning:{' '}
            {ruleSource === 'snapshot'
              ? 'configuration / campaign preset snapshot'
              : activeRules
                ? 'applied Balance Lab rules'
                : 'code baseline'}
            . Unsaved Lab drafts never change a launch.
          </p>
          {ruleSource === 'snapshot' && (
            <Button size="sm" variant="ghost" onClick={() => setRuleSource('active')}>
              USE APPLIED LAB RULES
            </Button>
          )}
          <LabEntry settings={configured} problem={setupProblem} selection={selection} />
        </section>
        <section
          aria-label="Campaign summary"
          className="text-[11px] leading-5 border-t border-[hsl(var(--border-bright))] pt-3"
        >
          <h2 className="text-sm tracking-widest">REVIEW CAMPAIGN</h2>
          <p>
            {settings.era.toUpperCase()} ·{' '}
            {importedPlayers
              ? 'AI Alpha vs Human Bravo'
              : mode === 'ai'
                ? 'vs AI'
                : mode === 'hotseat'
                  ? 'Hotseat 2P'
                  : 'AI vs AI'}{' '}
            · {g.mainCols}×{g.mainRows} · radius {g.subRadius} · terrain seed {settings.seed}
          </p>
          <p>
            {campaignMode === 'classic'
              ? 'Classic infrastructure'
              : `${campaignMode === 'advanced' ? `${advancedCount + 2} seeded nodes · node seed ${nodePlacementSeed}` : 'Nodes in every MainHex'} · Capture ${capturePrice} CP / Raze ${razePrice} CP`}{' '}
            · commander training {commanderPrice || '—'} CP
          </p>
          <p>
            Fog {settings.fog ? 'on' : 'off'} · battle round limit {settings.battleRounds} ·{' '}
            {settings.engagement ? 'Multi-commander engagements' : 'Standard engagements'}
          </p>
        </section>
        {setupProblem && <p className="text-[11px] text-[hsl(var(--warning))]">{setupProblem}</p>}
        {error && (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {error}
          </p>
        )}
        <Button
          size="lg"
          disabled={!canStart}
          onClick={() => {
            const setup = configured();
            if (setup) newGame(setup);
          }}
        >
          START NEW GAME
        </Button>
        <Button variant="ghost" onClick={exportConfiguration} disabled={!canStart}>
          EXPORT NEW-RUN CONFIGURATION
        </Button>
      </main>
    </div>
  );
}

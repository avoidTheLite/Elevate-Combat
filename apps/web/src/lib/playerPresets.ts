import type { GameSettings } from '@iron-ridge/engine';
import { DEFAULT_CAMPAIGN_PRICES, defaultSettings } from '@iron-ridge/engine';
import type { SetupSelection } from '../balance/store.ts';
import {
  configurationDocument,
  parseCampaignConfiguration,
  regularPlaytestSettings,
} from './campaignScenarios.ts';

export const PLAYER_PRESETS_KEY = 'iron-ridge-player-presets-v1';
export const PLAYER_PRESETS_LIMIT = 20;
const MAX_BYTES = 2_000_000;
export type PresetScope = 'map' | 'campaign';

/** Map owns terrain and every infrastructure setting, including dormant form choices. */
export interface MapSnapshot {
  grid: GameSettings['grid'];
  seed: number;
  infrastructure?: GameSettings['infrastructure'];
  campaignMode: SetupSelection['campaignMode'];
  additionalNodes: number;
  nodePlacementSeed: number;
  capturePrice: string;
  razePrice: string;
}
interface PresetBase {
  kind: 'iron-ridge-player-preset';
  version: 1;
  id: string;
  name: string;
  builtin?: true;
}
export type PlayerPreset = PresetBase &
  ({ scope: 'map'; snapshot: MapSnapshot } | { scope: 'campaign'; snapshot: SetupSelection });

export function selectionFromSettings(settings: GameSettings): SetupSelection {
  const placement = settings.infrastructure?.nodes.placement;
  return {
    settings: structuredClone(settings),
    mode:
      settings.controllers.A === 'ai'
        ? 'spectate'
        : settings.controllers.B === 'ai'
          ? 'ai'
          : 'hotseat',
    campaignMode: !settings.infrastructure
      ? 'classic'
      : placement?.mode === 'advanced'
        ? 'advanced'
        : 'simple',
    additionalNodes: placement?.mode === 'advanced' ? placement.additionalNodes : 16,
    nodePlacementSeed: placement?.mode === 'advanced' ? placement.seed : settings.seed,
    commanderPrice: String(
      settings.commanderTrainingCp ?? DEFAULT_CAMPAIGN_PRICES.commanderTraining,
    ),
    capturePrice: String(
      settings.infrastructure?.nodes.captureCosts.capture ?? DEFAULT_CAMPAIGN_PRICES.captureNode,
    ),
    razePrice: String(
      settings.infrastructure?.nodes.captureCosts.raze ?? DEFAULT_CAMPAIGN_PRICES.razeNode,
    ),
  };
}

function mapSnapshot(selection: SetupSelection): MapSnapshot {
  return structuredClone({
    grid: selection.settings.grid,
    seed: selection.settings.seed,
    ...(selection.settings.infrastructure
      ? { infrastructure: selection.settings.infrastructure }
      : {}),
    campaignMode: selection.campaignMode,
    additionalNodes: selection.additionalNodes,
    nodePlacementSeed: selection.nodePlacementSeed ?? selection.settings.seed,
    capturePrice: selection.capturePrice,
    razePrice: selection.razePrice,
  });
}

export function createPlayerPreset(
  scope: PresetScope,
  name: string,
  selection: SetupSelection,
): PlayerPreset {
  const base: PresetBase = {
    kind: 'iron-ridge-player-preset',
    version: 1,
    id: `player-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
    name: name.trim(),
  };
  const snapshot: SetupSelection = {
    settings: selection.settings,
    mode: selection.mode,
    campaignMode: selection.campaignMode,
    additionalNodes: selection.additionalNodes,
    nodePlacementSeed: selection.nodePlacementSeed,
    commanderPrice: selection.commanderPrice,
    capturePrice: selection.capturePrice,
    razePrice: selection.razePrice,
  };
  return parsePlayerPreset(
    JSON.stringify(
      scope === 'map'
        ? { ...base, scope, snapshot: mapSnapshot(selection) }
        : { ...base, scope, snapshot },
    ),
  );
}

/** Applying always makes a copy. A map never owns fog, era, players, or combat rules. */
export function applyPlayerPreset(preset: PlayerPreset, current: SetupSelection): SetupSelection {
  if (preset.scope === 'campaign') return structuredClone(preset.snapshot);
  const map = preset.snapshot;
  const { infrastructure: _previous, ...settings } = structuredClone(current.settings);
  void _previous;
  return {
    ...structuredClone(current),
    campaignMode: map.campaignMode,
    additionalNodes: map.additionalNodes,
    nodePlacementSeed: map.nodePlacementSeed,
    capturePrice: map.capturePrice,
    razePrice: map.razePrice,
    settings: {
      ...settings,
      grid: structuredClone(map.grid),
      seed: map.seed,
      ...(map.infrastructure ? { infrastructure: structuredClone(map.infrastructure) } : {}),
    },
  };
}

function validMap(value: MapSnapshot): boolean {
  const placement = value?.infrastructure?.nodes?.placement;
  const costs = value?.infrastructure?.nodes?.captureCosts;
  return (
    !!value &&
    ['classic', 'simple', 'advanced'].includes(value.campaignMode) &&
    Number.isSafeInteger(value.additionalNodes) &&
    value.additionalNodes >= 0 &&
    value.additionalNodes <= 1_000 &&
    Number.isSafeInteger(value.nodePlacementSeed) &&
    value.nodePlacementSeed >= 0 &&
    value.nodePlacementSeed <= 0xffffffff &&
    typeof value.capturePrice === 'string' &&
    value.capturePrice.length <= 30 &&
    typeof value.razePrice === 'string' &&
    value.razePrice.length <= 30 &&
    (value.campaignMode === 'classic' ||
      (Number.isSafeInteger(Number(value.capturePrice)) &&
        Number(value.capturePrice) > 0 &&
        Number.isSafeInteger(Number(value.razePrice)) &&
        Number(value.razePrice) > 0 &&
        Number(value.capturePrice) > Number(value.razePrice))) &&
    (value.campaignMode === 'classic' ? !value.infrastructure : !!value.infrastructure) &&
    (!value.infrastructure ||
      (Number(value.capturePrice) === costs?.capture && Number(value.razePrice) === costs?.raze)) &&
    (value.campaignMode === 'advanced'
      ? placement?.mode === 'advanced' &&
        placement.seed === value.nodePlacementSeed &&
        placement.additionalNodes === value.additionalNodes
      : placement?.mode !== 'advanced')
  );
}

export function parsePlayerPreset(text: string): PlayerPreset {
  if (text.length > MAX_BYTES) throw new Error('Preset file is too large (maximum 2 MB)');
  const preset = JSON.parse(text) as PlayerPreset;
  if (
    !preset ||
    preset.kind !== 'iron-ridge-player-preset' ||
    preset.version !== 1 ||
    !['map', 'campaign'].includes(preset.scope) ||
    typeof preset.id !== 'string' ||
    !preset.id.trim() ||
    typeof preset.name !== 'string' ||
    !preset.name.trim() ||
    preset.name.trim().length > 60 ||
    !preset.snapshot
  )
    throw new Error('Choose a map or campaign preset with explicit scope and version 1.');
  if (preset.scope === 'map') {
    if (!validMap(preset.snapshot)) throw new Error('Invalid map preset settings.');
    const base = defaultSettings();
    parseCampaignConfiguration(
      JSON.stringify(
        configurationDocument({
          ...base,
          grid: preset.snapshot.grid,
          seed: preset.snapshot.seed,
          infrastructure: preset.snapshot.infrastructure,
        }),
      ),
    );
  } else {
    const selection = preset.snapshot;
    if (
      !['ai', 'hotseat', 'spectate'].includes(selection.mode) ||
      !validMap(mapSnapshot(selection)) ||
      typeof selection.commanderPrice !== 'string' ||
      Number(selection.commanderPrice) !== selection.settings.commanderTrainingCp
    )
      throw new Error('Invalid campaign preset settings.');
    parseCampaignConfiguration(JSON.stringify(configurationDocument(selection.settings)));
    const canonical = selectionFromSettings(selection.settings);
    if (canonical.mode !== selection.mode || canonical.campaignMode !== selection.campaignMode)
      throw new Error('Campaign preset players and infrastructure must match its settings.');
  }
  // Imported files cannot grant themselves built-in status.
  const { builtin: _builtin, ...validated } = preset;
  void _builtin;
  return structuredClone({ ...validated, name: preset.name.trim() }) as PlayerPreset;
}

export function builtInPresets(): PlayerPreset[] {
  const classic = selectionFromSettings(defaultSettings());
  const ready = selectionFromSettings(regularPlaytestSettings());
  return [
    {
      ...createPlayerPreset('map', 'Standard terrain', classic),
      id: 'builtin-classic-map',
      builtin: true,
    },
    {
      ...createPlayerPreset('map', 'Regular objectives map', ready),
      id: 'builtin-regular-map',
      builtin: true,
    },
    {
      ...createPlayerPreset('campaign', 'Ready Regular', ready),
      id: 'builtin-ready-regular',
      builtin: true,
    },
  ];
}

export function loadPlayerPresets(): PlayerPreset[] {
  try {
    const raw = localStorage.getItem(PLAYER_PRESETS_KEY);
    if (!raw || raw.length > MAX_BYTES) return [];
    const collection = JSON.parse(raw) as { version: number; presets: unknown[] };
    if (
      collection.version !== 1 ||
      !Array.isArray(collection.presets) ||
      collection.presets.length > PLAYER_PRESETS_LIMIT
    )
      return [];
    const result = collection.presets.map((preset) => parsePlayerPreset(JSON.stringify(preset)));
    if (
      result.some((preset) => !preset.id.startsWith('player-')) ||
      new Set(result.map((preset) => preset.id)).size !== result.length
    )
      return [];
    return result;
  } catch {
    return [];
  }
}

export function persistPlayerPresets(presets: PlayerPreset[]): void {
  if (presets.length > PLAYER_PRESETS_LIMIT)
    throw new Error(
      `Keep at most ${PLAYER_PRESETS_LIMIT} player presets. Delete one before saving another.`,
    );
  if (presets.some((preset) => preset.builtin || !preset.id.startsWith('player-')))
    throw new Error('Built-in presets are read-only.');
  const json = JSON.stringify({
    version: 1,
    presets: presets.map((preset) => parsePlayerPreset(JSON.stringify(preset))),
  });
  if (json.length > MAX_BYTES)
    throw new Error('Player preset collection is too large (maximum 2 MB).');
  try {
    localStorage.setItem(PLAYER_PRESETS_KEY, json);
  } catch {
    throw new Error(
      'Browser storage is unavailable or full. Export the configuration to keep a copy.',
    );
  }
}

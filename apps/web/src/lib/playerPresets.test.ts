import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '@iron-ridge/engine';
import {
  applyPlayerPreset,
  builtInPresets,
  createPlayerPreset,
  loadPlayerPresets,
  parsePlayerPreset,
  persistPlayerPresets,
  PLAYER_PRESETS_KEY,
  PLAYER_PRESETS_LIMIT,
  selectionFromSettings,
} from './playerPresets.ts';
import { regularPlaytestSettings } from './campaignScenarios.ts';

beforeEach(() => localStorage.clear());

describe('player preset ownership and snapshots', () => {
  it('replaces all map infrastructure fields while retaining unowned campaign rules', () => {
    const source = selectionFromSettings(regularPlaytestSettings());
    const current = selectionFromSettings({
      ...defaultSettings(),
      era: 'medieval',
      fog: false,
      battleRounds: 17,
      controllers: { A: 'human', B: 'human' },
      commanderTrainingCp: 31,
      rules: { mechanics: { BLIND_FIRE_TN: 4 } },
    });
    const preset = createPlayerPreset('map', 'Objectives', source);
    const result = applyPlayerPreset(preset, current);
    expect(result.settings).toMatchObject({
      era: 'medieval',
      fog: false,
      battleRounds: 17,
      controllers: { A: 'human', B: 'human' },
      commanderTrainingCp: 31,
      grid: source.settings.grid,
      seed: 20261101,
      infrastructure: source.settings.infrastructure,
      rules: current.settings.rules,
    });
    expect(result).toMatchObject({
      mode: 'hotseat',
      commanderPrice: '31',
      campaignMode: 'advanced',
      nodePlacementSeed: 4277,
      additionalNodes: 3,
      capturePrice: '5',
      razePrice: '2',
    });
    source.settings.grid.mainCols = 3;
    Object.assign(result.settings.infrastructure!.nodes.captureCosts, { capture: 99 });
    result.settings.grid.mainCols = 4;
    expect(applyPlayerPreset(preset, current).settings.grid.mainCols).toBe(7);
    expect(
      applyPlayerPreset(preset, current).settings.infrastructure!.nodes.captureCosts.capture,
    ).toBe(5);
    expect(current.settings.infrastructure).toBeUndefined();
  });

  it('captures a whole campaign by value and removes old infrastructure through a Classic map', () => {
    const source = selectionFromSettings(regularPlaytestSettings());
    const preset = createPlayerPreset('campaign', 'Campaign', source);
    source.settings.rules = undefined;
    const first = applyPlayerPreset(preset, selectionFromSettings(defaultSettings()));
    expect(first.settings).toEqual(regularPlaytestSettings());
    first.settings.seed = 1;
    expect(applyPlayerPreset(preset, first).settings.seed).toBe(20261101);
    const classic = builtInPresets().find((entry) => entry.id === 'builtin-classic-map')!;
    expect(applyPlayerPreset(classic, first).settings.infrastructure).toBeUndefined();
  });

  it('rejects unknown scope/version, mismatched settings and invalid or oversized map inputs', () => {
    const map = createPlayerPreset('map', 'Terrain', selectionFromSettings(defaultSettings()));
    expect(() => parsePlayerPreset(JSON.stringify({ ...map, scope: 'rules' }))).toThrow(
      /scope and version/,
    );
    expect(() => parsePlayerPreset(JSON.stringify({ ...map, version: 2 }))).toThrow(
      /scope and version/,
    );
    if (map.scope !== 'map') throw new Error('Expected map preset');
    expect(() =>
      parsePlayerPreset(
        JSON.stringify({
          ...map,
          snapshot: { ...map.snapshot, grid: { ...map.snapshot.grid, mainCols: 1_000_000 } },
        }),
      ),
    ).toThrow(/Invalid campaign settings/);
    expect(() =>
      parsePlayerPreset(
        JSON.stringify({ ...map, snapshot: { ...map.snapshot, nodePlacementSeed: -1 } }),
      ),
    ).toThrow(/Invalid map/);
    const campaign = createPlayerPreset(
      'campaign',
      'Campaign',
      selectionFromSettings(defaultSettings()),
    );
    expect(() =>
      parsePlayerPreset(
        JSON.stringify({ ...campaign, snapshot: { ...campaign.snapshot, mode: 'spectate' } }),
      ),
    ).toThrow(/must match/);
    const advanced = createPlayerPreset(
      'map',
      'Advanced',
      selectionFromSettings(regularPlaytestSettings()),
    );
    expect(() =>
      parsePlayerPreset(
        JSON.stringify({ ...advanced, snapshot: { ...advanced.snapshot, nodePlacementSeed: 1 } }),
      ),
    ).toThrow(/Invalid map/);
    expect(() =>
      parsePlayerPreset(
        JSON.stringify({ ...advanced, snapshot: { ...advanced.snapshot, capturePrice: '7' } }),
      ),
    ).toThrow(/Invalid map/);
  });
});

describe('bounded browser player collection', () => {
  it('persists, reloads and deletes player copies while built-ins remain read-only', () => {
    const player = createPlayerPreset(
      'campaign',
      'Mine',
      selectionFromSettings(regularPlaytestSettings()),
    );
    persistPlayerPresets([player]);
    expect(loadPlayerPresets()).toEqual([player]);
    const loaded = loadPlayerPresets();
    loaded[0]!.name = 'Edited in memory';
    expect(loadPlayerPresets()[0]!.name).toBe('Mine');
    persistPlayerPresets([]);
    expect(loadPlayerPresets()).toEqual([]);
    expect(() => persistPlayerPresets([builtInPresets()[0]!])).toThrow(/read-only/);
    expect(builtInPresets()).toHaveLength(3);
  });

  it('enforces the collection limit and safely rejects corrupt/unsupported collections', () => {
    const selection = selectionFromSettings(defaultSettings());
    const presets = Array.from({ length: PLAYER_PRESETS_LIMIT + 1 }, (_, index) =>
      createPlayerPreset('map', `Map ${index}`, selection),
    );
    expect(() => persistPlayerPresets(presets)).toThrow(/at most 20/);
    localStorage.setItem(PLAYER_PRESETS_KEY, JSON.stringify({ version: 2, presets: [] }));
    expect(loadPlayerPresets()).toEqual([]);
    localStorage.setItem(PLAYER_PRESETS_KEY, '{');
    expect(loadPlayerPresets()).toEqual([]);
  });
});

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createGame, defaultSettings, serializeSave } from '@iron-ridge/engine';
import App from './App.tsx';
import { useGameStore } from './stores/useGameStore.ts';
import { useBalanceStore } from './balance/store.ts';
import { configurationDocument } from './lib/campaignScenarios.ts';
import { createMovementDemo } from './controls/demoScenario.ts';
import {
  createPlayerPreset,
  loadPlayerPresets,
  selectionFromSettings,
} from './lib/playerPresets.ts';

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useGameStore.getState().quit();
    useBalanceStore.setState({
      view: 'setup',
      active: undefined,
      draft: {},
      setupSelection: null,
      dirtyCards: {},
    });
  });
});
const click = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const change = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
function jsonFile(text: string): File {
  const file = new File([text], 'config.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => text });
  return file;
}

describe('Home intent navigation', () => {
  it('offers five entries, keeps scenarios out of Create, and opens shared Settings', () => {
    render(<App />);
    expect(within(screen.getByRole('main', { name: 'Home' })).getAllByRole('button')).toHaveLength(
      5,
    );
    click('SETTINGS');
    expect(screen.getByRole('dialog', { name: 'Player Settings' })).toBeInTheDocument();
    click('CLOSE SETTINGS');
    click('CREATE CAMPAIGN');
    expect(screen.queryByRole('button', { name: 'TURN-START CAPTURE' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'START SCENARIO' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Import save file')).not.toBeInTheDocument();
    click('← HOME');
    click('PLAY SCENARIO');
    expect(screen.getByRole('button', { name: 'TURN-START CAPTURE' })).toBeInTheDocument();
  });

  it('Quick Start launches the actual sandbox immediately', () => {
    render(<App />);
    click('QUICK START TACTICAL CONTROLS');
    expect(useGameStore.getState().game).toEqual(createMovementDemo());
  });

  it('Resume imports exact saved progress independently of new-campaign settings', async () => {
    const game = createGame({ ...defaultSettings(), seed: 93, fog: false });
    game.cp.A = 13;
    render(<App />);
    click('RESUME GAME');
    fireEvent.change(screen.getByLabelText('Import save file'), {
      target: { files: [jsonFile(serializeSave(game))] },
    });
    await screen.findByRole('button', { name: /end turn/i });
    expect(useGameStore.getState().game).toEqual(game);
  });
});

describe('editable presets and independent domains', () => {
  it('starts Classic after clearing dormant node prices without constructing or repricing nodes', () => {
    render(<App />);
    click('CREATE CAMPAIGN');
    click('SIMPLE NODES');
    change('Capture Node price (CP)', '');
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeDisabled();
    click('CLASSIC');
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeEnabled();
    change('Preset name', 'Classic with dormant price draft');
    click('SAVE PLAYER PRESET');
    expect(loadPlayerPresets()).toHaveLength(1);
    click('APPLY PRESET');
    click('SIMPLE NODES');
    expect(screen.getByLabelText('Capture Node price (CP)')).toHaveValue(null);
    click('CLASSIC');
    click('START NEW GAME');
    expect(useGameStore.getState().game!.settings.infrastructure).toBeUndefined();
    expect(useGameStore.getState().game!.settings.commanderTrainingCp).toBe(15);
  });

  it('applies Ready Regular without launching or touching applied/draft Lab rules; map seed never changes node seed', () => {
    const active = { mechanics: { BLIND_FIRE_TN: 4 } };
    const draft = { mechanics: { BLIND_FIRE_TN: 5 } };
    useBalanceStore.setState({ active, draft, dirtyCards: { mechanics: true } });
    render(<App />);
    click('CREATE CAMPAIGN');
    click('APPLY PRESET');
    expect(useGameStore.getState().game).toBeNull();
    expect(useBalanceStore.getState()).toMatchObject({
      active,
      draft,
      dirtyCards: { mechanics: true },
    });
    expect(screen.getByLabelText('NODE PLACEMENT SEED')).toHaveValue(4277);
    change('MAP SEED', '42');
    expect(screen.getByLabelText('NODE PLACEMENT SEED')).toHaveValue(4277);
    click('RANDOM');
    expect(screen.getByLabelText('NODE PLACEMENT SEED')).toHaveValue(4277);
    click('MEDIEVAL');
    click('HOTSEAT 2P');
    fireEvent.click(screen.getByLabelText('FOG OF WAR (LOS-based spotting)'));
    change('Choose a preset', 'builtin-classic-map');
    expect(screen.getByTestId('preset-scope')).toHaveTextContent(
      'Retains Era, Opponent and independent rules',
    );
    click('APPLY PRESET');
    expect(screen.getByRole('button', { name: 'MEDIEVAL' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'HOTSEAT 2P' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('FOG OF WAR (LOS-based spotting)')).not.toBeChecked();
    click('START NEW GAME');
    expect(useGameStore.getState().game!.settings).toMatchObject({
      era: 'medieval',
      fog: false,
      controllers: { A: 'human', B: 'human' },
    });
    expect(useGameStore.getState().game!.settings.infrastructure).toBeUndefined();
    expect(useGameStore.getState().game!.settings.rules).not.toEqual(active);
  });

  it('saves, reuses and deletes named copies while built-ins stay read-only and available', () => {
    const mounted = render(<App />);
    click('CREATE CAMPAIGN');
    expect(screen.queryByRole('button', { name: 'DELETE PRESET' })).not.toBeInTheDocument();
    change('MAP SEED', '17');
    change('Preset name', 'My terrain');
    click('▧ MAP ONLY');
    click('SAVE PLAYER PRESET');
    change('MAP SEED', '29');
    click('APPLY PRESET');
    expect(screen.getByLabelText('MAP SEED')).toHaveValue(17);
    expect(loadPlayerPresets()).toHaveLength(1);
    mounted.unmount();
    render(<App />);
    click('CREATE CAMPAIGN');
    expect(screen.getByRole('option', { name: /My terrain/ })).toBeInTheDocument();
    const saved = loadPlayerPresets()[0]!;
    change('Choose a preset', saved.id);
    click('DELETE PRESET');
    expect(loadPlayerPresets()).toEqual([]);
    expect(screen.getByRole('option', { name: /Ready Regular/ })).toBeInTheDocument();
  });

  it('imports campaign settings for editing without adding active rules or mutating a Lab draft', async () => {
    const active = { mechanics: { BLIND_FIRE_TN: 4 } },
      draft = { mechanics: { BLIND_FIRE_TN: 5 } };
    useBalanceStore.setState({ active, draft });
    const settings = { ...defaultSettings(), seed: 71, fog: false, commanderTrainingCp: 12 };
    render(<App />);
    click('CREATE CAMPAIGN');
    fireEvent.change(screen.getByLabelText('Import campaign configuration or preset'), {
      target: { files: [jsonFile(JSON.stringify(configurationDocument(settings)))] },
    });
    await screen.findByRole('status');
    expect(useGameStore.getState().game).toBeNull();
    expect(screen.getByLabelText('MAP SEED')).toHaveValue(71);
    expect(useBalanceStore.getState()).toMatchObject({ active, draft });
    change('MAP SEED', '72');
    click('START NEW GAME');
    expect(useGameStore.getState().game).toEqual(createGame({ ...settings, seed: 72 }));
  });

  it('validates imported preset scope and applies a map file without replacing independent rules', async () => {
    render(<App />);
    click('CREATE CAMPAIGN');
    click('MEDIEVAL');
    change('Commander training price (CP)', '21');
    const preset = createPlayerPreset(
      'map',
      'Imported map',
      selectionFromSettings({ ...defaultSettings(), seed: 49 }),
    );
    const input = screen.getByLabelText('Import campaign configuration or preset');
    fireEvent.change(input, {
      target: { files: [jsonFile(JSON.stringify({ ...preset, scope: 'everything' }))] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('explicit scope and version');
    expect(screen.getByLabelText('MAP SEED')).toHaveValue(1337);
    fireEvent.change(input, { target: { files: [jsonFile(JSON.stringify(preset))] } });
    await screen.findByRole('status');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(useGameStore.getState().game).toBeNull();
    expect(screen.getByLabelText('MAP SEED')).toHaveValue(49);
    expect(screen.getByRole('button', { name: 'MEDIEVAL' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Commander training price (CP)')).toHaveValue(21);
  });

  it('retains an imported AI Alpha / Human Bravo mapping until a normal opponent is chosen', async () => {
    const settings = {
      ...defaultSettings(),
      controllers: { A: 'ai' as const, B: 'human' as const },
    };
    render(<App />);
    click('CREATE CAMPAIGN');
    fireEvent.change(screen.getByLabelText('Import campaign configuration or preset'), {
      target: { files: [jsonFile(JSON.stringify(configurationDocument(settings)))] },
    });
    await screen.findByRole('status');
    expect(
      screen.getByRole('button', { name: 'IMPORTED: AI ALPHA vs HUMAN BRAVO' }),
    ).toHaveAttribute('aria-pressed', 'true');
    change('Preset name', 'Imported players');
    click('SAVE PLAYER PRESET');
    const saved = loadPlayerPresets()[0]!;
    if (saved.scope !== 'campaign') throw new Error('Expected campaign snapshot');
    expect(saved.snapshot.settings.controllers).toEqual(settings.controllers);
    click('HOTSEAT 2P');
    click('START NEW GAME');
    expect(useGameStore.getState().game!.settings.controllers).toEqual({ A: 'human', B: 'human' });
  });
});

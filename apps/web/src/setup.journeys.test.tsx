// GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002; GAMES-ELEVATE-SESSION-UC-001: visible setup journeys.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createGame, defaultSettings, serializeSave } from '@iron-ridge/engine';
import App from './App.tsx';
import { inspectTile } from './lib/selection.ts';
import { useGameStore } from './stores/useGameStore.ts';
import { useBalanceStore } from './balance/store.ts';
import { configurationDocument, parseCampaignConfiguration } from './lib/campaignScenarios.ts';

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useGameStore.getState().quit();
    useBalanceStore.setState({ view: 'setup', active: undefined, draft: {}, setupSelection: null });
  });
});
const price = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
function enterPrices(infrastructure = true): void {
  price('Commander training price (CP)', '11');
  if (infrastructure) {
    price('Capture Node price (CP)', '7');
    price('Raze Node price (CP)', '3');
  }
}
function file(text: string): File {
  const f = new File([text], 'scenario.json', { type: 'application/json' });
  Object.defineProperty(f, 'text', { value: async () => text });
  return f;
}

describe('visible setup and scenario flows', () => {
  it('uses the approved new commander default and keeps Classic free of infrastructure rules', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'CREATE CAMPAIGN' }));
    expect(screen.getByLabelText('Commander training price (CP)')).toHaveValue(15);
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeEnabled();
    price('Commander training price (CP)', '');
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'TURN-START CAPTURE' })).not.toBeInTheDocument();
    enterPrices(false);
    fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
    const game = useGameStore.getState().game!;
    expect(game.settings.commanderTrainingCp).toBe(11);
    expect(game.infrastructure).toBeUndefined();
    const hq = game.armies.find((holder) => holder.kind === 'garrison' && holder.team === 'A')!;
    act(() => inspectTile(game, hq.pos));
    expect(screen.getByRole('button', { name: /rifle infantry/i })).toBeInTheDocument();
    expect(screen.queryByText('INFRASTRUCTURE NODE')).not.toBeInTheDocument();
  });
  it.each(['SIMPLE NODES', 'ADVANCED SEEDED NODES'])(
    'starts %s with its actual map and visible node controls',
    (mode) => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'CREATE CAMPAIGN' }));
      fireEvent.click(screen.getByRole('button', { name: mode }));
      enterPrices();
      if (mode === 'ADVANCED SEEDED NODES') {
        price('NON-HQ NODES', '5');
        price('MAP SEED', '42');
      }
      fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
      const game = useGameStore.getState().game!;
      const total = game.settings.grid.mainRows * game.settings.grid.mainCols;
      expect(game.infrastructure!.sites).toHaveLength(mode === 'SIMPLE NODES' ? total : 7);
      const hq = game.infrastructure!.sites.find((site) => site.homeTeam === 'A')!;
      act(() => useGameStore.getState().setUi({ selectedMain: hq.mainHex }));
      expect(screen.getByRole('region', { name: 'Infrastructure node' })).toBeInTheDocument();
      expect(
        screen.getByLabelText('Contextual node actions').querySelectorAll('button').length,
      ).toBeGreaterThan(1);
      const saved = structuredClone(game);
      act(() => useGameStore.getState().saveAndQuit());
      fireEvent.click(screen.getByRole('button', { name: 'RESUME GAME' }));
      expect(screen.getByText('[ RESUME SAVED GAME ]')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
      expect(useGameStore.getState().game).toEqual(saved);
    },
  );
  it('opens authored scenarios through Play Scenario, separately from campaign creation', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'PLAY SCENARIO' }));
    fireEvent.click(screen.getByRole('button', { name: 'CAPTURE AFTER MOVEMENT' }));
    enterPrices();
    fireEvent.click(screen.getByRole('button', { name: 'START SCENARIO' }));
    expect(useGameStore.getState().game!.settings.commanderTrainingCp).toBe(11);
    expect(useGameStore.getState().game!.settings.infrastructure!.id).toBe(
      'prepared-foundation-capture-move',
    );
  });
  it('loads custom configuration for editing, then starts without setup or balance overrides', async () => {
    const settings = {
      ...defaultSettings(),
      seed: 92,
      commanderTrainingCp: 13,
      fog: false,
      controllers: { A: 'human' as const, B: 'human' as const },
    };
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'CREATE CAMPAIGN' }));
    fireEvent.change(screen.getByLabelText('Import campaign configuration or preset'), {
      target: { files: [file(JSON.stringify(configurationDocument(settings)))] },
    });
    await screen.findByRole('status');
    expect(useGameStore.getState().game).toBeNull();
    expect(screen.getByLabelText('MAP SEED')).toHaveValue(92);
    fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
    expect(useGameStore.getState().game).toEqual(createGame(settings));
  });
  it('reports malformed or wrong-kind configuration without replacing a game', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'CREATE CAMPAIGN' }));
    fireEvent.change(screen.getByLabelText('Import campaign configuration or preset'), {
      target: { files: [file(serializeSave(createGame(defaultSettings())))] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Use Resume saved game');
    expect(useGameStore.getState().game).toBeNull();
  });
});

describe('custom configuration boundary', () => {
  it('rejects oversized maps before generation and rejects free/negative training prices', () => {
    const settings = { ...defaultSettings(), commanderTrainingCp: 11 };
    for (const commanderTrainingCp of [0, -1, 1.5, undefined])
      expect(() =>
        parseCampaignConfiguration(
          JSON.stringify(configurationDocument({ ...settings, commanderTrainingCp })),
        ),
      ).toThrow();
    expect(() =>
      parseCampaignConfiguration(
        JSON.stringify(
          configurationDocument({ ...settings, grid: { ...settings.grid, mainCols: 1_000_000 } }),
        ),
      ),
    ).toThrow();
    expect(() => parseCampaignConfiguration('{')).toThrow();
    expect(() =>
      parseCampaignConfiguration(
        JSON.stringify({
          ...configurationDocument(settings),
          requiredCodeCapabilities: ['future-poc-v1'],
        }),
      ),
    ).toThrow(/matching feature branch/);
    expect(parseCampaignConfiguration(JSON.stringify(configurationDocument(settings)))).toEqual(
      settings,
    );
  });
});

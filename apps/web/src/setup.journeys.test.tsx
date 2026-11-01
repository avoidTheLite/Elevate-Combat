// GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002; GAMES-ELEVATE-SESSION-UC-001: visible setup journeys.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createGame, defaultSettings, serializeSave } from '@iron-ridge/engine';
import App from './App.tsx';
import { useGameStore } from './stores/useGameStore.ts';
import { configurationDocument, parseCampaignConfiguration } from './lib/campaignScenarios.ts';

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
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
    expect(screen.getByLabelText('Commander training price (CP)')).toHaveValue(15);
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeEnabled();
    price('Commander training price (CP)', '');
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'TURN-START CAPTURE' })).toBeVisible();
    enterPrices(false);
    fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
    const game = useGameStore.getState().game!;
    expect(game.settings.commanderTrainingCp).toBe(11);
    expect(game.infrastructure).toBeUndefined();
    expect(screen.getByText(/Classic campaign: recruit at HQ/)).toBeInTheDocument();
    expect(screen.queryByText('INFRASTRUCTURE NODE')).not.toBeInTheDocument();
  });
  it.each(['SIMPLE NODES', 'ADVANCED SEEDED NODES'])(
    'starts %s with its actual map and visible node controls',
    (mode) => {
      render(<App />);
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
      expect(screen.getByLabelText('Node order')).toBeInTheDocument();
      expect(screen.getByLabelText('Node order').querySelectorAll('option').length).toBeGreaterThan(
        1,
      );
      const saved = structuredClone(game);
      act(() => useGameStore.getState().saveAndQuit());
      expect(screen.getByText('[ RESUME SAVED GAME ]')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
      expect(useGameStore.getState().game).toEqual(saved);
    },
  );
  it('can discover a team scenario directly from Classic setup', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'CAPTURE AFTER MOVEMENT' }));
    expect(screen.getByRole('button', { name: 'SIMPLE NODES' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    enterPrices();
    fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
    expect(useGameStore.getState().game!.settings.commanderTrainingCp).toBe(11);
    expect(useGameStore.getState().game!.settings.infrastructure!.id).toBe(
      'prepared-foundation-capture-move',
    );
  });
  it('starts custom configuration as a fresh run without setup or balance overrides', async () => {
    const settings = {
      ...defaultSettings(),
      seed: 92,
      commanderTrainingCp: 13,
      fog: false,
      controllers: { A: 'human' as const, B: 'human' as const },
    };
    render(<App />);
    fireEvent.change(screen.getByLabelText('Start from campaign configuration'), {
      target: { files: [file(JSON.stringify(configurationDocument(settings)))] },
    });
    await waitFor(() => expect(useGameStore.getState().game).not.toBeNull());
    expect(useGameStore.getState().game).toEqual(createGame(settings));
  });
  it('reports malformed or wrong-kind configuration without replacing a game', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Start from campaign configuration'), {
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

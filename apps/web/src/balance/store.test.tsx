import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseUnitType, defaultSettings } from '@iron-ridge/engine';
import App from '../App.tsx';
import { useGameStore } from '../stores/useGameStore.ts';
import {
  BALANCE_KEY,
  labEnabled,
  loadActiveRules,
  useBalanceStore,
  withActiveRules,
} from './store.ts';

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useGameStore.getState().quit();
    useBalanceStore.setState({
      view: 'setup',
      active: undefined,
      draft: {},
      dirtyCards: {},
      setup: { ...defaultSettings(), commanderTrainingCp: 11 },
      setupError: null,
      setupSelection: null,
    });
  });
});

describe('balance store', () => {
  it('is enabled in dev/test builds', () => {
    expect(labEnabled()).toBe(true);
  });

  it('saveUnit commits valid overrides and rejects invalid ones with errors', () => {
    const s = useBalanceStore.getState();
    expect(s.saveUnit('ww2_tank', { hp: 30 })).toEqual([]);
    expect(useBalanceStore.getState().draft).toEqual({ units: { ww2_tank: { hp: 30 } } });
    const errs = s.saveUnit('ww2_tank', { hp: -4 });
    expect(errs[0]).toMatch(/hp: -4 outside/);
    // Invalid save leaves the draft untouched.
    expect(useBalanceStore.getState().draft).toEqual({ units: { ww2_tank: { hp: 30 } } });
    // Saving "no override" removes the unit entry again.
    expect(s.saveUnit('ww2_tank', undefined)).toEqual([]);
    expect(useBalanceStore.getState().draft).toEqual({});
  });

  it('applyAll persists to localStorage and new games carry settings.rules', () => {
    const s = useBalanceStore.getState();
    s.saveUnit('ww2_tank', { hp: 31 });
    s.saveMechanics({ BLIND_FIRE_TN: 4 });
    const applied = s.applyAll();
    const expected = { units: { ww2_tank: { hp: 31 } }, mechanics: { BLIND_FIRE_TN: 4 } };
    expect(applied).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(BALANCE_KEY)!)).toEqual(expected);
    expect(loadActiveRules()).toEqual(expected);
    expect(withActiveRules(defaultSettings()).rules).toEqual(expected);

    // Applying an empty draft clears storage.
    useBalanceStore.getState().resetDraft();
    expect(useBalanceStore.getState().applyAll()).toBeUndefined();
    expect(localStorage.getItem(BALANCE_KEY)).toBeNull();
    expect(withActiveRules(defaultSettings()).rules).toBeUndefined();
  });

  it('ignores corrupt stored overrides', () => {
    localStorage.setItem(BALANCE_KEY, '{"units":{"nope":{}}}');
    expect(loadActiveRules()).toBeUndefined();
    localStorage.setItem(BALANCE_KEY, 'not json');
    expect(loadActiveRules()).toBeUndefined();
  });

  it('importJson validates', () => {
    const s = useBalanceStore.getState();
    expect(s.importJson('{')).toHaveLength(1);
    expect(s.importJson('{"units":{"ww2_tank":{"hp":0}}}')[0]).toMatch(/hp: 0 outside/);
    expect(s.importJson('{"units":{"ww2_tank":{"hp":22}}}')).toEqual([]);
    expect(useBalanceStore.getState().draft).toEqual({ units: { ww2_tank: { hp: 22 } } });
  });
});

describe('SetupScreen integration', () => {
  it('START NEW GAME passes the applied override as settings.rules and shows a badge', async () => {
    const hp = baseUnitType('ww2_tank').hp + 9;
    act(() => {
      useBalanceStore.getState().saveUnit('ww2_tank', { hp });
      useBalanceStore.getState().applyAll();
    });
    render(<App />);
    expect(screen.getByTestId('custom-rules-badge')).toHaveTextContent(/custom rules active/i);
    fireEvent.change(screen.getByLabelText('Commander training price (CP)'), {
      target: { value: '11' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));
    await screen.findByRole('button', { name: /end turn/i });
    expect(useGameStore.getState().game!.settings.rules).toEqual({ units: { ww2_tank: { hp } } });
  });

  it('badge RESET clears the override; new games use the baseline', async () => {
    act(() => {
      useBalanceStore.getState().saveUnit('ww2_tank', { hp: 40 });
      useBalanceStore.getState().applyAll();
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /reset custom rules/i }));
    expect(screen.queryByTestId('custom-rules-badge')).toBeNull();
    fireEvent.change(screen.getByLabelText('Commander training price (CP)'), {
      target: { value: '11' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));
    await screen.findByRole('button', { name: /end turn/i });
    expect(useGameStore.getState().game!.settings.rules).toBeUndefined();
  });

  it('does not launch fallback Classic through the lab when selected Advanced prices are missing', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'ADVANCED SEEDED NODES' }));
    fireEvent.change(screen.getByLabelText('MAP SEED'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('NON-HQ NODES'), { target: { value: '5' } });
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /balance lab/i }));
    expect(screen.getByRole('button', { name: /apply & new game/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Advanced seeded nodes cannot start yet/);
    fireEvent.click(screen.getByRole('button', { name: /apply & new game/i }));
    expect(useGameStore.getState().game).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /back to setup/i }));
    expect(screen.getByRole('button', { name: 'ADVANCED SEEDED NODES' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Commander training price (CP)')).toHaveValue(null);
    expect(screen.getByLabelText('Capture Node price (CP)')).toHaveValue(null);
    expect(screen.getByLabelText('MAP SEED')).toHaveValue(42);
    expect(screen.getByLabelText('NON-HQ NODES')).toHaveValue('5');
    fireEvent.change(screen.getByLabelText('Commander training price (CP)'), {
      target: { value: '11' },
    });
    fireEvent.click(screen.getByRole('button', { name: /balance lab/i }));
    expect(screen.getByRole('button', { name: /apply & new game/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Capture\/Raze CP prices/);
    expect(useGameStore.getState().game).toBeNull();
  });

  it('keeps the same configured Advanced map, players, costs and draft rules through the lab launch', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'ADVANCED SEEDED NODES' }));
    fireEvent.click(screen.getByRole('button', { name: 'HOTSEAT 2P' }));
    fireEvent.change(screen.getByLabelText('Commander training price (CP)'), {
      target: { value: '11' },
    });
    fireEvent.change(screen.getByLabelText('Capture Node price (CP)'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Raze Node price (CP)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('MAP SEED'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('NON-HQ NODES'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /balance lab/i }));
    const source = structuredClone(useBalanceStore.getState().setup);
    act(() => {
      useBalanceStore.getState().saveUnit('ww2_tank', { hp: 29 });
    });
    fireEvent.click(screen.getByRole('button', { name: /apply & new game/i }));
    const game = useGameStore.getState().game!;
    expect(game.settings).toEqual({ ...source, rules: { units: { ww2_tank: { hp: 29 } } } });
    expect(game.settings.infrastructure?.nodes.placement).toEqual({
      mode: 'advanced',
      seed: 42,
      additionalNodes: 5,
    });
    expect(game.infrastructure?.sites).toHaveLength(7);
    expect(game.settings.controllers).toEqual({ A: 'human', B: 'human' });
    expect(game.settings.commanderTrainingCp).toBe(11);
  });

  it('BALANCE LAB button opens the lab with the current setup', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /medieval/i }));
    fireEvent.click(screen.getByRole('button', { name: /balance lab/i }));
    expect(useBalanceStore.getState().view).toBe('lab');
    expect(useBalanceStore.getState().setupSelection?.settings.era).toBe('medieval');
    expect(useBalanceStore.getState().setupError).toMatch(/commander training/);
    expect(screen.getByText(/▲ BALANCE LAB/)).toBeInTheDocument();
  });
});

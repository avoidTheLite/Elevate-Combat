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
      setup: defaultSettings(),
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
    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));
    await screen.findByRole('button', { name: /end turn/i });
    expect(useGameStore.getState().game!.settings.rules).toBeUndefined();
  });

  it('BALANCE LAB button opens the lab with the current setup', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /medieval/i }));
    fireEvent.click(screen.getByRole('button', { name: /balance lab/i }));
    expect(useBalanceStore.getState().view).toBe('lab');
    expect(useBalanceStore.getState().setup.era).toBe('medieval');
    expect(screen.getByText(/▲ BALANCE LAB/)).toBeInTheDocument();
  });
});

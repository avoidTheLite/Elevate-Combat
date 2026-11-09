import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { GameLog } from './GameLog.tsx';
import { PlayerSettings } from './PlayerSettings.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import { useMapControls } from '../../controls/useMapControls.ts';
import { strategicGame } from '../../lib/testGames.ts';
import {
  CONTROL_PREFERENCES_KEY,
  DEFAULT_CONTROL_PREFERENCES,
  readControlPreferences,
  saveControlPreferences,
} from '../../controls/preferences.ts';

beforeEach(() => {
  localStorage.clear();
  useGameStore.getState().quit();
});
afterEach(() => {
  vi.restoreAllMocks();
  saveControlPreferences({ ...DEFAULT_CONTROL_PREFERENCES });
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: interface feedback regressions', () => {
  it('lets native Tab reach SESSION STATUS, wraps both directions and restores the opener after Escape or close', () => {
    const game = strategicGame();
    function Harness(): React.ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>OPEN LOG</button>
          {open && <GameLog game={game} view="A" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const opener = screen.getByRole('button', { name: 'OPEN LOG' });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole('button', { name: 'CLOSE LOG' });
    const summary = screen.getByText('SESSION STATUS');
    expect(close).toHaveFocus();
    // jsdom has no native sequential focus default; do not let the trap cancel it.
    expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(true);
    summary.focus();
    expect(fireEvent.keyDown(summary, { key: 'Tab' })).toBe(false);
    expect(close).toHaveFocus();
    expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(summary.parentElement).toHaveAttribute('open');
    fireEvent.keyDown(summary, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'CLOSE LOG' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it.each(['normal', 'quota', 'blocked'] as const)(
    '%s storage keeps cumulative live preferences synchronized across Settings, multiple controls and remounts',
    (mode) => {
      const game = strategicGame();
      const persisted = { ...DEFAULT_CONTROL_PREFERENCES, quickAttack: true, overlap: 40 };
      saveControlPreferences(persisted);
      const originalSet = Storage.prototype.setItem;
      if (mode !== 'normal')
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          throw new DOMException(mode, mode === 'quota' ? 'QuotaExceededError' : 'SecurityError');
        });
      if (mode === 'blocked')
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
          throw new DOMException('blocked', 'SecurityError');
        });
      useGameStore.setState({ game, handoff: null });
      const a = renderHook(() =>
        useMapControls(
          useGameStore((s) => s.game)!,
          useGameStore((s) => s.ui),
          false,
        ),
      );
      const b = renderHook(() =>
        useMapControls(
          useGameStore((s) => s.game)!,
          useGameStore((s) => s.ui),
          false,
        ),
      );
      let settings = render(<PlayerSettings onClose={() => {}} />);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Quick Move' }));
      expect(screen.getByRole('checkbox', { name: 'Quick Move' })).toBeChecked();
      expect(a.result.current.preferences.quickMove).toBe(true);
      // Use the same captured callback twice before React rerenders: merges must use live session state.
      const set = a.result.current.setPreference;
      act(() => {
        set({ dwellMs: 1200 });
        set({ animationMs: 300 });
      });
      expect(readControlPreferences()).toMatchObject({
        quickMove: true,
        quickAttack: true,
        overlap: 40,
        dwellMs: 1200,
        animationMs: 300,
      });
      expect(b.result.current.preferences).toEqual(a.result.current.preferences);
      expect(screen.getByLabelText('Hover delay')).toHaveValue('1200');
      settings.unmount();
      settings = render(<PlayerSettings onClose={() => {}} />);
      expect(screen.getByRole('checkbox', { name: 'Quick Move' })).toBeChecked();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Quick Attack' }));
      expect(a.result.current.preferences).toMatchObject({
        quickMove: true,
        quickAttack: false,
        dwellMs: 1200,
        animationMs: 300,
      });
      // Other keys cannot reset this tab's live controls.
      act(() =>
        window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: null })),
      );
      expect(a.result.current.preferences.quickMove).toBe(true);
      // Real other-tab storage events include their authoritative newValue.
      const external = { ...readControlPreferences(), easing: 'linear' as const, overlap: 60 };
      originalSet.call(localStorage, CONTROL_PREFERENCES_KEY, JSON.stringify(external));
      act(() =>
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: CONTROL_PREFERENCES_KEY,
            newValue: JSON.stringify(external),
          }),
        ),
      );
      expect(a.result.current.preferences).toEqual(external);
      expect(b.result.current.preferences).toEqual(external);
      expect(screen.getByRole('combobox', { name: 'Animation easing' })).toHaveValue('linear');
      act(() => a.result.current.setPreference({ dwellMs: 1500 }));
      expect(b.result.current.preferences).toMatchObject({
        easing: 'linear',
        overlap: 60,
        dwellMs: 1500,
        quickMove: true,
      });
      expect(useGameStore.getState().game).toBe(game);
      settings.unmount();
      a.unmount();
      b.unmount();
    },
  );
});

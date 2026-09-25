// Web save/load journeys, driven by the engine's standard save fixtures
// (packages/engine/fixtures/saves — regenerate with `pnpm --filter
// @iron-ridge/engine fixtures:saves`).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { actingTeam, deserializeSave } from '@iron-ridge/engine';
import type { GameState } from '@iron-ridge/engine';
import App from './App.tsx';
import { useGameStore } from './stores/useGameStore.ts';
import { LEGACY_SAVE_KEY, slotKey } from './stores/saveSlots.ts';

const RAW = import.meta.glob('../../../packages/engine/fixtures/saves/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const FIXTURES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, text]) => [path.split('/').pop()!.replace('.json', ''), text]),
);
const PLAYABLE = Object.keys(FIXTURES)
  .filter((n) => n !== 'corrupt' && n !== 'truncated')
  .sort();

function stateOf(name: string): GameState {
  const r = deserializeSave(FIXTURES[name]!);
  if (!r.ok) throw new Error(r.error);
  return r.save.state;
}

const store = (): ReturnType<typeof useGameStore.getState> => useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  act(() => {
    store().quit();
    useGameStore.setState({ loadError: null, saveNotice: null });
  });
});

describe('fixtures are available', () => {
  it('finds the standard set', () => {
    expect(PLAYABLE).toEqual(
      expect.arrayContaining([
        'strategic-t1',
        'strategic-midgame',
        'battle-pending',
        'battle-deploy',
        'battle-combat',
        'battle-over',
        'hotseat-fog',
        'with-rules-override',
        'legacy-0.9.0',
      ]),
    );
    expect(FIXTURES.corrupt).toBeDefined();
  });
});

describe('Continue from each fixture (autosave slot)', () => {
  it.each(PLAYABLE)('%s', (name) => {
    localStorage.setItem(slotKey('autosave'), FIXTURES[name]!);
    expect(store().hasSave()).toBe(true);
    let ok = false;
    act(() => {
      useGameStore.setState({ fx: null, fxBusyUntil: 123, lastOutcome: null });
      ok = store().loadSaved();
    });
    expect(ok).toBe(true);
    const s = store();
    expect(s.game).toEqual(stateOf(name));
    expect(s.loadError).toBeNull();
    expect(s.fx).toBeNull();
    expect(s.fxBusyUntil).toBe(0);
    expect(s.lastOutcome).toBeNull();
    const hotseat =
      s.game!.settings.controllers.A === 'human' &&
      s.game!.settings.controllers.B === 'human' &&
      s.game!.settings.fog;
    expect(s.handoff).toBe(hotseat ? actingTeam(s.game!) : null);
  });

  it.each(PLAYABLE)('renders App with %s loaded without crashing', (name) => {
    act(() => {
      store().importSave(FIXTURES[name]!);
    });
    render(<App />);
    expect(screen.getAllByText(new RegExp(`TURN ${store().game!.turn}`)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
  });

  it('hotseat fixture shows the hand-off screen first', () => {
    localStorage.setItem(slotKey('autosave'), FIXTURES['hotseat-fog']!);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    const team = actingTeam(store().game!) === 'A' ? 'ALPHA' : 'BRAVO';
    expect(screen.getByRole('button', { name: new RegExp(`I AM ${team}`) })).toBeInTheDocument();
    expect(screen.getByText(/pass the device/i)).toBeInTheDocument();
  });
});

describe('manual save slots', () => {
  it('save → list → load → delete via the store', () => {
    act(() => {
      store().importSave(FIXTURES['strategic-t1']!);
    });
    expect(store().saveToSlot('slot1', 'Alpha plan')).toBe(true);
    const info = store()
      .listSlots()
      .find((s) => s.slot === 'slot1')!;
    expect(info).toMatchObject({
      ok: true,
      label: 'Alpha plan',
      turn: 1,
      phase: 'strategic',
      era: 'ww2',
      controllers: { A: 'human', B: 'ai' },
    });
    expect(Date.parse(info.savedAt!)).not.toBeNaN();
    const saved = store().game;
    act(() => {
      store().dispatch({ type: 'recruit', typeId: 'ww2_rifle_infantry' });
    });
    expect(store().game).not.toEqual(saved);
    act(() => {
      expect(store().loadSlot('slot1')).toBe(true);
    });
    expect(store().game).toEqual(saved);
    // Loading a slot also becomes the autosave (Continue resumes it).
    expect(localStorage.getItem(slotKey('autosave'))).not.toBeNull();
    store().deleteSlot('slot1');
    expect(
      store()
        .listSlots()
        .find((s) => s.slot === 'slot1')!.empty,
    ).toBe(true);
    expect(localStorage.getItem(slotKey('slot1'))).toBeNull();
  });

  it('autosaves on every dispatch', () => {
    act(() => {
      store().importSave(FIXTURES['strategic-t1']!);
      store().dispatch({ type: 'recruit', typeId: 'ww2_rifle_infantry' });
    });
    const r = deserializeSave(localStorage.getItem(slotKey('autosave'))!);
    expect(r.ok && r.save.state).toEqual(store().game);
  });

  it('SAVE menu in game → LOAD list on setup restores the game', async () => {
    act(() => {
      store().importSave(FIXTURES['strategic-midgame']!);
    });
    const turn = store().game!.turn;
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save game/i }));
    fireEvent.change(screen.getByLabelText(/save label/i), { target: { value: 'Before push' } });
    fireEvent.click(screen.getByRole('button', { name: /save to slot 2/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/saved to slot 2/i);
    fireEvent.click(screen.getByRole('button', { name: /abandon/i }));
    // Autosave gone, slot 2 still listed.
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Before push/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load slot 2/i }));
    expect(await screen.findByRole('button', { name: /end turn/i })).toBeInTheDocument();
    expect(store().game!.turn).toBe(turn);
  });

  it('DELETE on the load list empties the slot', () => {
    act(() => {
      store().importSave(FIXTURES['battle-combat']!);
      store().saveToSlot('slot3');
      store().quit();
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /delete slot 3/i }));
    expect(screen.queryByRole('button', { name: /load slot 3/i })).not.toBeInTheDocument();
    expect(localStorage.getItem(slotKey('slot3'))).toBeNull();
  });
});

describe('export / import', () => {
  it('round-trips the current game through exported text', () => {
    act(() => {
      store().importSave(FIXTURES['battle-deploy']!);
    });
    const before = store().game;
    const out = store().exportSave()!;
    expect(out.filename).toMatch(/^iron-ridge-ww2-turn\d+-\d{4}-\d\d-\d\d\.json$/);
    expect(JSON.parse(out.text).format).toBe('iron-ridge-save');
    act(() => {
      store().abandon();
    });
    expect(store().game).toBeNull();
    act(() => {
      expect(store().importSave(out.text)).toBe(true);
    });
    expect(store().game).toEqual(before);
    expect(store().hasSave()).toBe(true);
  });

  it('imports a .json file from the setup screen', async () => {
    render(<App />);
    const file = new File([FIXTURES['battle-over']!], 'save.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText(/import save file/i), { target: { files: [file] } });
    await waitFor(() => expect(store().game).not.toBeNull());
    expect(store().game).toEqual(stateOf('battle-over'));
  });

  it('a bad import shows an error and keeps the setup screen', () => {
    render(<App />);
    act(() => {
      expect(store().importSave(FIXTURES.truncated!)).toBe(false);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/import failed.*not valid JSON/i);
    expect(screen.getByRole('button', { name: /start new game/i })).toBeInTheDocument();
  });
});

describe('corrupt and legacy saves', () => {
  it('a corrupt slot is rejected with a message and removed', () => {
    localStorage.setItem(slotKey('slot1'), FIXTURES.corrupt!);
    render(<App />);
    expect(screen.getByText(/CORRUPTED/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load slot 1/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/save was corrupted and has been removed/i);
    expect(localStorage.getItem(slotKey('slot1'))).toBeNull();
    expect(store().game).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /dismiss load error/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a truncated autosave: CONTINUE fails visibly, never crashes', () => {
    localStorage.setItem(slotKey('autosave'), FIXTURES.truncated!);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/corrupted.*not valid JSON/i);
    expect(localStorage.getItem(slotKey('autosave'))).toBeNull();
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
  });

  it('the V0.9 autosave key is migrated into the autosave slot', () => {
    localStorage.setItem(LEGACY_SAVE_KEY, FIXTURES['legacy-0.9.0']!);
    let migrated = false;
    act(() => {
      migrated = store().migrateLegacy();
    });
    expect(migrated).toBe(true);
    expect(localStorage.getItem(LEGACY_SAVE_KEY)).toBeNull();
    const env = JSON.parse(localStorage.getItem(slotKey('autosave'))!);
    expect(env).toMatchObject({
      format: 'iron-ridge-save',
      schema: 2,
      label: 'Autosave (from V0.9)',
    });
    act(() => {
      expect(store().loadSaved()).toBe(true);
    });
    expect(store().game!.version).toBe('1.0.0');
    expect(store().game!.armies.every((a) => a.kind && a.pos)).toBe(true);
  });

  it('the V0.9 key is also picked up lazily by the setup screen', () => {
    localStorage.setItem(LEGACY_SAVE_KEY, FIXTURES['legacy-0.9.0']!);
    render(<App />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByText(/Autosave \(from V0\.9\)/)).toBeInTheDocument();
  });

  it('an unreadable V0.9 key is dropped with a message', () => {
    localStorage.setItem(LEGACY_SAVE_KEY, '{"version":"0.9.0","settings":');
    act(() => {
      expect(store().migrateLegacy()).toBe(false);
    });
    expect(store().loadError).toMatch(/V0\.9 save could not be upgraded/);
    expect(localStorage.getItem(LEGACY_SAVE_KEY)).toBeNull();
  });
});

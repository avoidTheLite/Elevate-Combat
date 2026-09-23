import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App.tsx';
import { useGameStore } from './stores/useGameStore.ts';

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
});

describe('App – setup screen', () => {
  it('renders the title and a START NEW GAME button', () => {
    render(<App />);
    expect(screen.getByText(/iron ridge/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start new game/i })).toBeInTheDocument();
  });

  it('grid sliders update the configured size summary', () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/sub-grid radius/i), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/main cols/i), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/main rows/i), { target: { value: '3' } });
    // 3·3² + 3·3 + 1 = 37 sub-hexes per main hex; 4×3×37 = 444 cells.
    expect(screen.getByText(/37 sub-hexes each · 444 tactical cells/)).toBeInTheDocument();
  });
});

describe('App – game start flow', () => {
  it('START NEW GAME transitions to the strategic view', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /end turn/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/alpha active/i)).toBeInTheDocument();
    // 3D view degrades gracefully without WebGL (jsdom).
    expect(screen.getByText(/3d view unavailable/i)).toBeInTheDocument();
  });

  it('recruiting at HQ spends command points', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));
    await screen.findByRole('button', { name: /end turn/i });
    const before = useGameStore.getState().game!.cp.A;
    fireEvent.click(screen.getByRole('button', { name: /rifle infantry/i }));
    expect(useGameStore.getState().game!.cp.A).toBe(before - 3);
  });

  it('ending the turn hands control to the AI and back', async () => {
    useGameStore.getState().setAiSpeed(1);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));
    fireEvent.click(await screen.findByRole('button', { name: /end turn/i }));
    await waitFor(() => expect(useGameStore.getState().game!.turn).toBe(2), { timeout: 8000 });
    expect(useGameStore.getState().game!.active).toBe('A');
  });

  it('MENU returns to setup and CONTINUE restores the autosave', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));
    fireEvent.click(await screen.findByRole('button', { name: /menu/i }));
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
    expect(await screen.findByRole('button', { name: /end turn/i })).toBeInTheDocument();
  });
});

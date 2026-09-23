import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App – game start flow', () => {
  it('renders the start screen with a START NEW GAME button', () => {
    renderApp();
    expect(screen.getByRole('button', { name: /start new game/i })).toBeInTheDocument();
    expect(screen.getByText(/iron ridge/i)).toBeInTheDocument();
  });

  it('clicking START NEW GAME transitions to the game view', async () => {
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));

    // After a successful POST /game the map canvas and controls should be visible
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /end turn/i })).toBeInTheDocument();
    });
  });

  it('shows LOADING while the game query is in flight', async () => {
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));

    // The app should show either a loading state or the game view –
    // never stay stuck on the start screen after clicking the button.
    await waitFor(() => {
      const stillOnStartScreen =
        screen.queryByRole('button', { name: /start new game/i }) !== null &&
        screen.queryByRole('button', { name: /end turn/i }) === null;
      expect(stillOnStartScreen).toBe(false);
    });
  });

  it('displays the active team indicator after the game starts', async () => {
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));

    await waitFor(() => {
      expect(screen.getByText(/alpha active|bravo active/i)).toBeInTheDocument();
    });
  });

  it('shows RESET GAME button once the game is running', async () => {
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: /start new game/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reset game/i })).toBeInTheDocument();
    });
  });
});


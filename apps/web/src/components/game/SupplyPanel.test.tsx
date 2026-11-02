import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
} from '@iron-ridge/engine';
import { SupplyPanel } from './SupplyPanel.tsx';

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: actual supply inspection', () => {
  it('shows the Home HQ route and selected benefit provider from the real campaign evaluator', () => {
    const game = createGame({
      ...defaultSettings(),
      controllers: { A: 'human', B: 'human' },
      infrastructure: createFoundationPlaytestConfiguration(7, 3),
    });
    render(<SupplyPanel game={game} mainHex={game.hq.A} />);
    expect(screen.getByRole('region', { name: 'Node supply' })).toBeInTheDocument();
    expect(screen.getByText('Route authority')).toBeInTheDocument();
    expect(screen.getByText('Home HQ')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText(/Reconnecting does not replay income/)).toBeInTheDocument();
  });

  it('does not add infrastructure inspection to a classic campaign', () => {
    const { container } = render(
      <SupplyPanel game={createGame(defaultSettings())} mainHex={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { apply } from '@iron-ridge/engine';
import { createMovementDemo } from '../../controls/demoScenario.ts';
import { useGameStore } from '../../stores/useGameStore.ts';
import { useViewStore } from '../../stores/useViewStore.ts';
import { OverlayBar } from './OverlayBar.tsx';
import { TurnControls } from './TurnControls.tsx';
import { PlayerSettings } from './PlayerSettings.tsx';
import { GameLog } from './GameLog.tsx';
import { readControlPreferences } from '../../controls/preferences.ts';
import { blindFireFixture } from '../../controls/reviewFixtures.ts';

beforeEach(() => {
  localStorage.clear();
  useGameStore.getState().quit();
  useViewStore.setState({ overlay: 'basic', detailsVisible: true });
});
describe('GAMES-ELEVATE-CAMPAIGN-UC-002: persistent interface chrome', () => {
  it('toggles details independently from active highlighting through pointer and keyboard', () => {
    render(<OverlayBar battle={null} />);
    const height = screen.getByRole('button', { name: /2 HEIGHT/ });
    fireEvent.click(height);
    expect(useViewStore.getState().overlay).toBe('height');
    expect(height).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(height);
    expect(useViewStore.getState().overlay).toBe('height');
    expect(screen.queryByTestId('overlay-legend')).toBeNull();
    expect(height).toHaveAttribute('aria-pressed', 'true');
    expect(height).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(window, { key: '2' });
    expect(screen.getByTestId('overlay-legend')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '2' });
    // An unrelated click/selection does not reopen details.
    fireEvent.click(document.body);
    expect(screen.queryByTestId('overlay-legend')).toBeNull();
    fireEvent.keyDown(height, { key: '1' });
    expect(useViewStore.getState().overlay).toBe('height');
    fireEvent.keyDown(window, { key: '3' });
    expect(useViewStore.getState().overlay).toBe('control');
    expect(screen.getByTestId('overlay-legend')).toBeInTheDocument();
  });
  it('keeps end turn and retreat native controls outside context, with waiting/phase gates', () => {
    const game = createMovementDemo();
    useGameStore.setState({ game, handoff: null });
    const mounted = render(<TurnControls game={game} />);
    const end = screen.getByRole('button', { name: 'END TURN →' });
    expect(end).toBeEnabled();
    expect(screen.getByRole('button', { name: 'RETREAT' })).toBeEnabled();
    mounted.rerender(<TurnControls game={game} blocked />);
    expect(end).toBeDisabled();
    fireEvent.click(end);
    expect(useGameStore.getState().game).toBe(game);
    const ai = structuredClone(game);
    ai.settings.controllers.A = 'ai';
    mounted.rerender(<TurnControls game={ai} />);
    expect(end).toBeDisabled();
    mounted.rerender(<TurnControls game={game} />);
    const expected = apply(game, { type: 'endBattleTurn' });
    expect(expected.error).toBeNull();
    fireEvent.click(end);
    expect(useGameStore.getState().game).toEqual(expected.state);
  });
  it('shared player settings change preferences without altering current game or save configuration', () => {
    const game = createMovementDemo();
    useGameStore.setState({ game, handoff: null });
    const before = structuredClone(game);
    let closed = 0;
    render(
      <PlayerSettings
        onClose={() => {
          closed++;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Quick Move' }));
    fireEvent.change(screen.getByLabelText('AI pace'), { target: { value: '60' } });
    expect(readControlPreferences().quickMove).toBe(true);
    expect(useGameStore.getState().aiSpeed).toBe(60);
    expect(useGameStore.getState().game).toEqual(before);
    expect(screen.getByRole('button', { name: 'CLOSE SETTINGS' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closed).toBe(1);
  });
  it('header-accessible log filters opponent-private events without exposing global content in selection context', () => {
    const game = createMovementDemo();
    game.settings.fog = true;
    game.log.push(
      { turn: 1, team: 'A', text: 'Own event visible' },
      { turn: 1, team: 'B', text: 'Hidden opponent event' },
    );
    game.battle!.log.push({
      round: 1,
      team: 'B',
      kind: 'info',
      text: 'Hidden tactical opponent event',
    });
    render(<GameLog game={game} view="A" onClose={() => {}} />);
    const log = screen.getByRole('dialog', { name: 'Game log' });
    expect(within(log).getByText(/Own event visible/)).toBeInTheDocument();
    expect(log).not.toHaveTextContent('Hidden opponent event');
    expect(log).not.toHaveTextContent('Hidden tactical opponent event');
  });
  it('does not reveal a hidden blind-fire defender through shooter-owned raw combat messages', () => {
    const empty = blindFireFixture();
    const emptyResult = apply(empty.game, {
      type: 'attack',
      unitId: empty.shooter.id,
      cell: empty.target,
    });
    expect(emptyResult.error).toBeNull();
    const f = blindFireFixture();
    const hidden = f.battle.units.find((unit) => unit.team === 'B')!;
    hidden.pos = f.target;
    hidden.label = 'SECRET DEFENDER';
    const result = apply(f.game, { type: 'attack', unitId: f.shooter.id, cell: f.target });
    expect(result.error).toBeNull();
    expect(result.state.battle!.log.some((entry) => entry.text.includes('SECRET DEFENDER'))).toBe(
      true,
    );
    const mounted = render(<GameLog game={result.state} view="A" onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Game log' })).not.toHaveTextContent(
      /SECRET DEFENDER|vs TN|armor/i,
    );
    const hiddenText = screen.getByRole('dialog', { name: 'Game log' }).textContent;
    mounted.rerender(<GameLog game={emptyResult.state} view="A" onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Game log' }).textContent).toBe(hiddenText);
    mounted.rerender(<GameLog game={result.state} view={null} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Game log' })).toHaveTextContent('SECRET DEFENDER');
  });
});

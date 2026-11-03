import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commanderReach } from '@iron-ridge/engine';
import { GameScreen } from './components/screens/GameScreen.tsx';
import { holderForClick } from './lib/holders.ts';
import { commanderOf, strategicGame } from './lib/testGames.ts';
import { useGameStore } from './stores/useGameStore.ts';

// Exercise the real screen callbacks and store while leaving WebGL to browser proof.
let click: (key: string, button: number) => void;
let hover: (key: string | null) => void;
vi.mock('./components/game/SceneView.tsx', () => ({
  SceneView: (props: { onClick: typeof click; onHover: typeof hover }) => {
    click = props.onClick;
    hover = props.onHover;
    return null;
  },
}));

const store = (): ReturnType<typeof useGameStore.getState> => useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  store().quit();
  const game = strategicGame(false);
  game.settings.controllers.B = 'human';
  useGameStore.setState({ game });
});

function selection(): { start: ReturnType<typeof commanderOf>; dest: string } {
  const start = structuredClone(commanderOf(store().game!, 'A'));
  const dest = [...commanderReach(store().game!, start).keys()].find(
    (key) => key !== start.pos && !holderForClick(store().game!, null, key),
  )!;
  act(() => click(start.pos, 0));
  return { start, dest };
}

describe('commander movement through screen input', () => {
  it('hover and right-click cancel clear a selection without moving or spending steps', () => {
    render(<GameScreen />);
    const { start, dest } = selection();
    const before = structuredClone(store().game);
    act(() => hover(dest));
    expect(store().ui.hoverCell).toBe(dest);
    expect(store().game).toEqual(before);
    act(() => click(dest, 2));
    expect(store().ui.selectedArmy).toBeNull();
    expect(store().game).toEqual(before);
    act(() => click(dest, 0));
    expect(commanderOf(store().game!, 'A')).toEqual(start);
  });

  it('the retained screen callback reads the current turn and cannot move the previous selection', () => {
    render(<GameScreen />);
    const { start, dest } = selection();
    const retained = click;
    act(() => {
      expect(store().dispatch({ type: 'endTurn' })).toBe(true);
    });
    const afterTurn = structuredClone(store().game);
    act(() => retained(dest, 0));
    expect(store().game).toEqual(afterTurn);
    expect(commanderOf(store().game!, 'A')).toEqual(start);
  });

  it('the retained callback follows a loaded session without reusing a saved selection or preview', () => {
    render(<GameScreen />);
    const { start, dest } = selection();
    const retained = click;
    act(() => {
      hover(dest);
      expect(store().saveToSlot('slot1')).toBe(true);
      expect(store().loadSlot('slot1')).toBe(true);
    });
    const afterLoad = structuredClone(store().game);
    expect(store().ui.selectedArmy).toBeNull();
    act(() => retained(dest, 0));
    expect(store().game).toEqual(afterLoad);
    expect(commanderOf(store().game!, 'A')).toEqual(start);
  });

  it('a delayed scene click after quit has no game to mutate', () => {
    const mounted = render(<GameScreen />);
    const { dest } = selection();
    const retained = click;
    mounted.unmount();
    store().quit();
    expect(() => retained(dest, 0)).not.toThrow();
    expect(store().game).toBeNull();
  });
});

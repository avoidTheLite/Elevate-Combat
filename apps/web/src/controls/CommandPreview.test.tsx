import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { contextFor, reachable } from '@iron-ridge/engine';
import type { GameState } from '@iron-ridge/engine';
import { commandAt } from './commands.ts';
import type { MapCommand } from './commands.ts';
import { createMovementDemo, movementDemoFocus } from './demoScenario.ts';
import { useGameStore } from '../stores/useGameStore.ts';
import {
  ATTACK_PREVIEW_COLOR,
  CommandPreviewLine,
  commandRoute,
  commandGlow,
  MOVE_PREVIEW_COLOR,
  CommandConfirmation,
} from './CommandPreview.tsx';
import type { SceneTileAnchor } from './types.ts';
import { TEAM_COLOR } from '../render/spec.ts';

function moveCommand(game: GameState): MapCommand {
  const ui = { ...useGameStore.getState().ui, ...movementDemoFocus(game) };
  const actor = game.battle!.units.find((unit) => unit.id === ui.selectedUnit)!;
  for (const key of reachable(contextFor(game), actor).keys()) {
    const command = commandAt(game, ui, key, 'move');
    if (command && command.path.length >= 3) return command;
  }
  throw new Error('Prepared game must contain a legal multi-step movement route');
}
const anchor = (key: string, x: number, y: number): SceneTileAnchor => ({
  key,
  x,
  y,
  radius: 100,
  width: 200,
  height: 110,
});

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: compact command previews', () => {
  it.each(['CONFIRM MOVE', 'CANCEL'])(
    'rejects a retargeted compatibility click on %s until a fresh press starts on that control',
    (name) => {
      const game = createMovementDemo();
      const command = moveCommand(game);
      let confirmed = 0;
      let cancelled = 0;
      render(
        <CommandConfirmation
          pending={{ game, command, dragging: false }}
          helpId="compat-click"
          confirm={() => {
            confirmed++;
          }}
          cancel={() => {
            cancelled++;
          }}
        />,
      );
      const button = screen.getByRole('button', { name });
      fireEvent.click(button, { detail: 1 });
      expect(confirmed + cancelled).toBe(0);
      fireEvent.pointerDown(button, { button: 0, isPrimary: true });
      fireEvent.pointerCancel(button);
      fireEvent.click(button, { detail: 1 });
      expect(confirmed + cancelled).toBe(0);
      fireEvent.pointerDown(button, { button: 0, isPrimary: true });
      button.focus();
      fireEvent.click(button, { detail: 1 });
      expect(name === 'CONFIRM MOVE' ? confirmed : cancelled).toBe(1);
      // Native keyboard and assistive-technology activation has no pointer press.
      fireEvent.click(button, { detail: 0 });
      expect(name === 'CONFIRM MOVE' ? confirmed : cancelled).toBe(2);
    },
  );
  it('follows every actual movement path cell and refuses a straight shortcut across a missing cell', () => {
    const command = moveCommand(createMovementDemo());
    const anchors = command.path.map((key, i) => anchor(key, i * 40, i % 2 ? 90 : 30));
    const route = commandRoute(command, anchors)!;
    expect(route.split(' ')).toHaveLength(command.path.length);
    expect(route).toContain('L40,90');
    expect(route).toContain('L80,30');
    expect(
      commandRoute(
        command,
        anchors.filter((_, i) => i !== 1),
      ),
    ).toBeNull();
    const view = render(<CommandPreviewLine command={command} anchors={anchors} staged animate />);
    expect(view.container.querySelectorAll('[data-command-route]')).toHaveLength(1);
    expect(view.container.querySelectorAll('.map-command-line')).toHaveLength(1);
    expect(view.container.querySelector('.map-command-route')).toHaveStyle({
      color: MOVE_PREVIEW_COLOR,
    });
    expect(view.container.querySelector('line, circle')).toBeNull();
  });

  it('uses one direct attack arrow in the exact enemy-name red and shares its geometry with the glow', () => {
    const game = createMovementDemo();
    const ui = { ...useGameStore.getState().ui, ...movementDemoFocus(game) };
    const target = game.battle!.units.find(
      (unit) => unit.team === 'B' && unit.typeId === 'ww2_rifle_infantry',
    )!;
    const command = commandAt(game, ui, target.pos!, 'attack')!;
    expect(command.kind).toBe('attack');
    const anchors = [anchor(command.origin, 10, 15), anchor(command.target, 90, 95)];
    const view = render(<CommandPreviewLine command={command} anchors={anchors} staged animate />);
    const route = view.container.querySelector('[data-command-route]')!;
    expect(commandRoute(command, anchors)).toBe('M10,15 L90,95');
    expect(route).toHaveAttribute('d', commandRoute(command, anchors, true));
    expect(ATTACK_PREVIEW_COLOR).toBe(`#${TEAM_COLOR.B.toString(16)}`);
    expect(view.container.querySelector('.map-command-line')).toHaveAttribute(
      'href',
      `#${route.id}`,
    );
    expect(view.container.querySelector('.map-command-glow')).toHaveAttribute(
      'href',
      `#${route.id}`,
    );
  });

  it('transitions the same route into a staged arrow and honors the animation preference', () => {
    const command = moveCommand(createMovementDemo());
    const anchors = command.path.map((key, i) => anchor(key, i * 40, 50));
    const view = render(
      <CommandPreviewLine command={command} anchors={anchors} staged={false} animate />,
    );
    const route = view.container.querySelector('[data-command-route]');
    view.rerender(
      <CommandPreviewLine command={command} anchors={anchors} staged animate={false} />,
    );
    expect(view.container.querySelector('[data-command-route]')).toBe(route);
    expect(view.container.querySelector('.map-command-route')).toHaveAttribute(
      'data-staged',
      'true',
    );
    expect(view.container.querySelector('.map-command-route')).toHaveAttribute(
      'data-motion',
      'off',
    );
  });

  it('focuses accessible confirmation only after release and leaves engine authority to the callbacks', () => {
    const game = createMovementDemo();
    const before = structuredClone(game);
    const command = moveCommand(game);
    let confirmed = 0;
    const cancel = (): void => {};
    const confirm = (): void => {
      confirmed++;
    };
    const pending = { game, command, dragging: true };
    const view = render(
      <CommandConfirmation
        pending={pending}
        anchor={anchor(command.target, 200, 150)}
        helpId="move-test"
        confirm={confirm}
        cancel={cancel}
      />,
    );
    const button = screen.getByRole('button', { name: 'CONFIRM MOVE' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/MP/);
    expect(button).not.toHaveFocus();
    view.rerender(
      <CommandConfirmation
        pending={{ ...pending, dragging: false }}
        anchor={anchor(command.target, 200, 150)}
        helpId="move-test"
        confirm={confirm}
        cancel={cancel}
      />,
    );
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
    button.click();
    expect(confirmed).toBe(1);
    expect(game).toEqual(before);
  });

  it('repeats lights roughly every three tiles on a long route without changing spacing under zoom', () => {
    const command: MapCommand = {
      ...moveCommand(createMovementDemo()),
      origin: '0,0',
      target: '12,0',
      kind: 'attack',
    };
    const style = commandGlow(command) as Record<string, string>;
    const period = Number(style['--map-flow-spacing']);
    expect((period / 100) * 12).toBeCloseTo(3);
    // More than one luminous segment fits the same line; normalized geometry
    // keeps the world spacing unchanged when camera projection changes.
    const view = render(
      <CommandPreviewLine
        command={command}
        anchors={[anchor('0,0', 0, 0), anchor('12,0', 240, 20)]}
        staged={false}
        animate
      />,
    );
    const before = view.container.querySelector('.map-command-glow')!.getAttribute('style');
    view.rerender(
      <CommandPreviewLine
        command={command}
        anchors={[anchor('0,0', 0, 0), anchor('12,0', 960, 80)]}
        staged={false}
        animate
      />,
    );
    expect(view.container.querySelector('.map-command-glow')).toHaveAttribute('style', before);
    expect(100 / period).toBe(4);
  });
});

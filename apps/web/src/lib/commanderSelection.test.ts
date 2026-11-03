// GAMES-ELEVATE-CAMPAIGN-UC-002: holder selection and commander movement routes.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  commanderReach,
  createGame,
  hexDistance,
  setHolderPos,
  validateGameState,
  worldOf,
} from '@iron-ridge/engine';
import { buildStrategicScene } from '../render/buildScene.ts';
import { useGameStore } from '../stores/useGameStore.ts';
import { regularPlaytestSettings } from './campaignScenarios.ts';
import { holderForClick, reachPath } from './holders.ts';
import { strategicClick } from './strategicClick.ts';
import { alphaGarrison, commanderOf, strategicGame } from './testGames.ts';

beforeEach(() => {
  localStorage.clear();
  useGameStore.getState().quit();
});

describe('commander selection and route regressions', () => {
  it.each(['classic', 'ready'] as const)(
    '%s: a nearby commander takes selection precedence over the HQ footprint',
    (preset) => {
      const game = preset === 'ready' ? createGame(regularPlaytestSettings()) : strategicGame(true);
      const first = commanderOf(game, 'A');
      const hq = alphaGarrison(game);
      const dest = [...commanderReach(game, first).keys()].find(
        (key) => key !== first.pos && holderForClick(game, 'A', key)?.id === hq.id,
      )!;
      expect(dest).toBeDefined();
      const second = structuredClone(first);
      second.id = 'nearby-commander';
      second.units = [first.units.pop()!];
      setHolderPos(worldOf(game).world, second, dest);
      game.armies.push(second);
      useGameStore.setState({ game });

      expect(holderForClick(game, 'A', dest)?.id).toBe(second.id);
      for (let count = 0; count < 10; count++) {
        for (const holder of [first, second, hq, second, first]) {
          strategicClick(holder.pos);
          expect(useGameStore.getState().game).toBe(game);
          expect(useGameStore.getState().ui.selectedArmy).toBe(holder.id);
        }
      }
      expect(validateGameState(game)).toEqual([]);
    },
  );

  it.each(['classic', 'ready'] as const)(
    '%s: move previews retain paths through passable HQ selection cells',
    (preset) => {
      const game = preset === 'ready' ? createGame(regularPlaytestSettings()) : strategicGame(true);
      const commander = commanderOf(game, 'A');
      const hq = alphaGarrison(game);
      const { world } = worldOf(game);
      let route: { start: string; dest: string; path: string[]; cost: number } | undefined;
      // Find a route which must retain a passable HQ selection cell as an intermediate step.
      for (const origin of world.subs.filter(
        (cell) => hexDistance(cell.hex, world.subByKey.get(hq.pos)!.hex) === 2,
      )) {
        if (game.armies.some((holder) => holder.id !== commander.id && holder.pos === origin.key))
          continue;
        setHolderPos(world, commander, origin.key);
        const reach = commanderReach(game, commander);
        for (const [dest, cost] of reach) {
          if (dest === commander.pos || holderForClick(game, 'A', dest)) continue;
          const path = reachPath(game, reach, commander.pos, dest);
          if (path.slice(1, -1).some((key) => holderForClick(game, 'A', key)?.id === hq.id)) {
            route = { start: origin.key, dest, path, cost };
            break;
          }
        }
        if (route) break;
      }
      expect(route).toBeDefined();
      useGameStore.setState({ game });
      strategicClick(route!.start);
      const before = structuredClone(game);
      const scene = buildStrategicScene(
        game,
        { ...useGameStore.getState().ui, hoverCell: route!.dest },
        'A',
      );
      expect(scene.path).toEqual(route!.path);
      expect(scene.path).toHaveLength(route!.cost + 1);
      expect(game).toEqual(before);

      strategicClick(route!.dest);
      const moved = commanderOf(useGameStore.getState().game!, 'A');
      expect(moved.pos).toBe(route!.dest);
      expect(moved.movesLeft).toBe(commander.movesLeft - route!.cost);
      expect(validateGameState(useGameStore.getState().game!)).toEqual([]);
    },
  );
});

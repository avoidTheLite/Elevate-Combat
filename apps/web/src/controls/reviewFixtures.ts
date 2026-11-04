// Test/browser initial state for a real legal blind-fire command, not a fabricated outcome.
import type { GameState, Battle, BattleUnit } from '@iron-ridge/engine';
import type { UiState } from '../stores/useGameStore.ts';
import { buildContext, previewAttack, unitType, validateGameState } from '@iron-ridge/engine';
import { createMovementDemo, movementDemoFocus } from './demoScenario.ts';
import { useGameStore } from '../stores/useGameStore.ts';

export function blindFireFixture(): {
  game: GameState;
  battle: Battle;
  shooter: BattleUnit;
  target: string;
  ui: UiState;
} {
  const game = createMovementDemo();
  game.settings.fog = true;
  const battle = game.battle!;
  const shooter = battle.units.find((u) => u.id === movementDemoFocus(game).selectedUnit)!;
  const source = game.armies
    .find((a) => a.id === shooter.holderId)!
    .units.find((u) => u.id === shooter.id)!;
  shooter.typeId = source.typeId = 'ww2_artillery';
  shooter.hp = source.hp = shooter.maxHp = unitType(shooter.typeId).hp;
  shooter.deployed = true;
  const ctx = buildContext(game.settings, battle);
  const target = [...ctx.cells].find((key) => {
    const p = previewAttack(ctx, battle, shooter, key);
    return key !== shooter.pos && !ctx.unitAt.has(key) && p.legal && p.blind;
  });
  if (!target) throw new Error('Blind-fire fixture needs an unspotted legal empty target');
  const errors = validateGameState(game);
  if (errors.length) throw new Error(errors.join('; '));
  const ui = {
    ...useGameStore.getState().ui,
    ...movementDemoFocus(game),
    selectedUnit: shooter.id,
  };
  return { game, battle, shooter, target, ui };
}

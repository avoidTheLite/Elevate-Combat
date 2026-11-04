import type { GameAction, GameState } from '@iron-ridge/engine';
import {
  apply,
  COMMAND,
  contextFor,
  createGame,
  defaultSettings,
  hexDistance,
  parseKey,
  previewAttack,
  reachable,
  setHolderPos,
  validateGameState,
  worldOf,
} from '@iron-ridge/engine';

const DEMO_MARKER =
  'Prepared movement controls sandbox: initial positions only; no combat outcome awarded.';

export function isMovementDemo(game: GameState): boolean {
  return game.log.some((entry) => entry.text === DEMO_MARKER);
}

/** Engine-initialized battle with explicitly prepared, valid initial deployment positions. */
export function createMovementDemo(): GameState {
  let game = createGame({
    ...defaultSettings(),
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    seed: 1,
    fog: false,
    controllers: { A: 'human', B: 'human' },
    battleRounds: 12,
  });
  const step = (action: GameAction): void => {
    const result = apply(game, action);
    if (result.error) throw new Error(`Controls sandbox: ${result.error}`);
    game = result.state;
  };
  const world = worldOf(game).world;
  const alpha = game.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
  const bravo = game.armies.find((army) => army.team === 'B' && army.kind === 'commander')!;
  const aCell = world.subs.find(
    (cell) =>
      cell.main !== game.hq.A &&
      cell.main !== game.hq.B &&
      world.subs.some(
        (other) =>
          other.main !== cell.main &&
          other.main !== game.hq.A &&
          other.main !== game.hq.B &&
          hexDistance(cell.hex, other.hex) <= COMMAND.engageRange(game.settings.grid.subRadius),
      ),
  )!;
  const bCell = world.subs.find(
    (cell) =>
      cell.main !== aCell.main &&
      cell.main !== game.hq.A &&
      cell.main !== game.hq.B &&
      hexDistance(aCell.hex, cell.hex) <= COMMAND.engageRange(game.settings.grid.subRadius),
  )!;
  setHolderPos(world, alpha, aCell.key);
  setHolderPos(world, bravo, bCell.key);
  step({ type: 'engage', armyId: alpha.id, targetId: bravo.id });
  step({ type: 'startBattle' });
  step({ type: 'finishDeploy' });
  step({ type: 'finishDeploy' });
  const battle = game.battle!;
  const rifle = battle.units.find(
    (unit) => unit.team === 'A' && unit.typeId === 'ww2_rifle_infantry',
  )!;
  const target = battle.units.find(
    (unit) => unit.team === 'B' && unit.typeId === 'ww2_rifle_infantry',
  )!;
  const ctx = contextFor(game);
  const cells = [...ctx.cells].filter((key) => !battle.forts[key]);
  const pair = cells
    .flatMap((a) =>
      cells
        .filter(
          (b) => hexDistance(parseKey(a), parseKey(b)) === 2 && ctx.heightOf(a) === ctx.heightOf(b),
        )
        .map((b) => [a, b] as const),
    )
    .find(([a, b]) => {
      rifle.pos = a;
      target.pos = b;
      const probe = contextFor(game);
      return previewAttack(probe, battle, rifle, b).legal;
    });
  if (!pair) throw new Error('Controls sandbox has no legal initial rifle target');
  rifle.pos = pair[0];
  target.pos = pair[1];
  const taken = new Set<string>(pair);
  const remainder = cells
    .filter((key) => !taken.has(key))
    .sort(
      (a, b) =>
        hexDistance(parseKey(a), parseKey(pair[0])) - hexDistance(parseKey(b), parseKey(pair[0])) ||
        a.localeCompare(b),
    );
  const friendlies = battle.units.filter((unit) => unit.team === 'A' && unit.id !== rifle.id);
  const enemies = battle.units.filter((unit) => unit.team === 'B' && unit.id !== target.id);
  for (const unit of friendlies) {
    unit.pos = remainder.shift()!;
    taken.add(unit.pos);
  }
  for (const unit of enemies) {
    unit.pos = remainder.pop()!;
    taken.add(unit.pos);
  }
  const ready = contextFor(game);
  if (!previewAttack(ready, battle, rifle, target.pos!).legal || reachable(ready, rifle).size <= 1)
    throw new Error('Controls sandbox requires a legal move and attack');
  game.log.push({ turn: game.turn, team: 'A', text: DEMO_MARKER });
  battle.log.push({ round: battle.round, team: 'A', kind: 'info', text: DEMO_MARKER });
  const errors = validateGameState(game);
  if (errors.length) throw new Error(`Controls sandbox validation: ${errors.join('; ')}`);
  return game;
}

export function movementDemoFocus(game: GameState): {
  selectedUnit: string | null;
  hoverCell: null;
} {
  return {
    selectedUnit:
      game.battle?.units.find((unit) => unit.team === 'A' && unit.typeId === 'ww2_rifle_infantry')
        ?.id ?? null,
    hoverCell: null,
  };
}

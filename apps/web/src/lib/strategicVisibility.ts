import type { GameState, HexKey, Team } from '@iron-ridge/engine';
import { isPresent, strategicVisibleCells, worldOf } from '@iron-ridge/engine';

export interface StrategicKnowledge {
  cells: ReadonlySet<HexKey>;
  mains: ReadonlySet<HexKey>;
  /** Missing keys are unknown; null means observed neutral territory. */
  owners: ReadonlyMap<HexKey, Team | null>;
}

// A scene rebuilds on hover; its map knowledge does not. Keep at most one
// projection per view/state and check sight inputs so mutable review fixtures
// cannot return stale visibility or ownership. Generated terrain is included.
const projections = new WeakMap<
  GameState,
  Map<Team | null, { fingerprint: string; value: StrategicKnowledge }>
>();

/** Pure presentation: retain observed owners, but never remember units or buildings. */
export function strategicKnowledge(game: GameState, view: Team | null): StrategicKnowledge {
  const { world, terrain } = worldOf(game);
  const fingerprint = JSON.stringify([
    game.settings.fog,
    game.settings.seed,
    game.settings.grid,
    terrain.heights.join(','),
    Object.entries(game.hexes).map(([key, hex]) => [key, hex.owner]),
    game.armies.filter(isPresent).map((holder) => [holder.team, holder.pos]),
    view ? game.ownershipKnowledge?.[view] : null,
  ]);
  const cached = projections.get(game)?.get(view);
  if (cached?.fingerprint === fingerprint) return cached.value;
  const cells =
    view && game.settings.fog
      ? strategicVisibleCells(game, view)
      : new Set(world.subs.map((cell) => cell.key));
  const mains = new Set<HexKey>();
  for (const key of cells) mains.add(world.subByKey.get(key)!.main);
  const owners = new Map<HexKey, Team | null>(
    view && game.settings.fog ? Object.entries(game.ownershipKnowledge?.[view] ?? {}) : [],
  );
  // Current observations are readable even for a legacy in-memory state. The
  // engine, never rendering, commits these observations to durable knowledge.
  for (const main of mains) owners.set(main, game.hexes[main]!.owner);
  const value = { cells, mains, owners };
  const views = projections.get(game) ?? new Map();
  views.set(view, { fingerprint, value });
  projections.set(game, views);
  return value;
}

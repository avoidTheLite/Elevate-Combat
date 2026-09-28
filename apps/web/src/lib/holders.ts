// ── Strategic holders (commanders + garrisons) as the UI sees them ───────────
// One place for "what may this viewer see / order", shared by the scene builder,
// the click handler and the sidebar panels so they never disagree.

import type { Army, GameState, HexKey, Team } from '@iron-ridge/engine';
import {
  TEAM_NAME,
  canTransfer,
  commanderReach,
  engageTargets,
  hexDistance,
  holderAt,
  isPresent,
  transferRule,
  visibleArmies,
  worldOf,
} from '@iron-ridge/engine';

/** Holders the viewer may see (null view = omniscient: every present holder). */
export function seenHolders(game: GameState, view: Team | null): Army[] {
  return view ? visibleArmies(game, view) : game.armies.filter(isPresent);
}

/**
 * Contents rule (UI decision): a viewer sees the unit list of its own holders.
 * Enemy holders visible under fog show only their unit count; with fog off
 * (omniscient view) everything is shown.
 */
export function showsContents(holder: Army, view: Team | null): boolean {
  return view === null || holder.team === view;
}

/** Short display name, e.g. "HQ GARRISON" or "COMMANDER Aarmy7". */
export function holderName(a: Army): string {
  return a.kind === 'garrison' ? 'HQ GARRISON' : `COMMANDER ${a.id}`;
}

export function holderTitle(a: Army): string {
  return `${TEAM_NAME[a.team]} ${a.kind === 'garrison' ? 'HQ GARRISON' : 'COMMANDER'}`;
}

/** May a human viewer give orders to this holder right now? */
export function canOrder(
  game: GameState,
  holder: Army | null | undefined,
  view: Team | null,
): boolean {
  return (
    !!holder &&
    game.phase === 'strategic' &&
    holder.team === game.active &&
    game.settings.controllers[holder.team] === 'human' &&
    (view === null || view === holder.team)
  );
}

/**
 * The holder a click on `subKey` refers to: the visible holder standing there,
 * or — for a click on the HQ building's ring — that HQ's visible garrison.
 */
export function holderForClick(
  game: GameState,
  view: Team | null,
  subKey: HexKey,
): Army | undefined {
  const seen = seenHolders(game, view);
  const direct = holderAt(game, subKey);
  if (direct) return seen.find((a) => a.id === direct.id);
  const { world } = worldOf(game);
  const cell = world.subByKey.get(subKey);
  if (!cell) return undefined;
  return seen.find((a) => {
    if (a.kind !== 'garrison') return false;
    const g = world.subByKey.get(a.pos);
    return !!g && hexDistance(g.hex, cell.hex) <= 1;
  });
}

export interface CommandHighlights {
  /** Selected own commander's reachable cells → steps (own cell excluded). */
  reach: Map<HexKey, number>;
  /** Enemy holders the selected commander may engage now. */
  engage: Army[];
  /** Friendly holders that can receive the checked units. */
  transfer: Army[];
}

const NONE: CommandHighlights = { reach: new Map(), engage: [], transfer: [] };

/** Map highlights for the current selection, limited to what the viewer may order. */
export function commandHighlights(
  game: GameState,
  selectedId: string | null,
  checked: string[],
  view: Team | null,
): CommandHighlights {
  const holder = selectedId ? game.armies.find((a) => a.id === selectedId) : undefined;
  if (!holder || !canOrder(game, holder, view)) return NONE;
  const reach =
    holder.kind === 'commander' ? commanderReach(game, holder) : new Map<HexKey, number>();
  reach.delete(holder.pos);
  const engage = holder.kind === 'commander' ? engageTargets(game, holder.id) : [];
  const ids = checked.filter((id) => holder.units.some((u) => u.id === id));
  const transfer = ids.length
    ? game.armies.filter((to) => canTransfer(game, holder, to, ids.length).ok)
    : [];
  return { reach, engage, transfer };
}

/** Human-readable reassignment rule, e.g. "within 4 sub-hexes and in the same main hex". */
export function transferRuleText(game: GameState): string {
  const rule = transferRule(game);
  const parts: string[] = [];
  if (rule.radius !== null) parts.push(`within ${rule.radius} sub-hexes`);
  if (rule.sameMainHex) parts.push('in the same main hex');
  return parts.length ? parts.join(' and ') : 'anywhere on the map';
}

/** Shortest path (sub keys, start → dest) through a commanderReach map. */
export function reachPath(
  game: GameState,
  reach: Map<HexKey, number>,
  start: HexKey,
  dest: HexKey,
): HexKey[] {
  const steps = reach.get(dest);
  if (steps === undefined || dest === start) return [];
  const { world } = worldOf(game);
  const path = [dest];
  let cur = dest;
  for (let s = steps - 1; s >= 0; s--) {
    const here = world.subByKey.get(cur)!.hex;
    const prev =
      s === 0
        ? start
        : [...reach.entries()].find(
            ([k, n]) => n === s && hexDistance(world.subByKey.get(k)!.hex, here) === 1,
          )?.[0];
    if (!prev) return [];
    path.push(prev);
    cur = prev;
  }
  return path.reverse();
}

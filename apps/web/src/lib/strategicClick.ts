// ── Strategic map clicks (commanders, garrisons, main hexes) ─────────────────
// Kept out of GameScreen so it can be tested headless against the real store.

import { actingTeam, isAiTurn, worldOf } from '@iron-ridge/engine';
import { useGameStore, viewTeam } from '../stores/useGameStore.ts';
import { canOrder, commandHighlights, holderForClick } from './holders.ts';

/**
 * Left-click on sub-hex `key` of the strategic map. With one of your commanders
 * selected: an engageable enemy → engage; a reachable cell → move there.
 * Otherwise the click selects the holder there (or the HQ garrison, for a click
 * on the HQ building) and the main hex.
 */
export function strategicClick(key: string): void {
  const s = useGameStore.getState();
  const g = s.game;
  if (!g) return;
  const u = s.ui;
  const v = viewTeam(g);
  const act = actingTeam(g);
  const human = act !== null && !isAiTurn(g) && g.settings.controllers[act] === 'human';
  const { world } = worldOf(g);
  const main = world.subByKey.get(key)?.main;
  if (!main) return;
  const sel = u.selectedArmy ? g.armies.find((a) => a.id === u.selectedArmy) : null;
  const clicked = holderForClick(g, v, key);
  if (human && sel && canOrder(g, sel, v)) {
    const hl = commandHighlights(g, sel.id, u.checkedUnits, v);
    // Engage: an enemy holder in range (click its cell or its HQ building).
    const target = clicked && hl.engage.find((t) => t.id === clicked.id);
    if (target) {
      s.dispatch({ type: 'engage', armyId: sel.id, targetId: target.id });
      return;
    }
    // An enemy out of reach: say why, keep the commander selected (right-click to drop it).
    if (clicked && clicked.team !== sel.team && sel.kind === 'commander') {
      s.dispatch({ type: 'engage', armyId: sel.id, targetId: clicked.id });
      s.setUi({ selectedMain: main });
      return;
    }
    // Move: any reachable sub-hex.
    if (hl.reach.has(key)) {
      if (s.dispatch({ type: 'moveCommander', armyId: sel.id, dest: key })) {
        const moved = s.game!.armies.find((a) => a.id === sel.id);
        s.setUi({ selectedMain: moved?.at ?? main, selectedArmy: moved?.id ?? null });
      }
      return;
    }
  }
  // Otherwise: select the holder clicked (own or a visible enemy) and its main hex.
  s.setUi({
    selectedMain: main,
    selectedArmy: clicked?.id ?? null,
    checkedUnits: clicked && clicked.id === u.selectedArmy ? u.checkedUnits : [],
  });
}

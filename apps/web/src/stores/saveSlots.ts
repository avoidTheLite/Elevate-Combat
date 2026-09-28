// ── localStorage save slots (V1.0) ───────────────────────────────────────────
// One autosave plus three manual slots, each holding a serialized save envelope
// from the engine (`serializeSave`). All storage access is best-effort: private
// mode or a full quota never throws into the game.

import type { Controller, Era, GamePhase, GameState, Team } from '@iron-ridge/engine';
import { deserializeSave, serializeSave } from '@iron-ridge/engine';

export const SLOT_IDS = ['autosave', 'slot1', 'slot2', 'slot3'] as const;
export type SlotId = (typeof SLOT_IDS)[number];
export const MANUAL_SLOTS: SlotId[] = ['slot1', 'slot2', 'slot3'];

export const SAVE_PREFIX = 'iron-ridge-save-v1:';
/** V0.9 single autosave key (bare GameState). Migrated into the autosave slot. */
export const LEGACY_SAVE_KEY = 'iron-ridge-save-v0.9';

export const slotKey = (slot: SlotId): string => `${SAVE_PREFIX}${slot}`;

export function slotName(slot: SlotId): string {
  return slot === 'autosave' ? 'AUTOSAVE' : `SLOT ${slot.slice(4)}`;
}

export interface SlotInfo {
  slot: SlotId;
  empty: boolean;
  /** False when the stored text could not be read (corrupt / newer version). */
  ok: boolean;
  error?: string;
  label?: string;
  turn?: number;
  phase?: GamePhase;
  battlePhase?: string;
  era?: Era;
  savedAt?: string;
  controllers?: Record<Team, Controller>;
}

export function readSlot(slot: SlotId): string | null {
  try {
    return localStorage.getItem(slotKey(slot));
  } catch {
    return null;
  }
}

export function writeSlot(slot: SlotId, state: GameState, label?: string): boolean {
  try {
    localStorage.setItem(slotKey(slot), serializeSave(state, label));
    return true;
  } catch {
    return false;
  }
}

export function removeSlot(slot: SlotId): void {
  try {
    localStorage.removeItem(slotKey(slot));
  } catch {
    /* storage unavailable */
  }
}

export function slotInfo(slot: SlotId): SlotInfo {
  const text = readSlot(slot);
  if (text === null) return { slot, empty: true, ok: false };
  const r = deserializeSave(text);
  if (!r.ok) return { slot, empty: false, ok: false, error: r.error };
  const s = r.save.state;
  return {
    slot,
    empty: false,
    ok: true,
    label: r.save.label,
    turn: s.turn,
    phase: s.phase,
    battlePhase: s.battle?.phase,
    era: s.settings.era,
    savedAt: r.save.savedAt,
    controllers: s.settings.controllers,
  };
}

/**
 * Move a V0.9 autosave (old key) into the V1 autosave slot, once. Returns an
 * error message when the old save was unreadable (it is removed either way).
 */
export function migrateLegacyStorage(): { migrated: boolean; error?: string } {
  try {
    const old = localStorage.getItem(LEGACY_SAVE_KEY);
    if (old === null) return { migrated: false };
    localStorage.removeItem(LEGACY_SAVE_KEY);
    if (localStorage.getItem(slotKey('autosave')) !== null) return { migrated: false };
    const r = deserializeSave(old);
    if (!r.ok)
      return {
        migrated: false,
        error: `Your V0.9 save could not be upgraded and has been removed (${r.error})`,
      };
    localStorage.setItem(slotKey('autosave'), serializeSave(r.save.state, 'Autosave (from V0.9)'));
    return { migrated: true };
  } catch {
    return { migrated: false };
  }
}

export function exportFilename(state: GameState, now = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  return `iron-ridge-${state.settings.era}-turn${state.turn}-${d}.json`;
}

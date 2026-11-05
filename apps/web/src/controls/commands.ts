import type { BattleContext, BattleUnit, GameAction, GameState, Team } from '@iron-ridge/engine';
import {
  actingTeam,
  buildContext,
  apply,
  foundationHasPending,
  isAiTurn,
  pathTo,
  previewAttack,
  reachable,
  unitType,
} from '@iron-ridge/engine';
import type { UiState } from '../stores/useGameStore.ts';
import { viewTeam } from '../stores/useGameStore.ts';
import { attackDetails } from './attackPresentation.ts';
import {
  canOrder,
  commandHighlights,
  holderForClick,
  holderName,
  reachPath,
  seenHolders,
} from '../lib/holders.ts';

export type CommandSelection = Pick<UiState, 'selectedArmy' | 'selectedUnit' | 'checkedUnits'>;

export interface MapCommand {
  kind: 'move' | 'attack' | 'action';
  label: string;
  actorId: string;
  origin: string;
  target: string;
  action: GameAction;
  details: string[];
  /** Fog-safe, compact presentation; full fire-control details remain in the sidebar. */
  hitSummary?: string;
  path: string[];
}

export interface PendingCommand {
  /** Immutable store snapshot is also a session/turn/phase revision token. */
  game: GameState;
  command: MapCommand;
  dragging: boolean;
}
export type TargetingMode = 'auto' | 'move' | 'attack';

export function controlsEnabled(game: GameState): boolean {
  const team = actingTeam(game);
  return (
    !!team &&
    !isAiTurn(game) &&
    game.settings.controllers[team] === 'human' &&
    !foundationHasPending(game) &&
    (game.phase === 'strategic' || (game.phase === 'battle' && game.battle?.phase === 'combat'))
  );
}

export function commandLegal(game: GameState, action: GameAction): boolean {
  return controlsEnabled(game) && apply(game, action).error === null;
}

export function selectedActor(
  game: GameState,
  ui: CommandSelection,
): { id: string; pos: string; label: string } | null {
  if (game.phase === 'battle') {
    const unit = game.battle?.units.find((u) => u.id === ui.selectedUnit && u.hp > 0 && u.pos);
    return unit?.pos ? { id: unit.id, pos: unit.pos, label: unit.label } : null;
  }
  const holder = seenHolders(game, viewTeam(game)).find((h) => h.id === ui.selectedArmy);
  return holder ? { id: holder.id, pos: holder.pos, label: holderName(holder) } : null;
}

/** All actual visible occupants, including a commander on an empty node garrison. */
export function selectableAt(game: GameState, key: string): { id: string; label: string }[] {
  const view = viewTeam(game);
  if (game.phase === 'battle')
    return (game.battle?.units ?? [])
      .filter((u) => u.hp > 0 && u.pos === key && u.team === game.battle?.active)
      .map((u) => ({ id: u.id, label: u.label }));
  const primary = holderForClick(game, view, key);
  const holders = seenHolders(game, view).filter((h) => h.pos === key || h.id === primary?.id);
  return holders
    .filter((h) => h.team === game.active)
    .map((h) => ({ id: h.id, label: holderName(h) }));
}

interface CommandDerivation {
  actor: ReturnType<typeof selectedActor>;
  view: Team | null;
  tactical: () => { ctx: BattleContext; unit: BattleUnit; reach: ReturnType<typeof reachable> };
  strategic: () => ReturnType<typeof commandHighlights>;
  legal: (action: GameAction) => boolean;
}

/** A resolver belongs to one immutable game/selection snapshot, never to camera anchors. */
export function createCommandResolver(
  game: GameState,
  ui: CommandSelection,
): (key: string, mode?: TargetingMode) => MapCommand | null {
  const actor = selectedActor(game, ui);
  const view = viewTeam(game);
  let tactical: ReturnType<CommandDerivation['tactical']> | undefined;
  let strategic: ReturnType<typeof commandHighlights> | undefined;
  const legal = new Map<string, boolean>();
  const commands = new Map<string, MapCommand | null>();
  const derivation: CommandDerivation = {
    actor,
    view,
    tactical: () => {
      if (!tactical) {
        const ctx = buildContext(game.settings, game.battle!);
        const unit = game.battle!.units.find((u) => u.id === actor!.id)!;
        tactical = { ctx, unit, reach: reachable(ctx, unit) };
      }
      return tactical;
    },
    strategic: () => (strategic ??= commandHighlights(game, actor!.id, ui.checkedUnits, view)),
    legal: (action) => {
      const key = JSON.stringify(action);
      if (!legal.has(key)) legal.set(key, commandLegal(game, action));
      return legal.get(key)!;
    },
  };
  return (key, mode = 'auto') => {
    const cacheKey = `${mode}:${key}`;
    if (!commands.has(cacheKey)) commands.set(cacheKey, deriveCommand(game, key, mode, derivation));
    return commands.get(cacheKey) ?? null;
  };
}

/** Destination intent does not override friendly occupancy or engine legality. */
export function commandAt(
  game: GameState,
  ui: CommandSelection,
  key: string,
  mode: TargetingMode = 'auto',
): MapCommand | null {
  return createCommandResolver(game, ui)(key, mode);
}

function deriveCommand(
  game: GameState,
  key: string,
  mode: TargetingMode,
  derivation: CommandDerivation,
): MapCommand | null {
  if (!controlsEnabled(game)) return null;
  const actor = derivation.actor;
  if (!actor || key === actor.pos) return null;
  const forceMove = mode === 'move';
  if (game.phase === 'strategic') {
    const holder = game.armies.find((h) => h.id === actor.id)!;
    if (!canOrder(game, holder, derivation.view)) return null;
    const highlights = derivation.strategic();
    const clicked = holderForClick(game, derivation.view, key);
    const enemy = !forceMove && clicked && highlights.engage.find((h) => h.id === clicked.id);
    if (enemy) {
      const action: GameAction = { type: 'engage', armyId: holder.id, targetId: enemy.id };
      return derivation.legal(action)
        ? {
            kind: 'attack',
            label: 'ENGAGE',
            actorId: actor.id,
            origin: actor.pos,
            target: key,
            action,
            path: [actor.pos, key],
            details: [
              'Open engagement choices; deployment and combat are confirmed separately.',
              `Target: ${holderName(enemy)}`,
            ],
          }
        : null;
    }
    if (mode === 'attack' || !highlights.reach.has(key)) return null;
    const action: GameAction = { type: 'moveCommander', armyId: holder.id, dest: key };
    return derivation.legal(action)
      ? {
          kind: 'move',
          label: 'MOVE',
          actorId: actor.id,
          origin: actor.pos,
          target: key,
          action,
          path: reachPath(game, highlights.reach, actor.pos, key),
          details: [
            `${highlights.reach.get(key)} strategic steps`,
            `${holder.movesLeft} steps available`,
            `Destination: ${key}`,
          ],
        }
      : null;
  }
  const battle = game.battle!;
  const { ctx, unit, reach } = derivation.tactical();
  const target = ctx.unitAt.get(key);
  const wantsAttack =
    mode === 'attack' ||
    (!forceMove &&
      (unitType(unit.typeId).attackType === 'indirect'
        ? !reach.has(key) || !!target
        : !!target && target.team !== unit.team));
  if (wantsAttack) {
    const preview = previewAttack(ctx, battle, unit, key);
    const action: GameAction = { type: 'attack', unitId: unit.id, cell: key };
    if (preview.legal && derivation.legal(action))
      return {
        kind: 'attack',
        label: 'ATTACK',
        actorId: actor.id,
        origin: actor.pos,
        target: key,
        action,
        path: [actor.pos, key],
        details: attackDetails(preview, derivation.view),
        hitSummary:
          derivation.view !== null && preview.blind
            ? 'Hit chance unknown · blind fire'
            : `Hit ${Math.round(preview.pDirect * 100)}%`,
      };
  }
  const action: GameAction = { type: 'move', unitId: unit.id, cell: key };
  if (
    mode !== 'attack' &&
    !unit.stationed &&
    !unit.acted &&
    !unit.deployed &&
    reach.has(key) &&
    derivation.legal(action)
  )
    return {
      kind: 'move',
      label: 'MOVE',
      actorId: actor.id,
      origin: actor.pos,
      target: key,
      action,
      path: pathTo(reach, key),
      details: [
        `${reach.get(key)!.cost} MP · ${unit.mp} MP available`,
        `Destination: ${key}`,
        'Movement preserves the remaining action when the rules allow.',
      ],
    };
  return null;
}

export function targetingOptions(
  game: GameState,
  ui: CommandSelection,
): { move: boolean; attack: boolean } {
  const actor = selectedActor(game, ui);
  if (!actor || !controlsEnabled(game)) return { move: false, attack: false };
  if (game.phase === 'strategic') {
    const holder = game.armies.find((h) => h.id === actor.id)!;
    const orderable = holder.kind === 'commander' && canOrder(game, holder, viewTeam(game));
    return { move: orderable && holder.movesLeft > 0, attack: orderable };
  }
  const unit = game.battle!.units.find((u) => u.id === actor.id)!;
  const active = unit.team === game.battle!.active && !unit.acted;
  return {
    move: active && !unit.stationed && !unit.deployed && unit.mp > 0,
    attack: active && (unitType(unit.typeId).placementCategory !== 'combat_fixed' || unit.deployed),
  };
}

export function actorActions(game: GameState, ui: CommandSelection): MapCommand[] {
  if (!controlsEnabled(game) || game.phase !== 'battle') return [];
  const actor = selectedActor(game, ui);
  const unit = game.battle?.units.find((u) => u.id === actor?.id);
  if (!actor || !unit) return [];
  const type = unitType(unit.typeId);
  const actions: { label: string; action: GameAction; details: string[] }[] = [];
  if (type.engineer)
    actions.push({
      label: 'DIG IN',
      action: { type: 'dig', unitId: actor.id },
      details: ['Adds one fortification level; spends the action.'],
    });
  if (type.placementCategory === 'combat_fixed')
    actions.push(
      unit.deployed
        ? {
            label: 'PACK UP',
            action: { type: 'packUp', unitId: actor.id },
            details: ['Packs the weapon; spends this turn.'],
          }
        : {
            label: 'SET UP',
            action: { type: 'setUp', unitId: actor.id },
            details: ['Sets the weapon to fire. After moving, spends the activation.'],
          },
    );
  return actions
    .filter((a) => commandLegal(game, a.action))
    .map((a) => ({
      ...a,
      kind: 'action',
      actorId: actor.id,
      origin: actor.pos,
      target: actor.pos,
      path: [],
    }));
}

export function pendingValid(
  pending: PendingCommand,
  game: GameState,
  ui: CommandSelection,
): boolean {
  const actor = selectedActor(game, ui);
  return (
    pending.game === game &&
    actor?.id === pending.command.actorId &&
    actor.pos === pending.command.origin &&
    commandLegal(game, pending.command.action)
  );
}

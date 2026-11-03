import type { GameAction, GameState } from '@iron-ridge/engine';
import {
  actingTeam,
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
import { buildTacticalScene } from '../render/buildScene.ts';
import {
  canOrder,
  commandHighlights,
  holderForClick,
  holderName,
  reachPath,
  seenHolders,
} from '../lib/holders.ts';

export interface MapCommand {
  kind: 'move' | 'attack' | 'action';
  label: string;
  actorId: string;
  origin: string;
  target: string;
  action: GameAction;
  details: string[];
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
  ui: UiState,
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

/** Destination intent does not override friendly occupancy or engine legality. */
export function commandAt(
  game: GameState,
  ui: UiState,
  key: string,
  mode: TargetingMode = 'auto',
): MapCommand | null {
  if (!controlsEnabled(game)) return null;
  const actor = selectedActor(game, ui);
  if (!actor || key === actor.pos) return null;
  const forceMove = mode === 'move';
  if (game.phase === 'strategic') {
    const holder = game.armies.find((h) => h.id === actor.id)!;
    if (!canOrder(game, holder, viewTeam(game))) return null;
    const highlights = commandHighlights(game, holder.id, ui.checkedUnits, viewTeam(game));
    const clicked = holderForClick(game, viewTeam(game), key);
    const enemy = !forceMove && clicked && highlights.engage.find((h) => h.id === clicked.id);
    if (enemy) {
      const action: GameAction = { type: 'engage', armyId: holder.id, targetId: enemy.id };
      return commandLegal(game, action)
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
    return commandLegal(game, action)
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
  const unit = battle.units.find((u) => u.id === actor.id)!;
  const ctx = buildTacticalScene(game, ui, viewTeam(game)).ctx;
  const reach = reachable(ctx, unit);
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
    if (preview.legal && commandLegal(game, action))
      return {
        kind: 'attack',
        label: 'ATTACK',
        actorId: actor.id,
        origin: actor.pos,
        target: key,
        action,
        path: [actor.pos, key],
        details: [
          `${preview.kind} · ${preview.band} · effective range ${preview.effectiveRange}`,
          `TN ${preview.tn} · direct hit ${Math.round(preview.pDirect * 100)}% · splash ${Math.round(preview.pSplash * 100)}%`,
          `Expected damage ${preview.expectedDamage.toFixed(1)} · ${preview.los?.status ?? 'melee'}`,
          ...preview.modifiers.map((m) => `${m.label}: ${m.value > 0 ? '+' : ''}${m.value}`),
          ...(preview.blind ? ['Blind fire: no spotter.'] : []),
          'Probabilities are estimates; no outcome is promised.',
        ],
      };
  }
  const action: GameAction = { type: 'move', unitId: unit.id, cell: key };
  if (
    mode !== 'attack' &&
    !unit.stationed &&
    !unit.acted &&
    !unit.deployed &&
    reach.has(key) &&
    commandLegal(game, action)
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

export function targetingOptions(game: GameState, ui: UiState): { move: boolean; attack: boolean } {
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

export function actorActions(game: GameState, ui: UiState): MapCommand[] {
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

export function pendingValid(pending: PendingCommand, game: GameState, ui: UiState): boolean {
  const actor = selectedActor(game, ui);
  return (
    pending.game === game &&
    actor?.id === pending.command.actorId &&
    actor.pos === pending.command.origin &&
    commandLegal(game, pending.command.action)
  );
}

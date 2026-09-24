// ── Attack effects: what to animate for an attack outcome (pure, testable) ───
// The engine reports who fired from where at what, and which units lost HP.
// This module turns that into a small animation plan; fx.ts plays it in three.js.

import type { AttackOutcome, GameState, Team } from '@iron-ridge/engine';
import { buildContext, hexDistance, parseKey, unitType, visibleEnemies } from '@iron-ridge/engine';

/** Flight shape of the projectile. */
export type Projectile = 'lob' | 'shell' | 'bullet' | 'arrow' | 'none';
/** What happens where it lands. */
export type Impact = 'explosion' | 'dust' | 'slash';

export interface WeaponStyle {
  projectile: Projectile;
  impact: Impact;
  /** Rounds per attack (machine-gun burst). */
  rounds: number;
  /** Heavier blast (artillery / catapult). */
  big: boolean;
}

export type LabelTone = 'damage' | 'kill' | 'miss' | 'noeffect';

export interface FxLabel {
  key: string;
  text: string;
  tone: LabelTone;
}

export interface AttackFx {
  id: number;
  from: string;
  to: string;
  distance: number;
  eye: number;
  style: WeaponStyle;
  splashRadius: number;
  /** Seconds from launch to impact (last round). */
  flight: number;
  /** The shot missed its target — rounds land a little off the cell centre. */
  miss: boolean;
  labels: FxLabel[];
}

export function weaponStyle(typeId: string): WeaponStyle {
  const t = unitType(typeId);
  if (t.attackType === 'melee')
    return { projectile: 'none', impact: 'slash', rounds: 1, big: false };
  if (t.attackType === 'indirect')
    return { projectile: 'lob', impact: 'explosion', rounds: 1, big: t.unitClass === 'artillery' };
  // Explosive direct fire: tank cannon, AT gun, bazooka (siege / HE).
  if (t.damageType === 'siege' || t.splash !== null)
    return { projectile: 'shell', impact: 'explosion', rounds: 1, big: false };
  // Small arms, autocannon, bows: dust on impact.
  const bow = t.era === 'medieval';
  return {
    projectile: bow ? 'arrow' : 'bullet',
    impact: 'dust',
    rounds: t.suppresses ? 3 : 1,
    big: false,
  };
}

/** Seconds a single projectile takes to cross `distance` cells. */
export function flightTime(projectile: Projectile, distance: number): number {
  switch (projectile) {
    case 'lob':
      return 0.75 + distance * 0.05;
    case 'shell':
      return 0.22 + distance * 0.03;
    case 'bullet':
      return 0.14 + distance * 0.022;
    case 'arrow':
      return 0.3 + distance * 0.04;
    default:
      return 0;
  }
}

export const BURST_GAP = 0.09;
const IMPACT_TIME = { explosion: 0.75, dust: 0.55, slash: 0.45 } as const;
export const LABEL_TIME = 1.3;

/** Seconds until the effect has fully played (labels included). */
export function fxDuration(fx: AttackFx): number {
  return fx.flight + Math.max(IMPACT_TIME[fx.style.impact], LABEL_TIME);
}

/**
 * Build the animation plan for an attack. `canSee(unitId)` decides whether the
 * viewer may learn about a unit, so damage numbers never reveal hidden enemies.
 */
export function planAttackFx(
  outcome: AttackOutcome,
  attackerTypeId: string,
  id: number,
  canSee: (unitId: string) => boolean,
  /** Unit standing on the target cell when the attack was made, if any. */
  targetUnitId: string | null,
): AttackFx {
  const style = weaponStyle(attackerTypeId);
  const t = unitType(attackerTypeId);
  const distance = hexDistance(parseKey(outcome.from), parseKey(outcome.target));
  const flight = flightTime(style.projectile, distance) + (style.rounds - 1) * BURST_GAP;
  const labels: FxLabel[] = outcome.hits
    .filter((h) => canSee(h.unitId))
    .map((h) => ({
      key: h.pos,
      text: `-${h.damage}hp${h.killed ? ' ✖' : ''}`,
      tone: h.killed ? 'kill' : 'damage',
    }));
  // Only annotate a miss / deflection on a target the viewer can actually see.
  const targetHit = outcome.hits.some((h) => h.pos === outcome.target);
  if (!targetHit && targetUnitId && canSee(targetUnitId)) {
    labels.push(
      outcome.result === 'miss'
        ? { key: outcome.target, text: 'MISS', tone: 'miss' }
        : { key: outcome.target, text: 'NO EFFECT', tone: 'noeffect' },
    );
  }
  return {
    id,
    from: outcome.from,
    to: outcome.target,
    distance,
    eye: t.eye,
    style,
    splashRadius: t.splashRadius,
    flight,
    miss: outcome.result === 'miss',
    labels,
  };
}

/** Fog-aware visibility predicate for effects produced by `prev → next`. */
export function effectVisibility(
  prev: GameState,
  next: GameState,
  view: Team | null,
): (unitId: string) => boolean {
  if (!view) return () => true;
  const seen = new Set<string>();
  for (const g of [prev, next]) {
    if (!g.battle) continue;
    const ctx = buildContext(g.settings, g.battle);
    for (const u of g.battle.units) if (u.team === view) seen.add(u.id);
    for (const u of visibleEnemies(ctx, g.battle, view)) seen.add(u.id);
  }
  return (id) => seen.has(id);
}

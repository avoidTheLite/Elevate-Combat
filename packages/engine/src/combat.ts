// ── Combat resolution — docs/Iron_Ridge_Combat_Rules_v1.md ───────────────────
// Turn-sequence (§8): depression check → LOS/spotter → effective range → range
// band → movement/facing/cover modifiers → d20 vs TN (+ splash TN 10 for HE) →
// damage pool × damage-type effectiveness − armor ± facing.

import type { HexKey } from './hex.ts';
import { hexDistance, hexKey, hexToWorld, parseKey, spiral } from './hex.ts';
import type { BattleContext } from './battleMap.ts';
import { h, refreshOccupancy } from './battleMap.ts';
import type { LosResult } from './los.ts';
import { arcClearance, lineOfSight } from './los.ts';
import type { DicePool, Rng } from './rng.ts';
import { poolAverage, poolLabel, rollPool } from './rng.ts';
import type { ArmorClass, RangeProfile, UnitType } from './units.ts';
import { damagesFortification, effectivenessMultiplier, unitType } from './units.ts';
import type { Battle, BattleLogEntry, BattleUnit } from './types.ts';
import { isSpotted, visibleEnemies } from './visibility.ts';

// §1 base to-hit TN by target size/exposure
export const BASE_TN: Record<ArmorClass, number> = {
  heavy_armor: 7,
  light_armor: 10,
  unarmored: 15,
};
// §2 splash threshold
export const SPLASH_TN = 10;
// §7 armor rating
export const ARMOR_RATING: Record<ArmorClass, number> = {
  unarmored: 0,
  light_armor: 3,
  heavy_armor: 6,
};
// §5 blind fire
export const BLIND_FIRE_TN = 6;
export const MAX_FORT = 3;

interface Band {
  name: string;
  max: number;
  mod: Record<RangeProfile, number | null>;
}

// §3 range bands (null = cannot fire in this band)
const BANDS: Band[] = [
  {
    name: 'Point-Blank',
    max: 1,
    mod: { rifle_mg: -5, at_gun: -5, tank_cannon: null, indirect: null, melee: -5 },
  },
  {
    name: 'Short',
    max: 3,
    mod: { rifle_mg: 0, at_gun: 0, tank_cannon: 0, indirect: 0, melee: null },
  },
  {
    name: 'Medium',
    max: 6,
    mod: { rifle_mg: 3, at_gun: 2, tank_cannon: 2, indirect: 0, melee: null },
  },
  {
    name: 'Long',
    max: 10,
    mod: { rifle_mg: 6, at_gun: 4, tank_cannon: 4, indirect: 2, melee: null },
  },
  {
    name: 'Extreme',
    max: Infinity,
    mod: { rifle_mg: 10, at_gun: 4, tank_cannon: 4, indirect: 4, melee: null },
  },
];

export function rangeBand(effRange: number): Band {
  return BANDS.find((b) => effRange <= b.max)!;
}

/** §4 Effective Range = horizontal + 2 × uphill levels (downhill: no change). */
export function effectiveRange(dist: number, shooterH: number, targetH: number): number {
  return dist + 2 * Math.max(0, targetH - shooterH);
}

/** §6 tank gun depression: max drop = ⌊dist / 3⌋. */
export function inDepressionDeadZone(dist: number, shooterH: number, targetH: number): boolean {
  return shooterH - targetH > Math.floor(dist / 3);
}

export type FacingArc = 'front' | 'side' | 'rear';

// §7a facing
export const FACING_MODS: Record<FacingArc, { tn: number; dmg: number }> = {
  front: { tn: 2, dmg: -2 },
  rear: { tn: 1, dmg: 2 },
  side: { tn: -1, dmg: 0 },
};

export function facingArc(defender: HexKey, facing: number, attacker: HexKey): FacingArc {
  const d = hexToWorld(parseKey(defender));
  const a = hexToWorld(parseKey(attacker));
  const dirs = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ];
  const f = hexToWorld(dirs[facing]!);
  const vx = a.x - d.x;
  const vz = a.z - d.z;
  const cos = (vx * f.x + vz * f.z) / (Math.hypot(vx, vz) * Math.hypot(f.x, f.z) || 1);
  const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  if (deg <= 60 + 1e-6) return 'front';
  if (deg >= 120 - 1e-6) return 'rear';
  return 'side';
}

/** Direction index (0..5) that best points from a to b. */
export function bestFacing(from: HexKey, to: HexKey): number {
  const a = hexToWorld(parseKey(from));
  const b = hexToWorld(parseKey(to));
  const ang = Math.atan2(b.z - a.z, b.x - a.x);
  let best = 0;
  let bestDiff = Infinity;
  const dirs = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ];
  dirs.forEach((d, i) => {
    const w = hexToWorld(d);
    let diff = Math.abs(Math.atan2(w.z, w.x) - ang);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  });
  return best;
}

export interface Modifier {
  label: string;
  value: number;
}

export type AttackKind = 'melee' | 'direct' | 'indirect';

export interface AttackPreview {
  legal: boolean;
  reason: string | null;
  kind: AttackKind;
  targetKey: HexKey;
  target: BattleUnit | null;
  distance: number;
  effectiveRange: number;
  band: string;
  baseTn: number;
  tn: number;
  modifiers: Modifier[];
  /** HE weapons: splash band [SPLASH_TN, tn). Null when splash cannot happen. */
  splashTn: number | null;
  pDirect: number;
  pSplash: number;
  los: LosResult | null;
  arc: FacingArc | null;
  facingDamage: number;
  blind: boolean;
  expectedDamage: number;
}

export function pAtLeast(tn: number): number {
  // Natural 1 always misses, natural 20 always hits.
  const need = Math.max(2, Math.min(20, tn));
  return (21 - need) / 20;
}

function pSplashBand(tn: number): number {
  // Rolls in [SPLASH_TN, tn-1], excluding the natural-20 auto-hit.
  const hi = Math.min(tn - 1, 19);
  const lo = Math.max(SPLASH_TN, 2);
  return hi >= lo ? (hi - lo + 1) / 20 : 0;
}

export function isHE(t: UnitType): boolean {
  return t.splash !== null;
}

function illegal(
  kind: AttackKind,
  targetKey: HexKey,
  target: BattleUnit | null,
  reason: string,
): AttackPreview {
  return {
    legal: false,
    reason,
    kind,
    targetKey,
    target,
    distance: 0,
    effectiveRange: 0,
    band: '',
    baseTn: 0,
    tn: 99,
    modifiers: [],
    splashTn: null,
    pDirect: 0,
    pSplash: 0,
    los: null,
    arc: null,
    facingDamage: 0,
    blind: false,
    expectedDamage: 0,
  };
}

/** Average damage-multiplier of the siege-vs-unarmored variance table. */
const SIEGE_SOFT_TABLE: { upTo: number; mult: number; label: string }[] = [
  { upTo: 4, mult: 0.2, label: 'dispersed — mostly miss' },
  { upTo: 5, mult: 0.6, label: 'partial' },
  { upTo: 6, mult: 2.0, label: 'CATASTROPHIC' },
];
const SIEGE_SOFT_AVG = (4 * 0.2 + 0.6 + 2.0) / 6;

function damageMultiplier(attacker: UnitType, defender: UnitType): number {
  if (attacker.damageType === 'siege' && defender.armorClass === 'unarmored') return SIEGE_SOFT_AVG;
  return effectivenessMultiplier(attacker.damageType, defender.armorClass);
}

export function expectedHitDamage(
  attacker: UnitType,
  defender: UnitType,
  pool: DicePool,
  facingDmg: number,
  bonus = 0,
): number {
  const raw = (poolAverage(pool) + bonus) * damageMultiplier(attacker, defender);
  return Math.max(0, raw - ARMOR_RATING[defender.armorClass] + facingDmg);
}

export function previewAttack(
  ctx: BattleContext,
  battle: Battle,
  attacker: BattleUnit,
  targetKey: HexKey,
): AttackPreview {
  const at = unitType(attacker.typeId);
  const kind: AttackKind =
    at.attackType === 'melee' ? 'melee' : at.attackType === 'indirect' ? 'indirect' : 'direct';
  const target = ctx.unitAt.get(targetKey) ?? null;
  if (!attacker.pos || attacker.hp <= 0)
    return illegal(kind, targetKey, target, 'Unit is not on the field');
  if (attacker.team !== battle.active) return illegal(kind, targetKey, target, 'Not your turn');
  if (attacker.acted) return illegal(kind, targetKey, target, 'Already acted this turn');
  if (at.placementCategory === 'combat_fixed' && !attacker.deployed)
    return illegal(kind, targetKey, target, 'Must SET UP before firing (combat_fixed)');
  if (!ctx.cells.has(targetKey)) return illegal(kind, targetKey, target, 'Off the battle map');

  const a = parseKey(attacker.pos);
  const b = parseKey(targetKey);
  const dist = hexDistance(a, b);
  const ha = h(ctx, attacker.pos);
  const hb = h(ctx, targetKey);

  if (kind !== 'indirect') {
    if (!target || target.team === attacker.team)
      return illegal(kind, targetKey, target, 'No enemy target there');
    const seen = visibleEnemies(ctx, battle, attacker.team).some((u) => u.id === target.id);
    if (!seen) return illegal(kind, targetKey, target, 'Target not spotted');
  }
  if (dist < at.minRange)
    return illegal(kind, targetKey, target, `Inside minimum range (${at.minRange})`);
  if (dist > at.maxRange) return illegal(kind, targetKey, target, `Out of range (${at.maxRange})`);

  const mods: Modifier[] = [];
  let los: LosResult | null = null;
  let blind = false;

  if (kind === 'melee') {
    if (Math.abs(ha - hb) > at.maxClimb + 1)
      return illegal(kind, targetKey, target, 'Too steep to close');
  } else if (kind === 'direct') {
    if (at.profile === 'tank_cannon' && inDepressionDeadZone(dist, ha, hb))
      return illegal(
        kind,
        targetKey,
        target,
        `Dead zone: gun depression max drop ${Math.floor(dist / 3)}`,
      );
    los = lineOfSight(a, b, ctx.heightOf, at.eye);
    if (los.status === 'blocked') return illegal(kind, targetKey, target, 'Line of sight blocked');
    if (los.status === 'marginal') mods.push({ label: 'Marginal LOS', value: 2 });
  } else {
    los = arcClearance(a, b, ctx.heightOf, at.eye);
    if (los.status === 'blocked') return illegal(kind, targetKey, target, 'Arc clipped by terrain');
    blind = !isSpotted(ctx, battle, attacker.team, targetKey);
    if (blind) mods.push({ label: 'Blind fire (no spotter)', value: BLIND_FIRE_TN });
  }

  const defType = target ? unitType(target.typeId) : null;
  const armor: ArmorClass = defType?.armorClass ?? 'unarmored';
  const baseTn = BASE_TN[armor];
  const er = kind === 'melee' ? 1 : effectiveRange(dist, ha, hb);
  const band = rangeBand(er);
  const bandMod = band.mod[at.profile];
  if (bandMod === null)
    return illegal(kind, targetKey, target, `${band.name} not possible for this weapon`);
  mods.push({ label: `${band.name} range (eff ${er})`, value: bandMod });

  if (kind === 'direct') {
    mods.push(
      attacker.moved ? { label: 'Moved then fired', value: 3 } : { label: 'Braced', value: -2 },
    );
  }

  let arc: FacingArc | null = null;
  let facingDamage = 0;
  if (target && armor !== 'unarmored') {
    arc = facingArc(targetKey, target.facing, attacker.pos);
    mods.push({ label: `${arc} armor`, value: FACING_MODS[arc].tn });
    facingDamage = FACING_MODS[arc].dmg;
  }

  const fort = battle.forts[targetKey] ?? 0;
  if (fort > 0 && target) {
    const cover = kind === 'indirect' ? Math.floor(fort / 2) : fort;
    if (cover > 0) mods.push({ label: `Fortified cover L${fort}`, value: cover });
  }
  if (attacker.suppressed) mods.push({ label: 'Suppressed', value: 2 });

  const tn = baseTn + mods.reduce((s, m) => s + m.value, 0);
  const he = isHE(at);
  const splashTn = he && !blind && tn > SPLASH_TN ? SPLASH_TN : null;
  const pDirect = pAtLeast(tn);
  const pSplash = splashTn !== null ? pSplashBand(tn) : 0;

  let expectedDamage = 0;
  if (defType) {
    let bonus = 0;
    if (at.charge && attacker.movedDist >= 3 && !defType.braced) bonus += 2;
    const direct = expectedHitDamage(at, defType, at.direct, facingDamage, bonus);
    const splash = at.splash ? expectedHitDamage(at, defType, at.splash, facingDamage) : 0;
    expectedDamage = pDirect * direct + pSplash * splash;
  }

  return {
    legal: true,
    reason: null,
    kind,
    targetKey,
    target,
    distance: dist,
    effectiveRange: er,
    band: band.name,
    baseTn,
    tn,
    modifiers: mods,
    splashTn,
    pDirect,
    pSplash,
    los,
    arc,
    facingDamage,
    blind,
    expectedDamage,
  };
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface AttackOutcome {
  roll: number;
  result: 'direct' | 'splash' | 'miss';
  damage: number;
  killed: string[];
  log: BattleLogEntry[];
}

function push(
  battle: Battle,
  log: BattleLogEntry[],
  text: string,
  kind: BattleLogEntry['kind'],
): void {
  const e: BattleLogEntry = { round: battle.round, team: battle.active, text, kind };
  log.push(e);
  battle.log.push(e);
}

interface HitSpec {
  attacker: BattleUnit;
  defender: BattleUnit;
  pool: DicePool;
  facingDmg: number;
  bonus: number;
  tag: string;
}

function applyHit(rng: Rng, battle: Battle, log: BattleLogEntry[], spec: HitSpec): number {
  const at = unitType(spec.attacker.typeId);
  const dt = unitType(spec.defender.typeId);
  const raw = rollPool(rng, spec.pool) + spec.bonus;
  let mult = effectivenessMultiplier(at.damageType, dt.armorClass);
  let note = `×${mult}`;
  if (at.damageType === 'siege' && dt.armorClass === 'unarmored') {
    const v = rng.die(6);
    const row = SIEGE_SOFT_TABLE.find((r) => v <= r.upTo)!;
    mult = row.mult;
    note = `×${mult} (variance d6=${v}: ${row.label})`;
  }
  const armor = ARMOR_RATING[dt.armorClass];
  const facing = dt.armorClass === 'unarmored' ? 0 : spec.facingDmg;
  const dmg = Math.max(0, Math.round(raw * mult) - armor + facing);
  spec.defender.hp = Math.max(0, spec.defender.hp - dmg);
  const bonusTxt = spec.bonus ? `+${spec.bonus}` : '';
  const armorTxt = armor ? ` −${armor} armor` : '';
  const facingTxt = facing ? ` ${facing > 0 ? '+' : ''}${facing} facing` : '';
  push(
    battle,
    log,
    `  ${spec.tag}: ${poolLabel(spec.pool)}${bonusTxt}=${raw} ${note}${armorTxt}${facingTxt} → ${dmg} dmg to ${spec.defender.label} (${spec.defender.hp}/${spec.defender.maxHp})`,
    dmg > 0 ? 'hit' : 'miss',
  );
  if (spec.defender.hp <= 0) push(battle, log, `  ✖ ${spec.defender.label} destroyed`, 'kill');
  return dmg;
}

function faceToward(u: BattleUnit, target: HexKey): void {
  if (u.pos && u.pos !== target) u.facing = bestFacing(u.pos, target);
}

/** A single melee strike (no reactions). */
function meleeStrike(
  rng: Rng,
  battle: Battle,
  log: BattleLogEntry[],
  striker: BattleUnit,
  victim: BattleUnit,
  bonus: number,
  tag: string,
): number {
  const st = unitType(striker.typeId);
  const vt = unitType(victim.typeId);
  let tn = BASE_TN[vt.armorClass] - 5; // point-blank
  let facingDmg = 0;
  if (vt.armorClass !== 'unarmored' && striker.pos && victim.pos) {
    const arc = facingArc(victim.pos, victim.facing, striker.pos);
    tn += FACING_MODS[arc].tn;
    facingDmg = FACING_MODS[arc].dmg;
  }
  const fort = victim.pos ? (battle.forts[victim.pos] ?? 0) : 0;
  tn += fort;
  if (striker.suppressed) tn += 2;
  const roll = rng.die(20);
  const hit = roll !== 1 && (roll === 20 || roll >= tn);
  push(
    battle,
    log,
    `  ${tag} ${striker.label} ⚔ ${victim.label}: d20=${roll} vs TN ${tn} → ${hit ? 'HIT' : 'MISS'}`,
    hit ? 'info' : 'miss',
  );
  if (!hit) return 0;
  return applyHit(rng, battle, log, {
    attacker: striker,
    defender: victim,
    pool: st.direct,
    facingDmg,
    bonus,
    tag: 'Damage',
  });
}

/** Ranged shot resolution (used for normal fire and archer first-strike). */
function rangedShot(
  ctx: BattleContext,
  rng: Rng,
  battle: Battle,
  log: BattleLogEntry[],
  shooter: BattleUnit,
  pv: AttackPreview,
  tag: string,
): { roll: number; result: 'direct' | 'splash' | 'miss'; damage: number } {
  const at = unitType(shooter.typeId);
  const roll = rng.die(20);
  const direct = roll !== 1 && (roll === 20 || roll >= pv.tn);
  const splash = !direct && pv.splashTn !== null && roll >= pv.splashTn;
  const result = direct ? 'direct' : splash ? 'splash' : 'miss';
  const modTxt = pv.modifiers
    .map((m) => `${m.label} ${m.value >= 0 ? '+' : ''}${m.value}`)
    .join(', ');
  push(
    battle,
    log,
    `${tag}${shooter.label} → ${pv.target?.label ?? `hex ${pv.targetKey}`}: d20=${roll} vs TN ${pv.tn} [base ${pv.baseTn}; ${modTxt}] → ${result.toUpperCase()}`,
    result === 'miss' ? 'miss' : 'info',
  );

  let damage = 0;
  const pool = direct ? at.direct : at.splash;
  if (result !== 'miss' && pool) {
    if (pv.target && pv.target.hp > 0) {
      damage += applyHit(rng, battle, log, {
        attacker: shooter,
        defender: pv.target,
        pool,
        facingDmg: pv.facingDamage,
        bonus: 0,
        tag: direct ? 'Direct' : 'Splash',
      });
    }
    // Area splash to other units around the impact point.
    if (at.splash && at.splashRadius > 0) {
      const centre = parseKey(pv.targetKey);
      for (const c of spiral(centre, at.splashRadius)) {
        const k = hexKey(c);
        if (k === pv.targetKey) continue;
        const u = ctx.unitAt.get(k);
        if (!u || u.hp <= 0 || u.id === shooter.id) continue;
        const arc =
          unitType(u.typeId).armorClass === 'unarmored'
            ? null
            : facingArc(k, u.facing, shooter.pos!);
        damage += applyHit(rng, battle, log, {
          attacker: shooter,
          defender: u,
          pool: at.splash,
          facingDmg: arc ? FACING_MODS[arc].dmg : 0,
          bonus: 0,
          tag: `Splash r${hexDistance(c, centre)}`,
        });
      }
    }
    // Siege is the only damage type that can reduce a fortification.
    if (direct && damagesFortification(at.damageType) && (battle.forts[pv.targetKey] ?? 0) > 0) {
      battle.forts[pv.targetKey]! -= 1;
      push(
        battle,
        log,
        `  Fortification at ${pv.targetKey} reduced to L${battle.forts[pv.targetKey]}`,
        'hit',
      );
      if (battle.forts[pv.targetKey] === 0) delete battle.forts[pv.targetKey];
    }
  }

  // Machine-gun suppression: hits or near misses pin unarmored targets.
  if (at.suppresses && pv.target && pv.target.hp > 0) {
    const tt = unitType(pv.target.typeId);
    if (tt.armorClass === 'unarmored' && (result !== 'miss' || roll >= pv.tn - 4)) {
      pv.target.suppressed = true;
      push(battle, log, `  ${pv.target.label} SUPPRESSED (half move, +2 TN next turn)`, 'info');
    }
  }
  return { roll, result, damage };
}

export function resolveAttack(
  ctx: BattleContext,
  rng: Rng,
  battle: Battle,
  attacker: BattleUnit,
  targetKey: HexKey,
): AttackOutcome | { error: string } {
  const pv = previewAttack(ctx, battle, attacker, targetKey);
  if (!pv.legal) return { error: pv.reason ?? 'Illegal attack' };
  const log: BattleLogEntry[] = [];
  const at = unitType(attacker.typeId);
  const before = new Map(battle.units.map((u) => [u.id, u.hp]));

  faceToward(attacker, targetKey);
  attacker.acted = true;
  attacker.mp = 0;
  attacker.revealed = true;

  let roll = 0;
  let result: AttackOutcome['result'] = 'miss';
  let damage = 0;

  if (pv.kind === 'melee') {
    const defender = pv.target!;
    const dt = unitType(defender.typeId);
    push(battle, log, `${attacker.label} charges ${defender.label}`, 'info');
    faceToward(defender, attacker.pos!);

    // Archers' first strike — denied if cavalry closed at speed.
    if (dt.firstStrike && !defender.firstStrikeUsed) {
      const fast = at.charge && attacker.movedDist >= 4;
      if (fast)
        push(
          battle,
          log,
          `  ${defender.label} first-strike denied — cavalry closed too fast`,
          'info',
        );
      else {
        defender.firstStrikeUsed = true;
        const bonus = meleeLikeVolley(rng, battle, log, defender, attacker);
        damage += bonus;
      }
    }
    // Spearmen braced against a cavalry charge strike first with +3.
    let spearStruck = false;
    if (attacker.hp > 0 && dt.braced && at.unitClass === 'cavalry') {
      spearStruck = true;
      push(battle, log, `  ${defender.label} BRACED vs cavalry — strikes first (+3)`, 'info');
      meleeStrike(rng, battle, log, defender, attacker, 3, '↳');
    }
    if (attacker.hp > 0) {
      const chargeBonus = at.charge && attacker.movedDist >= 3 && !dt.braced ? 2 : 0;
      if (chargeBonus) push(battle, log, `  Charge bonus +2 (moved ${attacker.movedDist})`, 'info');
      const dmg = meleeStrike(rng, battle, log, attacker, defender, chargeBonus, '↳');
      damage += dmg;
      result = dmg > 0 ? 'direct' : 'miss';
    }
    // Counter-attack by surviving melee defenders.
    if (defender.hp > 0 && attacker.hp > 0 && dt.attackType === 'melee' && !spearStruck) {
      meleeStrike(rng, battle, log, defender, attacker, 0, '↳ counter');
    }
  } else {
    const shot = rangedShot(ctx, rng, battle, log, attacker, pv, '');
    roll = shot.roll;
    result = shot.result;
    damage = shot.damage;
  }

  const killed = battle.units
    .filter((u) => u.hp <= 0 && (before.get(u.id) ?? 0) > 0)
    .map((u) => u.id);
  refreshOccupancy(ctx, battle);
  return { roll, result, damage, killed, log };
}

/** Archers' point-blank volley before melee contact. */
function meleeLikeVolley(
  rng: Rng,
  battle: Battle,
  log: BattleLogEntry[],
  archer: BattleUnit,
  target: BattleUnit,
): number {
  const tt = unitType(target.typeId);
  const tn = BASE_TN[tt.armorClass] - 5;
  const roll = rng.die(20);
  const hit = roll !== 1 && (roll === 20 || roll >= tn);
  push(
    battle,
    log,
    `  ${archer.label} FIRST STRIKE volley: d20=${roll} vs TN ${tn} → ${hit ? 'HIT' : 'MISS'}`,
    hit ? 'info' : 'miss',
  );
  if (!hit) return 0;
  return applyHit(rng, battle, log, {
    attacker: archer,
    defender: target,
    pool: unitType(archer.typeId).direct,
    facingDmg: 0,
    bonus: 0,
    tag: 'Volley',
  });
}

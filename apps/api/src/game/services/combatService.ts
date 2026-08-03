import type { ArmorClass, CombatResult, HeightMap, UnitDef, UnitInstance } from '@iron-ridge/types';
import { UNIT_DEFS } from '../unitDefs.ts';

// ── Dice ─────────────────────────────────────────────────────────────────────

function d(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

function rollPool(count: number, sides: number, bonus = 0): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += d(sides);
  return total + bonus;
}

// ── Target numbers by armor class (Section 1) ────────────────────────────────

const BASE_TN: Record<ArmorClass, number> = {
  unarmored: 15,
  light_armor: 10,
  heavy_armor: 7,
};

const SPLASH_TN = 10;

// ── Armor rating (Section 7) ─────────────────────────────────────────────────

const ARMOR_RATING: Record<ArmorClass, number> = {
  unarmored: 0,
  light_armor: 3,
  heavy_armor: 6,
};

// ── Range bands (Section 3) ──────────────────────────────────────────────────

type WeaponProfile = 'rifle_mg' | 'at_gun' | 'tank_cannon' | 'indirect';

function weaponProfile(def: UnitDef): WeaponProfile {
  if (def.attackType === 'indirect') return 'indirect';
  if (def.id === 'ww2_tank') return 'tank_cannon';
  if (def.id === 'ww2_at_gun') return 'at_gun';
  return 'rifle_mg';
}

const RANGE_TN: Record<WeaponProfile, { min: number; max: number; mod: number }[]> = {
  rifle_mg: [
    { min: 1, max: 1, mod: -5 }, // point-blank
    { min: 2, max: 3, mod: 0 }, // short
    { min: 4, max: 6, mod: 3 }, // medium
    { min: 7, max: 10, mod: 6 }, // long
    { min: 11, max: 999, mod: 10 }, // extreme
  ],
  at_gun: [
    { min: 1, max: 1, mod: -5 },
    { min: 2, max: 3, mod: 0 },
    { min: 4, max: 6, mod: 2 },
    { min: 7, max: 10, mod: 4 },
    { min: 11, max: 999, mod: 4 },
  ],
  tank_cannon: [
    { min: 1, max: 1, mod: 999 }, // N/A (can't fire)
    { min: 2, max: 3, mod: 0 },
    { min: 4, max: 6, mod: 2 },
    { min: 7, max: 10, mod: 4 },
    { min: 11, max: 999, mod: 4 },
  ],
  indirect: [
    { min: 1, max: 1, mod: 999 }, // n/a (min range)
    { min: 2, max: 3, mod: 0 },
    { min: 4, max: 6, mod: 0 },
    { min: 7, max: 10, mod: 2 },
    { min: 11, max: 999, mod: 4 },
  ],
};

function rangeMod(profile: WeaponProfile, effectiveRangeVal: number): number {
  const bands = RANGE_TN[profile];
  for (const band of bands) {
    if (effectiveRangeVal >= band.min && effectiveRangeVal <= band.max) return band.mod;
  }
  return 999; // out of range
}

// ── Effective range (Section 4) ──────────────────────────────────────────────

export function effectiveRange(ac: UnitInstance, dc: UnitInstance, hm: HeightMap): number {
  const ah = hm[ac.row]?.[ac.col] ?? 0;
  const dh = hm[dc.row]?.[dc.col] ?? 0;
  const horizDist = Math.abs(ac.col - dc.col) + Math.abs(ac.row - dc.row);
  const elevDelta = dh - ah; // positive = target is higher
  if (elevDelta > 0) {
    return horizDist + elevDelta * 2;
  }
  return horizDist;
}

// ── Tank gun depression check (Section 6) ────────────────────────────────────

export function inTankDeadZone(ac: UnitInstance, dc: UnitInstance, hm: HeightMap): boolean {
  const ah = hm[ac.row]?.[ac.col] ?? 0;
  const dh = hm[dc.row]?.[dc.col] ?? 0;
  const drop = ah - dh;
  if (drop <= 0) return false; // not firing downhill
  const horizDist = Math.abs(ac.col - dc.col) + Math.abs(ac.row - dc.row);
  const maxDrop = Math.floor(horizDist / 3);
  return drop > maxDrop;
}

// ── Damage pools (Section 7) ─────────────────────────────────────────────────

function rollDirectDamage(def: UnitDef): number {
  switch (def.id) {
    case 'ww2_rifle_infantry':
      return rollPool(1, 6);
    case 'ww2_machine_gun':
      return rollPool(1, 6, 1);
    case 'ww2_at_gun':
      return rollPool(2, 6, 2);
    case 'ww2_tank':
      return rollPool(3, 6, 3);
    case 'ww2_mortar':
      return rollPool(2, 6, 1);
    case 'ww2_artillery':
      return rollPool(3, 8, 4);
    case 'ww2_at_infantry':
      return rollPool(2, 6, 2);
    // medieval
    case 'med_infantry':
      return rollPool(1, 6);
    case 'med_archers':
      return rollPool(1, 6);
    case 'med_horseman':
      return rollPool(1, 8);
    case 'med_spearman':
      return rollPool(1, 6, 1);
    case 'med_artillery':
      return rollPool(2, 6, 1);
    default:
      return rollPool(1, 6);
  }
}

function rollSplashDamage(def: UnitDef): number {
  switch (def.id) {
    case 'ww2_at_gun':
      return rollPool(1, 6);
    case 'ww2_tank':
      return rollPool(2, 6);
    case 'ww2_mortar':
      return rollPool(2, 6, 1);
    case 'ww2_artillery':
      return rollPool(3, 8);
    case 'ww2_at_infantry':
      return rollPool(1, 6);
    case 'med_artillery':
      return rollPool(1, 6);
    default:
      return rollPool(1, 6);
  }
}

function isHE(def: UnitDef): boolean {
  return (
    def.damageType === 'siege' &&
    ['ww2_tank', 'ww2_at_gun', 'ww2_mortar', 'ww2_artillery', 'ww2_at_infantry', 'med_artillery'].includes(
      def.id,
    )
  );
}

// ── Main resolution function ─────────────────────────────────────────────────

export interface AttackOpts {
  attackerMoved?: boolean;
  facingMod?: number;
  facingDmg?: number;
  blindFire?: boolean;
}

export function resolveAttack(
  attacker: UnitInstance,
  defender: UnitInstance,
  hm: HeightMap,
  opts?: AttackOpts,
): CombatResult {
  const aDef: UnitDef = UNIT_DEFS[attacker.defId]!;
  const dDef: UnitDef = UNIT_DEFS[defender.defId]!;
  const log: string[] = [];

  // 1. Tank depression check
  if (aDef.id === 'ww2_tank' && inTankDeadZone(attacker, defender, hm)) {
    log.push('TANK DEAD ZONE — target below gun depression arc. Cannot fire.');
    return {
      attackerId: attacker.id,
      defenderId: defender.id,
      toHitRoll: 0,
      adjustedTN: 999,
      hit: false,
      splash: false,
      damageRoll: 0,
      armorReduction: 0,
      finalDamage: 0,
      log,
    };
  }

  // 2. Compute base TN
  const baseTN = BASE_TN[dDef.armorClass];
  log.push(`Base TN (${dDef.armorClass}): ${baseTN}`);

  // 3. Range modifier
  const er = effectiveRange(attacker, defender, hm);
  const profile = weaponProfile(aDef);
  const rMod = rangeMod(profile, er);
  if (rMod >= 999) {
    log.push('OUT OF RANGE — cannot fire at point-blank with tank cannon.');
    return {
      attackerId: attacker.id,
      defenderId: defender.id,
      toHitRoll: 0,
      adjustedTN: 999,
      hit: false,
      splash: false,
      damageRoll: 0,
      armorReduction: 0,
      finalDamage: 0,
      log,
    };
  }
  log.push(`Effective range: ${er} → range mod: +${rMod}`);

  // 4. Movement modifier (Section 7b)
  const moveMod = opts?.attackerMoved ? 3 : -2;
  log.push(`Movement state: ${opts?.attackerMoved ? 'moved (+3)' : 'braced (-2)'}`);

  // 5. Facing modifier (Section 7a)
  const facingTN = opts?.facingMod ?? 0;
  if (facingTN !== 0) log.push(`Facing TN mod: ${facingTN}`);

  // 6. Blind fire (indirect only)
  const blindMod = opts?.blindFire ? 6 : 0;
  if (blindMod) log.push('Blind fire: +6 TN');

  const adjustedTN = baseTN + rMod + moveMod + facingTN + blindMod;
  log.push(`Adjusted TN: ${adjustedTN}`);

  // 7. To-hit roll
  const toHitRoll = d(20);
  log.push(`d20 roll: ${toHitRoll}`);

  const direct = toHitRoll >= adjustedTN;
  const splash = !direct && isHE(aDef) && toHitRoll >= SPLASH_TN && !opts?.blindFire;

  if (!direct && !splash) {
    log.push('MISS');
    return {
      attackerId: attacker.id,
      defenderId: defender.id,
      toHitRoll,
      adjustedTN,
      hit: false,
      splash: false,
      damageRoll: 0,
      armorReduction: 0,
      finalDamage: 0,
      log,
    };
  }

  log.push(direct ? 'DIRECT HIT' : 'SPLASH HIT');

  // 8. Damage roll
  const rawDmg = direct ? rollDirectDamage(aDef) : rollSplashDamage(aDef);
  log.push(`Damage roll: ${rawDmg}`);

  const armor = ARMOR_RATING[dDef.armorClass];
  const facingDmg = opts?.facingDmg ?? 0;
  const finalDamage = Math.max(0, rawDmg - armor + facingDmg);
  log.push(`After armor (${armor}) + facing (${facingDmg}): ${finalDamage} damage`);

  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    toHitRoll,
    adjustedTN,
    hit: true,
    splash,
    damageRoll: rawDmg,
    armorReduction: armor,
    finalDamage,
    log,
  };
}

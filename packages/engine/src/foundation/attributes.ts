// Pure foundation rules. Callers resolve reach/ownership and event timing before
// supplying these facts; this module never issues income or mutates a GameState.

export type BuildingSpecialty = 'generic' | 'industrial' | 'military' | 'medical' | 'logistics';
export type SpecializedCenterRole = Exclude<BuildingSpecialty, 'generic'>;
export type BuildingTier = 1 | 2 | 3;
export type BuildingPlacement = 'center' | 'annex';

export interface FoundationCenter {
  role: BuildingSpecialty;
  tier: BuildingTier;
}

export interface FoundationBuildingDefinition {
  role: string;
  specialty: BuildingSpecialty;
  centerEligible: boolean;
  annexEligible: boolean;
  minimumGenericCenterTier: BuildingTier;
  maximumTier: BuildingTier;
  prerequisites: readonly string[];
  specialtyExceptions: readonly {
    centerRole: SpecializedCenterRole;
    maximumTier: BuildingTier;
    enabled: boolean;
  }[];
}

export interface BuildingEligibility {
  eligible: boolean;
  reason: 'eligible' | 'placement' | 'center-tier' | 'building-tier' | 'prerequisites';
  maximumTier: number;
  missingPrerequisites: string[];
}

const SPECIALTIES: readonly BuildingSpecialty[] = [
  'generic',
  'industrial',
  'military',
  'medical',
  'logistics',
];

function id(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: expected an ID`);
}

function finite(value: number, label: string, nonnegative = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) {
    throw new Error(`${label}: expected a finite${nonnegative ? ' non-negative' : ''} number`);
  }
}

function flag(value: boolean, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label}: expected a boolean`);
}

function tier(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error(`${label}: expected tier 1, 2 or 3`);
  }
}

function uniqueIds(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    id(value, label);
    if (seen.has(value)) throw new Error(`${label}: duplicate ID ${value}`);
    seen.add(value);
  }
}

/** Role/tier/prerequisite eligibility only, not CP, engineer or slot availability. */
export function evaluateBuildingEligibility(input: {
  definition: FoundationBuildingDefinition;
  center: FoundationCenter;
  placement: BuildingPlacement;
  requestedTier: BuildingTier;
  availablePrerequisites: readonly string[];
}): BuildingEligibility {
  const { definition: d, center, placement, requestedTier } = input;
  id(d.role, 'building role');
  if (!SPECIALTIES.includes(d.specialty) || !SPECIALTIES.includes(center.role)) {
    throw new Error('Unknown building or center specialty');
  }
  tier(center.tier, 'center');
  if (center.role !== 'generic' && center.tier > 2) {
    throw new Error('Specialized centers have at most two tiers');
  }
  tier(d.maximumTier, 'building maximum');
  tier(d.minimumGenericCenterTier, 'generic center minimum');
  tier(requestedTier, 'requested building');
  flag(d.centerEligible, 'center eligibility');
  flag(d.annexEligible, 'annex eligibility');
  if (placement !== 'center' && placement !== 'annex')
    throw new Error('Unknown building placement');
  uniqueIds(d.prerequisites, 'building prerequisites');
  uniqueIds(input.availablePrerequisites, 'available prerequisites');
  const exceptions = new Map<SpecializedCenterRole, number>();
  for (const exception of d.specialtyExceptions) {
    if (
      exception.centerRole === ('generic' as BuildingSpecialty) ||
      !SPECIALTIES.includes(exception.centerRole)
    ) {
      throw new Error('Specialty exception must name a specialized center');
    }
    tier(exception.maximumTier, 'exception maximum');
    flag(exception.enabled, 'exception enabled');
    if (exceptions.has(exception.centerRole)) throw new Error('Duplicate specialty exception');
    exceptions.set(exception.centerRole, exception.enabled ? exception.maximumTier : 1);
  }
  let allowedTier =
    center.role === 'generic'
      ? center.tier
      : center.role === d.specialty
        ? center.tier + 1
        : (exceptions.get(center.role) ?? 1);
  if (center.role === 'generic' && center.tier < d.minimumGenericCenterTier) allowedTier = 0;
  const maximumTier = Math.min(d.maximumTier, allowedTier);
  const available = new Set(input.availablePrerequisites);
  const missingPrerequisites = d.prerequisites.filter((p) => !available.has(p)).sort();
  const reason: BuildingEligibility['reason'] = !(placement === 'center'
    ? d.centerEligible
    : d.annexEligible)
    ? 'placement'
    : requestedTier > d.maximumTier
      ? 'building-tier'
      : requestedTier > allowedTier
        ? 'center-tier'
        : missingPrerequisites.length
          ? 'prerequisites'
          : 'eligible';
  return { eligible: reason === 'eligible', reason, maximumTier, missingPrerequisites };
}

/** A repaired annex can be intact but inactive until its center is operational. */
export function isBuildingEffectActive(input: {
  placement: BuildingPlacement;
  buildingOperational: boolean;
  centerOperational: boolean;
}): boolean {
  flag(input.buildingOperational, 'building operational');
  flag(input.centerOperational, 'center operational');
  if (input.placement !== 'center' && input.placement !== 'annex') {
    throw new Error('Unknown building placement');
  }
  return input.buildingOperational && (input.placement === 'center' || input.centerOperational);
}

/** Validates persisted choices without replacing selections or granting unlocks. */
export function validateBuildingUpgradeState(input: {
  maximumTier: BuildingTier;
  exclusiveOptions: readonly string[];
  slotlessOptions: readonly string[];
  tier: BuildingTier;
  exclusiveChoices: readonly string[];
  unlocks: readonly string[];
}): { valid: boolean; errors: string[] } {
  tier(input.maximumTier, 'maximum upgrade');
  uniqueIds(input.exclusiveOptions, 'exclusive definitions');
  uniqueIds(input.slotlessOptions, 'slotless definitions');
  const errors: string[] = [];
  if (!Number.isInteger(input.tier) || input.tier < 1 || input.tier > input.maximumTier) {
    errors.push('Building tier is outside its definition');
  }
  if (input.exclusiveChoices.length > 1) errors.push('Only one exclusive choice is permitted');
  for (const choice of input.exclusiveChoices) {
    if (!input.exclusiveOptions.includes(choice))
      errors.push(`Unknown exclusive choice: ${choice}`);
  }
  if (new Set(input.unlocks).size !== input.unlocks.length)
    errors.push('Duplicate slotless unlock');
  for (const unlock of input.unlocks) {
    if (!input.slotlessOptions.includes(unlock)) errors.push(`Unknown slotless unlock: ${unlock}`);
  }
  return { valid: errors.length === 0, errors };
}

export function isNextBuildingTier(current: BuildingTier, requested: BuildingTier): boolean {
  tier(current, 'current building');
  tier(requested, 'requested building');
  return requested === current + 1;
}

export type AttributeRounding = 'none' | 'floor' | 'ceil' | 'nearest' | 'aggregate-income';
export type AttributeStackGroup =
  | { id: string; phase: 'flat'; combine: 'additive' | 'highest-only' }
  | { id: string; phase: 'multiplier'; combine: 'multiplicative' | 'highest-only' };

export interface FoundationAttributeDefinition {
  id: string;
  units: string;
  groups: readonly AttributeStackGroup[];
  hqGroupId: string | null;
  minimum: number | null;
  maximum: number | null;
  rounding: AttributeRounding;
}

interface AttributeSource {
  sourceId: string;
  attributeId: string;
  targetId: string;
  units: string;
  active: boolean;
  eligible: boolean;
  value: FoundationAmount;
}

export interface FoundationAttributeContribution extends AttributeSource {
  groupId: string;
}

export interface HomeConnectedBoost {
  operation: 'add' | 'multiply';
  value: number;
  cap: number | null;
}

/** A positive scalar HQ benefit, already qualified for this target by the caller. */
export interface FoundationHqContribution extends AttributeSource {
  hqId: string;
  kind: 'home' | 'regional';
  homeConnected: boolean;
  boost: HomeConnectedBoost | null;
}

/** JSON-safe exact amount. The decimal string is canonical, without an exponent. */
export interface FoundationExactAmount {
  readonly decimal: string;
}

export type FoundationAmount = number | FoundationExactAmount;

export interface FoundationAttributeEvaluation {
  /** Aggregate income must pass this exact token directly to calculateFoundationIncome. */
  value: number | FoundationExactAmount;
  /** Exact output after this attribute's declared rounding boundary; safe to compose. */
  exactValue: FoundationExactAmount;
  /** Numeric explanation fields are display previews, never aggregate-income inputs. */
  unroundedValue: number;
  flatValue: number;
  multiplier: number;
  appliedSources: string[];
  excludedSources: { sourceId: string; reason: 'inactive' | 'ineligible' | 'competing-hq' }[];
  deduplicatedSources: string[];
  selectedHq: {
    hqId: string;
    sourceId: string;
    originalValue: number;
    boostedValue: number;
  } | null;
  groups: { id: string; phase: 'flat' | 'multiplier'; value: number; sourceIds: string[] }[];
}

// Decimal arithmetic keeps explicit numeric configuration exact through additions
// and multiplications. No epsilon or intermediate per-source rounding is applied.
interface Decimal {
  coefficient: bigint;
  scale: number;
}
const ZERO: Decimal = { coefficient: 0n, scale: 0 };
const ONE: Decimal = { coefficient: 1n, scale: 0 };
function decimal(value: number): Decimal {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const parts = mantissa.split('.');
  let coefficient = BigInt(parts.join(''));
  let scale = (parts[1]?.length ?? 0) - Number(exponent);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}
function plus(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return {
    coefficient:
      a.coefficient * 10n ** BigInt(scale - a.scale) +
      b.coefficient * 10n ** BigInt(scale - b.scale),
    scale,
  };
}
function times(a: Decimal, b: Decimal): Decimal {
  return { coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale };
}
function compare(a: Decimal, b: Decimal): number {
  const difference = plus(a, { coefficient: -b.coefficient, scale: b.scale }).coefficient;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function number(a: Decimal): number {
  const result = Number(`${a.coefficient}e-${a.scale}`);
  finite(result, 'calculated attribute');
  return result;
}
function exactAmount(a: Decimal): FoundationExactAmount {
  if (a.coefficient === 0n) return { decimal: '0' };
  const sign = a.coefficient < 0n ? '-' : '';
  const digits = (a.coefficient < 0n ? -a.coefficient : a.coefficient)
    .toString()
    .padStart(a.scale + 1, '0');
  if (a.scale === 0) return { decimal: `${sign}${digits}` };
  const fraction = digits.slice(-a.scale).replace(/0+$/, '');
  return {
    decimal: `${sign}${digits.slice(0, -a.scale)}${fraction ? `.${fraction}` : ''}`,
  };
}
const exactCache = new WeakMap<FoundationExactAmount, { text: string; value: Decimal }>();
function amount(value: FoundationAmount, label: string, nonnegative = false): Decimal {
  if (typeof value === 'number') {
    finite(value, label, nonnegative);
    return decimal(value);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'decimal') ||
    typeof value.decimal !== 'string' ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.decimal)
  ) {
    throw new Error(`${label}: exact amount must contain only a canonical decimal string`);
  }
  const cached = exactCache.get(value);
  if (cached?.text === value.decimal) {
    if (nonnegative && cached.value.coefficient < 0n)
      throw new Error(`${label} must be non-negative`);
    return cached.value;
  }
  const parts = value.decimal.split('.');
  const result = { coefficient: BigInt(parts.join('')), scale: parts[1]?.length ?? 0 };
  if (exactAmount(result).decimal !== value.decimal) {
    throw new Error(`${label}: exact amount is not canonical`);
  }
  if (nonnegative && result.coefficient < 0n) throw new Error(`${label} must be non-negative`);
  number(result);
  exactCache.set(value, { text: value.decimal, value: result });
  return result;
}

/** Canonical JSON-safe arithmetic. Numeric inputs mean their explicit decimal spelling. */
export function foundationExactAmount(value: FoundationAmount): FoundationExactAmount {
  return exactAmount(amount(value, 'foundation amount'));
}

/** Numeric preview only; compose calculations using the exact token instead. */
export function foundationAmountNumber(value: FoundationAmount): number {
  return number(amount(value, 'foundation amount'));
}

export function addFoundationAmounts(
  a: FoundationAmount,
  b: FoundationAmount,
): FoundationExactAmount {
  const result = plus(amount(a, 'foundation amount'), amount(b, 'foundation amount'));
  number(result);
  return exactAmount(result);
}

export function subtractFoundationAmounts(
  a: FoundationAmount,
  b: FoundationAmount,
): FoundationExactAmount {
  const right = amount(b, 'foundation amount');
  const result = plus(amount(a, 'foundation amount'), {
    coefficient: -right.coefficient,
    scale: right.scale,
  });
  number(result);
  return exactAmount(result);
}

export function multiplyFoundationAmounts(
  a: FoundationAmount,
  b: FoundationAmount,
): FoundationExactAmount {
  const result = times(amount(a, 'foundation amount'), amount(b, 'foundation amount'));
  number(result);
  return exactAmount(result);
}

export function compareFoundationAmounts(a: FoundationAmount, b: FoundationAmount): -1 | 0 | 1 {
  return compare(amount(a, 'foundation amount'), amount(b, 'foundation amount')) as -1 | 0 | 1;
}

export function maxFoundationAmounts(
  a: FoundationAmount,
  b: FoundationAmount,
): FoundationExactAmount {
  const left = amount(a, 'foundation amount');
  const right = amount(b, 'foundation amount');
  return exactAmount(compare(left, right) >= 0 ? left : right);
}

/** Exact multiplication for a non-negative integral count, such as distinct hostile crossings. */
export function powerFoundationAmount(
  value: FoundationAmount,
  exponent: number,
): FoundationExactAmount {
  if (!Number.isSafeInteger(exponent) || exponent < 0)
    throw new Error('Foundation exponent must be a non-negative safe integer');
  let factor = amount(value, 'foundation amount');
  let result = ONE;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining % 2 === 1) result = times(result, factor);
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor = times(factor, factor);
    number(result);
    number(factor);
  }
  return exactAmount(result);
}
function floor(a: Decimal): bigint {
  const divisor = 10n ** BigInt(a.scale);
  const result = a.coefficient / divisor;
  return a.coefficient < 0n && a.coefficient % divisor !== 0n ? result - 1n : result;
}
function rounded(a: Decimal, mode: AttributeRounding): number {
  if (mode === 'none' || mode === 'aggregate-income') return number(a);
  if (mode === 'floor') return Number(floor(a));
  if (mode === 'nearest') return Number(floor(plus(a, decimal(0.5))));
  return Number(-floor({ coefficient: -a.coefficient, scale: a.scale }));
}
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sourceKey = (c: AttributeSource): string =>
  JSON.stringify([c.sourceId, c.attributeId, c.targetId]);

/**
 * Shared pure arithmetic; active/eligible are resolved facts, not client authority.
 * This API supports scalar benefits where a higher HQ contribution is beneficial.
 * It does not decide routes, cut eligibility, targets, topology or event issuance.
 */
export function evaluateFoundationAttribute(input: {
  definition: FoundationAttributeDefinition;
  targetId: string;
  baseValue: FoundationAmount;
  contributions: readonly FoundationAttributeContribution[];
  hqContributions: readonly FoundationHqContribution[];
}): FoundationAttributeEvaluation {
  const { definition: d, targetId } = input;
  id(d.id, 'attribute');
  id(d.units, 'attribute units');
  id(targetId, 'target');
  const baseValue = amount(input.baseValue, 'base value');
  if (!['none', 'floor', 'ceil', 'nearest', 'aggregate-income'].includes(d.rounding)) {
    throw new Error('Unknown attribute rounding');
  }
  if (d.minimum !== null) finite(d.minimum, 'attribute minimum');
  if (d.maximum !== null) finite(d.maximum, 'attribute maximum');
  if (d.minimum !== null && d.maximum !== null && d.minimum > d.maximum) {
    throw new Error('Attribute minimum exceeds maximum');
  }
  const groups = new Map<string, AttributeStackGroup>();
  for (const group of d.groups) {
    id(group.id, 'stack group');
    const allowed =
      group.phase === 'flat'
        ? ['additive', 'highest-only']
        : group.phase === 'multiplier'
          ? ['multiplicative', 'highest-only']
          : [];
    if (!allowed.includes(group.combine)) throw new Error('Unknown stack group behavior');
    if (groups.has(group.id)) throw new Error(`Duplicate stack group: ${group.id}`);
    groups.set(group.id, group);
  }
  if (d.hqGroupId !== null && groups.get(d.hqGroupId)?.phase !== 'flat') {
    throw new Error('HQ group must be a declared flat group');
  }
  const excluded = new Map<string, FoundationAttributeEvaluation['excludedSources'][number]>();
  const duplicateIds = new Set<string>();
  const fingerprints = new Map<string, string>();
  const effects: FoundationAttributeContribution[] = [];
  const candidates: FoundationHqContribution[] = [];
  const exclude = (
    sourceId: string,
    reason: FoundationAttributeEvaluation['excludedSources'][number]['reason'],
  ): void => {
    excluded.set(JSON.stringify([sourceId, reason]), { sourceId, reason });
  };
  const checkSource = (source: AttributeSource, expectedUnits: string): boolean => {
    id(source.sourceId, 'source');
    if (source.attributeId !== d.id || source.targetId !== targetId)
      throw new Error('Contribution attribute/target mismatch');
    if (source.units !== expectedUnits) throw new Error('Contribution units mismatch');
    amount(source.value, 'contribution');
    flag(source.active, 'source active');
    flag(source.eligible, 'source eligible');
    if (!source.active) {
      exclude(source.sourceId, 'inactive');
      return false;
    }
    if (!source.eligible) {
      exclude(source.sourceId, 'ineligible');
      return false;
    }
    return true;
  };
  const distinct = (source: AttributeSource, fingerprint: string): boolean => {
    const key = sourceKey(source);
    const previous = fingerprints.get(key);
    if (previous !== undefined) {
      if (previous !== fingerprint)
        throw new Error(`Conflicting duplicate source: ${source.sourceId}`);
      duplicateIds.add(source.sourceId);
      return false;
    }
    fingerprints.set(key, fingerprint);
    return true;
  };
  for (const c of input.contributions) {
    const group = groups.get(c.groupId);
    if (!group) throw new Error(`Unknown contribution group: ${c.groupId}`);
    const value = amount(
      c.value,
      group.phase === 'multiplier' ? 'multiplier' : 'contribution',
      group.phase === 'multiplier',
    );
    if (!checkSource(c, group.phase === 'flat' ? d.units : 'factor')) continue;
    if (distinct(c, JSON.stringify(['effect', c.groupId, exactAmount(value).decimal])))
      effects.push(c);
  }
  for (const c of input.hqContributions) {
    id(c.hqId, 'HQ');
    flag(c.homeConnected, 'Home connectivity');
    if (c.kind !== 'home' && c.kind !== 'regional') throw new Error('Unknown HQ kind');
    const value = amount(c.value, 'HQ contribution', true);
    if (d.hqGroupId === null) throw new Error('HQ contribution requires an explicit HQ group');
    if (c.boost !== null) {
      if (c.boost.operation !== 'add' && c.boost.operation !== 'multiply')
        throw new Error('Unknown HQ boost');
      finite(c.boost.value, 'HQ boost');
      if (c.boost.value <= (c.boost.operation === 'add' ? 0 : 1))
        throw new Error('HQ boost must improve positive benefits');
      if (c.boost.cap !== null) {
        finite(c.boost.cap, 'HQ boost cap', true);
        if (compare(decimal(c.boost.cap), value) < 0)
          throw new Error('HQ boost cap is below its unboosted contribution');
      }
    }
    if (c.kind === 'regional' && c.homeConnected && c.boost === null) {
      throw new Error('Home-connected Regional HQ requires an explicit boost');
    }
    if (!checkSource(c, d.units)) continue;
    const boost = c.boost === null ? null : [c.boost.operation, c.boost.value, c.boost.cap];
    if (
      distinct(
        c,
        JSON.stringify(['hq', c.hqId, c.kind, c.homeConnected, exactAmount(value).decimal, boost]),
      )
    )
      candidates.push(c);
  }
  const hqs = candidates
    .map((c) => {
      let value = amount(c.value, 'HQ contribution', true);
      if (c.kind === 'regional' && c.homeConnected && c.boost !== null && value.coefficient > 0n) {
        value =
          c.boost.operation === 'add'
            ? plus(value, decimal(c.boost.value))
            : times(value, decimal(c.boost.value));
        if (c.boost.cap !== null && compare(value, decimal(c.boost.cap)) > 0)
          value = decimal(c.boost.cap);
      }
      number(value);
      return { contribution: c, value };
    })
    .sort(
      (a, b) =>
        compare(b.value, a.value) ||
        lexical(a.contribution.hqId, b.contribution.hqId) ||
        lexical(a.contribution.sourceId, b.contribution.sourceId),
    );
  const chosen = hqs[0];
  const selectedHq = chosen
    ? {
        hqId: chosen.contribution.hqId,
        sourceId: chosen.contribution.sourceId,
        originalValue: number(amount(chosen.contribution.value, 'HQ contribution', true)),
        boostedValue: number(chosen.value),
      }
    : null;
  for (const candidate of hqs.slice(1)) exclude(candidate.contribution.sourceId, 'competing-hq');
  const grouped = new Map<string, { sourceId: string; value: Decimal }[]>();
  for (const c of effects) {
    const list = grouped.get(c.groupId) ?? [];
    list.push({ sourceId: c.sourceId, value: amount(c.value, 'contribution') });
    grouped.set(c.groupId, list);
  }
  if (chosen && d.hqGroupId !== null) {
    const list = grouped.get(d.hqGroupId) ?? [];
    list.push({ sourceId: chosen.contribution.sourceId, value: chosen.value });
    grouped.set(d.hqGroupId, list);
  }
  let flat = baseValue;
  let multiplier = ONE;
  const explanation: FoundationAttributeEvaluation['groups'] = [];
  const appliedSources = new Set<string>();
  for (const group of [...groups.values()].sort((a, b) => lexical(a.id, b.id))) {
    const list = (grouped.get(group.id) ?? []).sort((a, b) => lexical(a.sourceId, b.sourceId));
    let value = group.phase === 'flat' ? ZERO : ONE;
    const applied =
      group.combine === 'highest-only' && list.length
        ? [...list]
            .sort((a, b) => compare(b.value, a.value) || lexical(a.sourceId, b.sourceId))
            .slice(0, 1)
        : list;
    for (const c of applied) {
      value =
        group.combine === 'highest-only'
          ? c.value
          : group.combine === 'additive'
            ? plus(value, c.value)
            : times(value, c.value);
      appliedSources.add(c.sourceId);
    }
    if (group.phase === 'flat') flat = plus(flat, value);
    else multiplier = times(multiplier, value);
    explanation.push({
      id: group.id,
      phase: group.phase,
      value: number(value),
      sourceIds: applied.map((c) => c.sourceId),
    });
  }
  let result = times(flat, multiplier);
  if (d.minimum !== null && compare(result, decimal(d.minimum)) < 0) result = decimal(d.minimum);
  if (d.maximum !== null && compare(result, decimal(d.maximum)) > 0) result = decimal(d.maximum);
  const numericValue = rounded(result, d.rounding);
  finite(numericValue, 'rounded attribute');
  return {
    value: d.rounding === 'aggregate-income' ? exactAmount(result) : numericValue,
    exactValue: exactAmount(
      d.rounding === 'none' || d.rounding === 'aggregate-income'
        ? result
        : {
            coefficient:
              d.rounding === 'floor'
                ? floor(result)
                : d.rounding === 'ceil'
                  ? -floor({ coefficient: -result.coefficient, scale: result.scale })
                  : floor(plus(result, decimal(0.5))),
            scale: 0,
          },
    ),
    unroundedValue: number(result),
    flatValue: number(flat),
    multiplier: number(multiplier),
    appliedSources: [...appliedSources].sort(lexical),
    excludedSources: [...excluded.values()].sort(
      (a, b) => lexical(a.sourceId, b.sourceId) || lexical(a.reason, b.reason),
    ),
    deduplicatedSources: [...duplicateIds].sort(lexical),
    selectedHq,
    groups: explanation,
  };
}

export interface FoundationIncomeContribution {
  sourceId: string;
  kind: 'territory' | 'building';
  value: number | FoundationExactAmount;
  active: boolean;
  eligible: boolean;
}

/**
 * Projection only: modifiers precede this boundary; no event/pool/receipt is mutated.
 * Pass aggregate-income evaluation.value directly, including after a JSON round trip.
 * Numeric totals/remainders are display previews; their exact tokens preserve precision.
 */
export function calculateFoundationIncome(input: {
  baseGrant: number;
  contributions: readonly FoundationIncomeContribution[];
}): {
  cp: number;
  unroundedTotal: number;
  exactTotal: FoundationExactAmount;
  discardedFraction: number;
  exactDiscardedFraction: FoundationExactAmount;
  appliedSources: string[];
} {
  finite(input.baseGrant, 'base grant', true);
  const sources = new Map<string, { kind: FoundationIncomeContribution['kind']; value: Decimal }>();
  for (const c of input.contributions) {
    id(c.sourceId, 'income source');
    const value = amount(c.value, 'Income contribution', true);
    flag(c.active, 'income active');
    flag(c.eligible, 'income eligible');
    if (c.kind !== 'territory' && c.kind !== 'building')
      throw new Error('Unknown income contribution kind');
    if (!c.active || !c.eligible) continue;
    const prior = sources.get(c.sourceId);
    if (prior && (compare(prior.value, value) !== 0 || prior.kind !== c.kind))
      throw new Error(`Conflicting duplicate income source: ${c.sourceId}`);
    sources.set(c.sourceId, { kind: c.kind, value });
  }
  let total = decimal(input.baseGrant);
  for (const [, c] of [...sources.entries()].sort(([a], [b]) => lexical(a, b)))
    total = plus(total, c.value);
  const integral = floor(total);
  const cp = Number(integral);
  if (!Number.isSafeInteger(cp)) throw new Error('Income exceeds the safe integer CP range');
  const remainder = plus(total, { coefficient: -integral, scale: 0 });
  return {
    cp,
    unroundedTotal: number(total),
    exactTotal: exactAmount(total),
    discardedFraction: number(remainder),
    exactDiscardedFraction: exactAmount(remainder),
    appliedSources: [...sources.keys()].sort(lexical),
  };
}

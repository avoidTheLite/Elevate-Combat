import { describe, expect, it } from 'vitest';
import {
  calculateFoundationIncome,
  addFoundationAmounts,
  compareFoundationAmounts,
  evaluateBuildingEligibility,
  evaluateFoundationAttribute,
  foundationAmountNumber,
  foundationExactAmount,
  isBuildingEffectActive,
  isNextBuildingTier,
  maxFoundationAmounts,
  multiplyFoundationAmounts,
  powerFoundationAmount,
  subtractFoundationAmounts,
  validateBuildingUpgradeState,
} from './attributes.ts';
import type {
  FoundationAttributeContribution,
  FoundationAmount,
  FoundationAttributeDefinition,
  FoundationAttributeEvaluation,
  FoundationBuildingDefinition,
  FoundationHqContribution,
  FoundationIncomeContribution,
} from './attributes.ts';

const forge: FoundationBuildingDefinition = {
  role: 'forge',
  specialty: 'industrial',
  centerEligible: false,
  annexEligible: true,
  minimumGenericCenterTier: 1,
  maximumTier: 3,
  prerequisites: [],
  specialtyExceptions: [],
};
const definition: FoundationAttributeDefinition = {
  id: 'output',
  units: 'units',
  groups: [
    { id: 'flat', phase: 'flat', combine: 'additive' },
    { id: 'aura', phase: 'flat', combine: 'highest-only' },
    { id: 'weather', phase: 'multiplier', combine: 'multiplicative' },
    { id: 'equipment', phase: 'multiplier', combine: 'highest-only' },
  ],
  hqGroupId: 'flat',
  minimum: null,
  maximum: null,
  rounding: 'none',
};
const effect = (
  sourceId: string,
  value: number,
  overrides: Partial<FoundationAttributeContribution> = {},
): FoundationAttributeContribution => ({
  sourceId,
  attributeId: 'output',
  targetId: 'node',
  units: 'units',
  groupId: 'flat',
  active: true,
  eligible: true,
  value,
  ...overrides,
});
const hq = (
  hqId: string,
  value: number,
  overrides: Partial<FoundationHqContribution> = {},
): FoundationHqContribution => ({
  hqId,
  sourceId: `source-${hqId}`,
  attributeId: 'output',
  targetId: 'node',
  units: 'units',
  active: true,
  eligible: true,
  value,
  kind: 'regional',
  homeConnected: false,
  boost: null,
  ...overrides,
});
const evaluate = (
  contributions: readonly FoundationAttributeContribution[],
  hqContributions: readonly FoundationHqContribution[] = [],
  overrides: Partial<FoundationAttributeDefinition> = {},
  baseValue: FoundationAmount = 10,
): FoundationAttributeEvaluation =>
  evaluateFoundationAttribute({
    definition: { ...definition, ...overrides },
    targetId: 'node',
    baseValue,
    contributions,
    hqContributions,
  });
const income = (
  sourceId: string,
  value: number,
  overrides: Partial<FoundationIncomeContribution> = {},
): FoundationIncomeContribution => ({
  sourceId,
  value,
  kind: 'building',
  active: true,
  eligible: true,
  ...overrides,
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: foundation building eligibility', () => {
  it('allows specialty tier 2 at Industrial T1 and tier 3 only at Industrial T2', () => {
    const request = { definition: forge, placement: 'annex' as const, availablePrerequisites: [] };
    expect(
      evaluateBuildingEligibility({
        ...request,
        center: { role: 'industrial', tier: 1 },
        requestedTier: 2,
      }).eligible,
    ).toBe(true);
    expect(
      evaluateBuildingEligibility({
        ...request,
        center: { role: 'industrial', tier: 1 },
        requestedTier: 3,
      }),
    ).toMatchObject({ eligible: false, reason: 'center-tier', maximumTier: 2 });
    expect(
      evaluateBuildingEligibility({
        ...request,
        center: { role: 'industrial', tier: 2 },
        requestedTier: 3,
      }).eligible,
    ).toBe(true);
  });

  it('keeps off-specialty buildings at tier 1 without an explicitly enabled exception', () => {
    const hospital = { ...forge, role: 'hospital', specialty: 'medical' as const };
    const request = {
      definition: hospital,
      center: { role: 'industrial' as const, tier: 2 as const },
      placement: 'annex' as const,
      requestedTier: 2 as const,
      availablePrerequisites: [],
    };
    expect(evaluateBuildingEligibility(request).eligible).toBe(false);
    const exception = {
      centerRole: 'industrial' as const,
      maximumTier: 2 as const,
      enabled: false,
    };
    expect(
      evaluateBuildingEligibility({
        ...request,
        definition: { ...hospital, specialtyExceptions: [exception] },
      }).eligible,
    ).toBe(false);
    expect(
      evaluateBuildingEligibility({
        ...request,
        definition: { ...hospital, specialtyExceptions: [{ ...exception, enabled: true }] },
      }).eligible,
    ).toBe(true);
  });

  it('unlocks all roles at generic tier 3 while preserving placement, definition and prerequisite constraints', () => {
    const request = {
      definition: { ...forge, prerequisites: ['metalworking'] },
      center: { role: 'generic' as const, tier: 3 as const },
      placement: 'annex' as const,
      requestedTier: 3 as const,
      availablePrerequisites: [] as string[],
    };
    expect(evaluateBuildingEligibility(request)).toMatchObject({
      eligible: false,
      reason: 'prerequisites',
      missingPrerequisites: ['metalworking'],
    });
    expect(
      evaluateBuildingEligibility({ ...request, availablePrerequisites: ['metalworking'] })
        .eligible,
    ).toBe(true);
    expect(evaluateBuildingEligibility({ ...request, placement: 'center' }).reason).toBe(
      'placement',
    );
    expect(
      evaluateBuildingEligibility({ ...request, definition: { ...forge, maximumTier: 2 } }).reason,
    ).toBe('building-tier');
  });

  it('requires declared generic center tiers and rejects invalid specialized tier 3', () => {
    const request = {
      definition: { ...forge, minimumGenericCenterTier: 2 as const },
      center: { role: 'generic' as const, tier: 1 as const },
      placement: 'annex' as const,
      requestedTier: 1 as const,
      availablePrerequisites: [],
    };
    expect(evaluateBuildingEligibility(request)).toMatchObject({ eligible: false, maximumTier: 0 });
    expect(() =>
      evaluateBuildingEligibility({ ...request, center: { role: 'military', tier: 3 } }),
    ).toThrow('Specialized centers');
  });

  it('suppresses repaired annex effects under a ruined center without forcing repair order', () => {
    expect(
      isBuildingEffectActive({
        placement: 'annex',
        buildingOperational: true,
        centerOperational: false,
      }),
    ).toBe(false);
    expect(
      isBuildingEffectActive({
        placement: 'annex',
        buildingOperational: true,
        centerOperational: true,
      }),
    ).toBe(true);
    expect(
      isBuildingEffectActive({
        placement: 'annex',
        buildingOperational: false,
        centerOperational: true,
      }),
    ).toBe(false);
    expect(
      isBuildingEffectActive({
        placement: 'center',
        buildingOperational: true,
        centerOperational: false,
      }),
    ).toBe(true);
  });

  it('permits one exclusive choice alongside slotless unlocks, never two exclusive upgrades', () => {
    const choices = {
      maximumTier: 3 as const,
      tier: 2 as const,
      exclusiveOptions: ['lookout', 'comm-hub'],
      slotlessOptions: ['era-2'],
      exclusiveChoices: ['lookout'],
      unlocks: ['era-2'],
    };
    expect(validateBuildingUpgradeState(choices)).toEqual({ valid: true, errors: [] });
    expect(
      validateBuildingUpgradeState({ ...choices, exclusiveChoices: ['lookout', 'comm-hub'] }).valid,
    ).toBe(false);
    expect(validateBuildingUpgradeState({ ...choices, unlocks: ['era-2', 'era-2'] }).valid).toBe(
      false,
    );
    expect(validateBuildingUpgradeState({ ...choices, unlocks: ['unknown-era'] }).valid).toBe(
      false,
    );
    expect(isNextBuildingTier(1, 2)).toBe(true);
    expect(isNextBuildingTier(1, 3)).toBe(false);
    expect(isNextBuildingTier(2, 2)).toBe(false);
  });

  it('rejects unknown specialties and ambiguous exception configuration', () => {
    const request = {
      definition: forge,
      center: { role: 'generic' as const, tier: 2 as const },
      placement: 'annex' as const,
      requestedTier: 1 as const,
      availablePrerequisites: [],
    };
    expect(() =>
      evaluateBuildingEligibility({
        ...request,
        definition: { ...forge, specialty: 'unknown' as never },
      }),
    ).toThrow('Unknown');
    const exception = { centerRole: 'military' as const, maximumTier: 2 as const, enabled: true };
    expect(() =>
      evaluateBuildingEligibility({
        ...request,
        definition: { ...forge, specialtyExceptions: [exception, exception] },
      }),
    ).toThrow('Duplicate');
  });
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: foundation attribute pipeline', () => {
  it('adds flats, multiplies independent groups, then caps and rounds', () => {
    const result = evaluate([
      effect('building', 2),
      effect('weather', 1.5, { groupId: 'weather', units: 'factor' }),
    ]);
    expect(result).toMatchObject({ flatValue: 12, multiplier: 1.5, unroundedValue: 18, value: 18 });
    expect(
      evaluate(
        [effect('building', 2), effect('weather', 1.5, { groupId: 'weather', units: 'factor' })],
        [],
        { maximum: 16, rounding: 'floor' },
      ).value,
    ).toBe(16);
  });

  it('boosts Regional HQ contributions before best selection and never gives reachable Home precedence', () => {
    const result = evaluate(
      [],
      [
        hq('regional-a', 2),
        hq('regional-b', 2, {
          homeConnected: true,
          boost: { operation: 'add', value: 1, cap: null },
        }),
        hq('home', 1, { kind: 'home', homeConnected: true }),
      ],
      {},
      0,
    );
    expect(result.value).toBe(3);
    expect(result.selectedHq).toEqual({
      hqId: 'regional-b',
      sourceId: 'source-regional-b',
      originalValue: 2,
      boostedValue: 3,
    });
    expect(result.appliedSources).toEqual(['source-regional-b']);
    expect(result.excludedSources).toEqual([
      { sourceId: 'source-home', reason: 'competing-hq' },
      { sourceId: 'source-regional-a', reason: 'competing-hq' },
    ]);
  });

  it('selects different HQs per attribute calculation rather than binding all benefits to one provider', () => {
    const efficiency = evaluate([], [hq('a', 8), hq('b', 4)], {}, 0);
    const capacity = evaluate([], [hq('a', 4), hq('b', 8)], {}, 0);
    expect(efficiency.selectedHq?.hqId).toBe('a');
    expect(capacity.selectedHq?.hqId).toBe('b');
    expect(capacity.value).toBe(8);
  });

  it('removes the Home-connected boost on disconnection and respects each boost cap', () => {
    const regional = hq('regional', 60, {
      homeConnected: true,
      boost: { operation: 'multiply', value: 2, cap: 80 },
    });
    expect(evaluate([], [regional, hq('other', 70)], {}, 0).value).toBe(80);
    expect(
      evaluate([], [{ ...regional, homeConnected: false }, hq('other', 70)], {}, 0).value,
    ).toBe(70);
    expect(evaluate([], [{ ...regional, value: 80 }], {}, 0).value).toBe(80);
  });

  it('deduplicates the same active source reached by two paths and rejects contradictory copies', () => {
    const building = effect('building', 2);
    const result = evaluate([building, { ...building }]);
    expect(result.value).toBe(12);
    expect(result.deduplicatedSources).toEqual(['building']);
    expect(() => evaluate([building, { ...building, value: 3 }])).toThrow('Conflicting duplicate');
    expect(() => evaluate([effect('same', 1)], [hq('same', 1, { sourceId: 'same' })])).toThrow(
      'Conflicting duplicate',
    );
  });

  it('filters inactive/ineligible effects before deduplicating and leaves eligible local Base facts intact', () => {
    const result = evaluate(
      [
        effect('base', 3),
        effect('base', 99, { active: false }),
        effect('cut-network', 8, { eligible: false }),
      ],
      [],
      {},
      0,
    );
    expect(result.value).toBe(3);
    expect(result.appliedSources).toEqual(['base']);
    expect(result.excludedSources).toEqual([
      { sourceId: 'base', reason: 'inactive' },
      { sourceId: 'cut-network', reason: 'ineligible' },
    ]);
  });

  it('adds reinforcement-type flats while applying highest-only auras once', () => {
    const result = evaluate(
      [
        effect('barracks-a', 2),
        effect('barracks-b', 3),
        effect('armory-a', 4, { groupId: 'aura' }),
        effect('armory-b', 4, { groupId: 'aura' }),
        effect('weather-a', 1.5, { groupId: 'weather', units: 'factor' }),
        effect('weather-b', 0.8, { groupId: 'weather', units: 'factor' }),
        effect('gear-a', 1.1, { groupId: 'equipment', units: 'factor' }),
        effect('gear-b', 1.2, { groupId: 'equipment', units: 'factor' }),
      ],
      [],
      {},
      0,
    );
    expect(result.flatValue).toBe(9);
    expect(result.multiplier).toBe(1.44);
    expect(result.value).toBe(12.96);
    expect(result.groups.find((g) => g.id === 'aura')?.sourceIds).toEqual(['armory-a']);
  });

  it('produces identical arithmetic, ties and explanations under input reordering without mutation', () => {
    const effects = [effect('c', 0.1), effect('b', 0.2), effect('a', 0.7)];
    const candidates = [hq('z', 3), hq('a', 3)];
    const snapshot = JSON.stringify({ effects, candidates, definition });
    const first = evaluate(effects, candidates, {}, 0);
    expect(evaluate([...effects].reverse(), [...candidates].reverse(), {}, 0)).toEqual(first);
    expect(first.value).toBe(4);
    expect(first.selectedHq?.hqId).toBe('a');
    expect(JSON.stringify({ effects, candidates, definition })).toBe(snapshot);
  });

  it('retains fractional attribute output for the aggregate-income boundary', () => {
    expect(evaluate([effect('node', 3.8)], [], { rounding: 'aggregate-income' }, 0).value).toEqual({
      decimal: '3.8',
    });
    expect(evaluate([effect('node', 3.8)], [], { rounding: 'floor' }, 0).value).toBe(3);
    expect(evaluate([effect('node', 3.2)], [], { rounding: 'ceil' }, 0).value).toBe(4);
    expect(evaluate([effect('node', 3.5)], [], { rounding: 'nearest' }, 0).value).toBe(4);
    for (const [rounding, expected] of [
      ['none', '3.8'],
      ['aggregate-income', '3.8'],
      ['floor', '3'],
      ['ceil', '4'],
      ['nearest', '4'],
    ] as const) {
      expect(evaluate([effect('node', 3.8)], [], { rounding }, 0).exactValue).toEqual({
        decimal: expected,
      });
    }
  });

  it('accepts exact source/base tokens and deduplicates equal numeric and token sources', () => {
    const token = { decimal: '0.99999999999999996' };
    const result = evaluate(
      [effect('a', 0, { value: token }), effect('b', -0.25)],
      [],
      {},
      { decimal: '0.25' },
    );
    expect(result.value).toBe(1); // Display preview only.
    expect(result.exactValue).toEqual(token);
    expect(
      evaluate([effect('a', 0.5), effect('a', 0, { value: { decimal: '0.5' } })], [], {}, 0),
    ).toMatchObject({
      exactValue: { decimal: '0.5' },
      deduplicatedSources: ['a'],
    });
    expect(() =>
      evaluate([
        effect('factor', 0, { value: { decimal: '-0.1' }, groupId: 'weather', units: 'factor' }),
      ]),
    ).toThrow('non-negative');
    expect(() => evaluate([effect('invalid', 0, { value: { decimal: '1.0' } })])).toThrow(
      'canonical',
    );
  });

  it('compares exact HQ benefits before selection and applies boosts without numeric conversion', () => {
    const nearOne = { decimal: '0.99999999999999996' };
    const result = evaluate([], [hq('a', 0, { value: nearOne }), hq('z', 1)], {}, 0);
    expect(result.selectedHq?.hqId).toBe('z');
    const boosted = evaluate(
      [],
      [
        hq('regional', 0, {
          value: { decimal: '0.46' },
          homeConnected: true,
          boost: { operation: 'multiply', value: 1.25, cap: null },
        }),
      ],
      {},
      0,
    );
    expect(boosted.exactValue).toEqual({ decimal: '0.575' });
    expect(() => evaluate([], [hq('bad', 0, { value: { decimal: '-0.1' } })])).toThrow(
      'non-negative',
    );
    expect(() =>
      evaluate(
        [],
        [
          hq('bad', 0, {
            value: { decimal: '0.46' },
            boost: { operation: 'add', value: 1, cap: 0.45 },
          }),
        ],
      ),
    ).toThrow('below');
  });

  it('rejects missing/wrong units, unknown groups and non-finite configuration', () => {
    expect(() => evaluate([effect('a', 1, { units: 'CP' })])).toThrow('units');
    expect(() => evaluate([effect('a', 1, { targetId: 'wrong' })])).toThrow('target');
    expect(() => evaluate([effect('a', 1, { groupId: 'unknown' })])).toThrow('group');
    expect(() => evaluate([effect('a', Infinity)])).toThrow('finite');
    expect(() => evaluate([], [], { maximum: NaN })).toThrow('finite');
    expect(() => evaluate([], [], { minimum: 3, maximum: 2 })).toThrow('minimum');
    expect(() => evaluate([], [], { rounding: 'unknown' as never })).toThrow('rounding');
    expect(() => evaluate([effect('a', -1, { groupId: 'weather', units: 'factor' })])).toThrow(
      'non-negative',
    );
  });

  it('rejects HQ boost profiles that silently remove or fail to improve a positive benefit', () => {
    expect(() => evaluate([], [hq('a', 2, { homeConnected: true })])).toThrow('explicit boost');
    expect(() =>
      evaluate(
        [],
        [hq('a', 2, { homeConnected: true, boost: { operation: 'add', value: 0, cap: null } })],
      ),
    ).toThrow('improve');
    expect(() =>
      evaluate(
        [],
        [
          hq('a', 2, {
            homeConnected: true,
            boost: { operation: 'multiply', value: 1, cap: null },
          }),
        ],
      ),
    ).toThrow('improve');
    expect(() =>
      evaluate(
        [],
        [hq('a', 2, { homeConnected: true, boost: { operation: 'add', value: 1, cap: 1 } })],
      ),
    ).toThrow('below');
    expect(() => evaluate([], [hq('a', 2)], { hqGroupId: null })).toThrow('explicit HQ group');
  });

  it('rejects malformed configuration even when a source is temporarily inactive', () => {
    expect(() =>
      evaluate(
        [],
        [
          hq('a', 2, {
            active: false,
            boost: { operation: 'unknown' as never, value: 2, cap: null },
          }),
        ],
      ),
    ).toThrow('Unknown HQ boost');
    expect(() =>
      evaluate([effect('factor', -1, { active: false, groupId: 'weather', units: 'factor' })]),
    ).toThrow('non-negative');
  });

  it('does not hide overflow or use floating-point error as a reason to floor too early', () => {
    expect(
      evaluate([effect('a', 0.7), effect('b', 0.2), effect('c', 0.1)], [], { rounding: 'floor' }, 0)
        .value,
    ).toBe(1);
    expect(() =>
      evaluate([effect('factor', 1e308, { groupId: 'weather', units: 'factor' })], [], {}, 1e308),
    ).toThrow('finite');
  });
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: aggregate foundation income projection', () => {
  it('preserves weighted-route efficiency through HQ, building income and JSON reload', () => {
    const cost = addFoundationAmounts(4, 5);
    const efficiency = maxFoundationAmounts(
      0.3,
      subtractFoundationAmounts(1, multiplyFoundationAmounts(0.06, cost)),
    );
    expect(efficiency).toEqual({ decimal: '0.46' });
    const hqBenefit = evaluate([], [hq('home', 0, { kind: 'home', value: efficiency })], {}, 0);
    expect(hqBenefit.exactValue).toEqual({ decimal: '0.46' });
    const building = evaluate(
      [effect('supply', 0, { value: hqBenefit.exactValue, groupId: 'weather', units: 'factor' })],
      [],
      { rounding: 'aggregate-income' },
      100,
    );
    const restored = JSON.parse(
      JSON.stringify({
        baseGrant: 3,
        contributions: [income('building', 0, { value: building.value })],
      }),
    );
    expect(calculateFoundationIncome(restored)).toMatchObject({
      cp: 49,
      exactTotal: { decimal: '49' },
    });
  });

  it('provides canonical signed arithmetic without tolerances or numeric round trips', () => {
    expect(foundationExactAmount(1e-7)).toEqual({ decimal: '0.0000001' });
    expect(addFoundationAmounts(0.1, 0.2)).toEqual({ decimal: '0.3' });
    expect(subtractFoundationAmounts(0.5, 0.75)).toEqual({ decimal: '-0.25' });
    expect(multiplyFoundationAmounts({ decimal: '-0.25' }, 2)).toEqual({ decimal: '-0.5' });
    expect(powerFoundationAmount(0.5, 2)).toEqual({ decimal: '0.25' });
    expect(powerFoundationAmount(0.5, 0)).toEqual({ decimal: '1' });
    expect(compareFoundationAmounts({ decimal: '0.99999999999999996' }, 1)).toBe(-1);
    expect(compareFoundationAmounts(0.5, { decimal: '0.5' })).toBe(0);
    expect(maxFoundationAmounts({ decimal: '-0.1' }, -1)).toEqual({ decimal: '-0.1' });
    expect(foundationAmountNumber({ decimal: '0.99999999999999996' })).toBe(1);
    expect(() => powerFoundationAmount(0.5, -1)).toThrow('exponent');
    expect(() => powerFoundationAmount(0.5, 1.5)).toThrow('exponent');
    expect(() => multiplyFoundationAmounts(1e308, 10)).toThrow('finite');
    expect(() => foundationExactAmount(Infinity)).toThrow('finite');
    const mutable = { decimal: '0.5' };
    expect(addFoundationAmounts(mutable, 1)).toEqual({ decimal: '1.5' });
    mutable.decimal = '1.0';
    expect(() => addFoundationAmounts(mutable, 1)).toThrow('canonical');
    mutable.decimal = '0.6';
    expect(addFoundationAmounts(mutable, 1)).toEqual({ decimal: '1.6' });
    Object.assign(mutable, { extra: 1 });
    expect(() => addFoundationAmounts(mutable, 1)).toThrow('exact amount');
  });

  it('retains the explicit base grant and floors the complete modified payment once', () => {
    const result = calculateFoundationIncome({
      baseGrant: 3,
      contributions: [income('territory', 6.6, { kind: 'territory' }), income('node', 3.8)],
    });
    expect(result).toEqual({
      cp: 13,
      unroundedTotal: 13.4,
      exactTotal: { decimal: '13.4' },
      discardedFraction: 0.4,
      exactDiscardedFraction: { decimal: '0.4' },
      appliedSources: ['node', 'territory'],
    });
  });

  it('combines fractional contributions rather than flooring each source', () => {
    expect(
      calculateFoundationIncome({
        baseGrant: 0,
        contributions: [income('a', 0.6), income('b', 0.6)],
      }).cp,
    ).toBe(1);
    expect(
      calculateFoundationIncome({
        baseGrant: 0,
        contributions: [income('a', 0.7), income('b', 0.2), income('c', 0.1)],
      }).cp,
    ).toBe(1);
    expect(
      calculateFoundationIncome({ baseGrant: 0, contributions: [income('a', 0.999999999999999)] })
        .cp,
    ).toBe(0);
  });

  it('preserves exact attribute amounts through the public income API and JSON reload', () => {
    const attribute = evaluate(
      [effect('large', 0.9999999999999999), effect('small', 0.00000000000000006)],
      [],
      { rounding: 'aggregate-income' },
      0,
    );
    // This numeric preview rounds to 1; using it for income would pay a CP too early.
    expect(attribute.unroundedValue).toBe(1);
    expect(attribute.value).toEqual({ decimal: '0.99999999999999996' });
    const direct = calculateFoundationIncome({
      baseGrant: 0,
      contributions: [income('large', 0.9999999999999999), income('small', 0.00000000000000006)],
    });
    const saved = JSON.stringify({
      baseGrant: 0,
      contributions: [income('evaluated', 0, { value: attribute.value })],
    });
    const restored = calculateFoundationIncome(JSON.parse(saved));
    expect(restored.cp).toBe(0);
    expect(restored.cp).toBe(direct.cp);
    expect(restored.exactTotal).toEqual(direct.exactTotal);
    expect(restored.exactDiscardedFraction).toEqual({ decimal: '0.99999999999999996' });
    expect(JSON.stringify(restored)).toContain('0.99999999999999996');
  });

  it('rejects malformed, noncanonical and inconsistent exact tokens without guessing', () => {
    for (const token of [
      { decimal: '01' },
      { decimal: '1.0' },
      { decimal: '-0' },
      { decimal: '1e0' },
      { decimal: '.5' },
      { decimal: 'NaN' },
      { decimal: 1 },
      { decimal: '1', value: 2 },
      { value: 1 },
      null,
    ]) {
      expect(() =>
        calculateFoundationIncome({
          baseGrant: 0,
          contributions: [income('invalid', 0, { value: token as never })],
        }),
      ).toThrow(/exact amount/);
    }
    expect(() =>
      calculateFoundationIncome({
        baseGrant: 0,
        contributions: [income('negative', 0, { value: { decimal: '-0.1' } })],
      }),
    ).toThrow('non-negative');
    expect(() =>
      calculateFoundationIncome({
        baseGrant: 0,
        contributions: [
          income('same', 0, { value: { decimal: '0.99999999999999996' } }),
          income('same', 1),
        ],
      }),
    ).toThrow('Conflicting duplicate');
    expect(
      calculateFoundationIncome({
        baseGrant: 0,
        contributions: [income('same', 0.5), income('same', 0, { value: { decimal: '0.5' } })],
      }).cp,
    ).toBe(0);
  });

  it('keeps the base grant with no network income and deduplicates an eligible source', () => {
    const node = income('node', 2);
    expect(
      calculateFoundationIncome({
        baseGrant: 3,
        contributions: [income('cut-node', 100, { eligible: false })],
      }).cp,
    ).toBe(3);
    expect(calculateFoundationIncome({ baseGrant: 3, contributions: [node, { ...node }] }).cp).toBe(
      5,
    );
  });

  it('is a repeatable projection and neither mutates input nor carries a fractional remainder', () => {
    const input = { baseGrant: 3, contributions: [income('node', 0.6)] };
    const snapshot = JSON.stringify(input);
    expect(calculateFoundationIncome(input)).toEqual(calculateFoundationIncome(input));
    expect(calculateFoundationIncome(input).cp).toBe(3);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('rejects invalid or conflicting source data without producing a guessed payment', () => {
    expect(() => calculateFoundationIncome({ baseGrant: NaN, contributions: [] })).toThrow(
      'finite',
    );
    expect(() =>
      calculateFoundationIncome({ baseGrant: 3, contributions: [income('a', -1)] }),
    ).toThrow('non-negative');
    expect(() =>
      calculateFoundationIncome({ baseGrant: 3, contributions: [income('a', 1), income('a', 2)] }),
    ).toThrow('Conflicting');
    expect(() => calculateFoundationIncome({ baseGrant: 1e30, contributions: [] })).toThrow(
      'safe integer',
    );
  });
});

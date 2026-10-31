import type { CampaignConfiguration, CampaignBuildingEffects } from './campaign.ts';
import type { CampaignNodeDefinition } from './campaignNodes.ts';
import type { BuildingSpecialty, BuildingTier } from './attributes.ts';
import { validateFoundationCaptureCosts } from './capture.ts';

/**
 * Explicit review ruleset, selected by the player. None of this tuning is a production default.
 * Takeover prices remain required inputs; callers must not silently supply the suggested 25/10.
 */
export function createFoundationPlaytestConfiguration(
  capture: number,
  raze: number,
): CampaignConfiguration {
  const problem = validateFoundationCaptureCosts({ capture, raze });
  if (problem) throw new Error(problem);
  function definition(
    id: string,
    name: string,
    specialty: BuildingSpecialty,
    center: boolean,
    maximumTier: BuildingTier,
  ): CampaignNodeDefinition {
    return {
      id,
      name,
      role: id,
      specialty,
      centerEligible: center,
      annexEligible: !center,
      minimumGenericCenterTier: 1,
      maximumTier,
      prerequisites: [],
      specialtyExceptions: [],
      engineerRequired: center,
      costs: {
        build: { 1: 3, 2: 6, 3: 9 },
        upgrade: { 2: 5, 3: 10 },
        repair: { 1: 2, 2: 4, 3: 6 },
      },
      exclusiveUpgrades: [],
      slotlessUnlocks: [],
    };
  }
  const definitions = [
    definition('generic', 'Town center', 'generic', true, 3),
    definition('industrial', 'Industrial center', 'industrial', true, 2),
    definition('military', 'Military center', 'military', true, 2),
    definition('medical', 'Medical center', 'medical', true, 2),
    definition('logistics', 'Logistics center', 'logistics', true, 2),
    definition('workshop', 'Workshop', 'industrial', false, 3),
    definition('barracks', 'Barracks', 'military', false, 3),
    definition('relay', 'Supply relay', 'logistics', false, 3),
    definition('tower', 'Watchtower', 'military', false, 3),
  ];
  const effects = Object.fromEntries(
    definitions.map((d) => [
      d.id,
      Object.fromEntries(
        Array.from({ length: d.maximumTier }, (_, index) => {
          const tier = index + 1;
          const value: CampaignBuildingEffects = {
            income: d.centerEligible || d.id === 'workshop' ? tier : 0,
            housing: d.centerEligible ? 12 : d.id === 'barracks' ? 4 * tier : 0,
            throughput: d.centerEligible || d.id === 'barracks' || d.id === 'tower' ? tier : 0,
            recruitment: d.centerEligible || d.id === 'barracks',
            relayRangeBonus: d.id === 'relay' ? tier * 4 : 0,
            reinforcement: d.centerEligible ? 10 + (tier - 1) * 4 : 0,
          };
          return [tier, value];
        }),
      ),
    ]),
  );
  return {
    id: 'foundation-playtest',
    name: 'Strategic infrastructure playtest',
    tuningStatus: 'playtest',
    nodes: {
      id: 'foundation-playtest-nodes',
      activationCp: 5,
      captureCosts: { capture, raze },
      initialGenericCenterDefinitionId: 'generic',
      homeCenterDefinitionId: 'generic',
      homeCenterTier: 1,
      activationCenterDefinitionIds: ['generic', 'industrial', 'military', 'medical', 'logistics'],
      definitions,
    },
    supply: {
      terrainCosts: { land: 1, marsh: 2 },
      minimumStepCost: 0.25,
      uphillSurcharge: 1,
      downhillCredit: 0.75,
      maximumClimb: 2,
      maximumDrop: 2,
      roadMultiplier: 0.75,
      legRange: 12,
      distanceFloor: 0.3,
      distanceDecay: 0.06,
      hostileClaimFactor: 0.5,
    },
    benefits: [
      {
        id: 'income-factor',
        units: 'factor',
        homeConnectedBoost: { operation: 'multiply', value: 1.25, cap: null },
        maximum: null,
        applyRouteEfficiency: true,
        isolatedRegionalFactor: 0.5,
        rounding: 'none',
      },
      {
        id: 'reinforcement',
        units: 'units',
        homeConnectedBoost: { operation: 'multiply', value: 1.25, cap: null },
        maximum: null,
        applyRouteEfficiency: false,
        isolatedRegionalFactor: 1,
        rounding: 'floor',
      },
    ],
    effects,
    throughputHomeMultiplier: 2,
    throughputRegionalMultiplier: 1,
    roadRepairCp: 2,
  };
}

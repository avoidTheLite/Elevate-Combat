import {
  applyFoundationWork,
  calculateFoundationIncome,
  evaluateBuildingEligibility,
  evaluateFoundationAttribute,
  evaluateFoundationWork,
} from '../src/index.ts';
import type { FoundationWorkContext, FoundationWorkState } from '../src/index.ts';

// Synthetic fixture configuration; these costs and outputs are not production defaults.
const context: FoundationWorkContext = {
  ownerTurn: { team: 'A', id: 'A-cycle-1' },
  nodes: [{ id: 'outpost', mainHex: '0,0', owner: 'A' }],
  targets: [
    { id: 'forge', kind: 'build', nodeId: 'outpost', cpCost: 3, engineerRequired: false },
    { id: 'annex', kind: 'build', nodeId: 'outpost', cpCost: 3, engineerRequired: false },
    { id: 'third', kind: 'build', nodeId: 'outpost', cpCost: 3, engineerRequired: false },
    { id: 'road', kind: 'repair-road', mainHex: '0,0', cpCost: 2 },
  ],
  holders: [
    {
      id: 'commander',
      team: 'A',
      kind: 'commander',
      at: '0,0',
      units: [
        { id: 'engineer-1', typeId: 'ww2_engineer', label: 'Engineer 1', hp: 10 },
        { id: 'engineer-2', typeId: 'ww2_engineer', label: 'Engineer 2', hp: 10 },
      ],
    },
  ],
};
const initial: FoundationWorkState = {
  version: 0,
  commandPoints: { A: 30, B: 30 },
  nodeSpending: [],
  engineerSpending: [],
  receipts: [],
};
const first = applyFoundationWork(
  initial,
  {
    requestId: 'build-forge',
    expectedVersion: 0,
    ownerTurnId: 'A-cycle-1',
    team: 'A',
    kind: 'build',
    targetId: 'forge',
    engineerUnitId: null,
  },
  context,
);
if (!first.ok) throw new Error(first.reason);
const second = applyFoundationWork(
  first.state,
  {
    requestId: 'build-annex',
    expectedVersion: 1,
    ownerTurnId: 'A-cycle-1',
    team: 'A',
    kind: 'build',
    targetId: 'annex',
    engineerUnitId: 'engineer-1',
  },
  context,
);
if (!second.ok) throw new Error(second.reason);
const third = evaluateFoundationWork(
  second.state,
  {
    requestId: 'third-build',
    expectedVersion: 2,
    ownerTurnId: 'A-cycle-1',
    team: 'A',
    kind: 'build',
    targetId: 'third',
    engineerUnitId: 'engineer-2',
  },
  context,
);
const road = evaluateFoundationWork(
  second.state,
  {
    requestId: 'repair-road',
    expectedVersion: 2,
    ownerTurnId: 'A-cycle-1',
    team: 'A',
    kind: 'repair-road',
    targetId: 'road',
    engineerUnitId: 'engineer-2',
  },
  context,
);
const eligibility = evaluateBuildingEligibility({
  definition: {
    role: 'forge',
    specialty: 'industrial',
    centerEligible: false,
    annexEligible: true,
    minimumGenericCenterTier: 1,
    maximumTier: 3,
    prerequisites: [],
    specialtyExceptions: [],
  },
  center: { role: 'industrial', tier: 1 },
  placement: 'annex',
  requestedTier: 2,
  availablePrerequisites: [],
});
const attribute = evaluateFoundationAttribute({
  definition: {
    id: 'throughput',
    units: 'units',
    groups: [
      { id: 'building-flat', phase: 'flat', combine: 'additive' },
      { id: 'modifier', phase: 'multiplier', combine: 'multiplicative' },
    ],
    hqGroupId: null,
    minimum: null,
    maximum: null,
    rounding: 'none',
  },
  targetId: 'outpost',
  baseValue: 10,
  contributions: [
    {
      sourceId: 'forge',
      attributeId: 'throughput',
      targetId: 'outpost',
      units: 'units',
      active: true,
      eligible: true,
      value: 2,
      groupId: 'building-flat',
    },
    {
      sourceId: 'modifier-fixture',
      attributeId: 'throughput',
      targetId: 'outpost',
      units: 'factor',
      active: true,
      eligible: true,
      value: 1.5,
      groupId: 'modifier',
    },
  ],
  hqContributions: [],
});
const income = calculateFoundationIncome({
  baseGrant: 3,
  contributions: [
    { sourceId: 'territory-fixture', kind: 'territory', value: 6.6, active: true, eligible: true },
    { sourceId: 'building-fixture', kind: 'building', value: 3.8, active: true, eligible: true },
  ],
});
console.log(
  JSON.stringify(
    {
      scope: 'Engine primitives with synthetic inputs; game-flow integration pending',
      industrialTier1AllowsForgeTier2: eligibility.eligible,
      completedNodeOperations: second.state.nodeSpending[0]?.operationCount,
      cpAfterTwoBuilds: second.state.commandPoints.A,
      thirdBuild: third.ok ? 'allowed' : third.code,
      anotherEngineerCanRepairRoad: road.ok,
      modifiedThroughput: attribute.value,
      projectedIncome: income.cp,
      paymentIssued: false,
    },
    null,
    2,
  ),
);

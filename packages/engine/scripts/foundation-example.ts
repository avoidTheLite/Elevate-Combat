import {
  applyFoundationWork,
  applyReinforcementSpend,
  calculateFoundationIncome,
  createReinforcementState,
  evaluateBuildingEligibility,
  evaluateFoundationAttribute,
  evaluateFoundationWork,
  openReinforcementCycle,
  reinforcementAllowance,
} from '../src/index.ts';
import type {
  FoundationWorkContext,
  FoundationWorkState,
  ReinforcementContext,
  ReinforcementState,
} from '../src/index.ts';

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
const opened = openReinforcementCycle(createReinforcementState(), {
  expectedVersion: 0,
  team: 'A',
  ownerTurnId: 'A-cycle-1',
  grants: [{ lineageId: 'original-network', capacity: 10 }],
});
if (!opened.ok) throw new Error(opened.reason);
function networkFacts(
  state: ReinforcementState,
  networks: ReinforcementContext['networks'],
  cycle = 'A-cycle-1',
): ReinforcementContext {
  return {
    snapshotVersion: state.version,
    ownerTurn: { team: 'A', id: cycle },
    networks,
  };
}
const spentSix = applyReinforcementSpend(
  opened.state,
  {
    requestId: 'initial-six',
    expectedVersion: opened.state.version,
    team: 'A',
    ownerTurnId: 'A-cycle-1',
    networkId: 'connected-network',
    units: 6,
  },
  networkFacts(opened.state, [
    { networkId: 'connected-network', lineageId: 'original-network', currentRemaining: 10 },
  ]),
);
if (!spentSix.ok) throw new Error(spentSix.reason);
const children = [
  { networkId: 'left-child', lineageId: 'original-network', currentRemaining: 10 },
  { networkId: 'right-child', lineageId: 'original-network', currentRemaining: 10 },
];
function available(
  state: ReinforcementState,
  facts: ReinforcementContext,
  networkId: string,
): number {
  const result = reinforcementAllowance(state, facts, networkId);
  if (!result.ok) throw new Error(result.reason);
  return result.available;
}
const beforeChildSpend = children.map((n) =>
  available(spentSix.state, networkFacts(spentSix.state, children), n.networkId),
);
const childSpend = applyReinforcementSpend(
  spentSix.state,
  {
    requestId: 'left-child-three',
    expectedVersion: spentSix.state.version,
    team: 'A',
    ownerTurnId: 'A-cycle-1',
    networkId: 'left-child',
    units: 3,
  },
  networkFacts(spentSix.state, children),
);
if (!childSpend.ok) throw new Error(childSpend.reason);
const refreshedChildren = children.map((n) =>
  n.networkId === 'left-child'
    ? { ...n, currentRemaining: childSpend.receipt.networkRemainingAfter }
    : n,
);
const afterChildSpend = children.map((n) =>
  available(childSpend.state, networkFacts(childSpend.state, refreshedChildren), n.networkId),
);
const reconnect = networkFacts(childSpend.state, [
  { networkId: 'reconnected', lineageId: 'original-network', currentRemaining: 14 },
]);
const midCycleIncrease = openReinforcementCycle(childSpend.state, {
  expectedVersion: childSpend.state.version,
  team: 'A',
  ownerTurnId: 'A-cycle-1',
  grants: [{ lineageId: 'original-network', capacity: 14 }],
});
const nextCycle = openReinforcementCycle(childSpend.state, {
  expectedVersion: childSpend.state.version,
  team: 'A',
  ownerTurnId: 'A-cycle-2',
  grants: [{ lineageId: 'original-network', capacity: 14 }],
});
if (!nextCycle.ok) throw new Error(nextCycle.reason);
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
      reinforcement: {
        openingBudget: 10,
        initialSpend: 6,
        childrenShareRemainingBefore: beforeChildSpend,
        childrenShareRemainingAfterOneSpendsThree: afterChildSpend,
        reconnectedWithHigherCurrentLimit: available(childSpend.state, reconnect, 'reconnected'),
        midCycleBudgetIncrease: midCycleIncrease.ok ? 'allowed' : midCycleIncrease.code,
        nextExplicitOwnerCycleAllowance: available(
          nextCycle.state,
          networkFacts(
            nextCycle.state,
            [{ networkId: 'reconnected', lineageId: 'original-network', currentRemaining: 14 }],
            'A-cycle-2',
          ),
          'reconnected',
        ),
      },
    },
    null,
    2,
  ),
);

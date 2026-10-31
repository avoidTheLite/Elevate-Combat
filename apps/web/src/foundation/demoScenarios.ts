import {
  apply,
  campaignBuildingData,
  campaignNodeActionChoices,
  commanderReach,
  constructCampaignNodeRequest,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  deserializeSave,
  hexDistance,
  parseKey,
  refreshCampaignNodeSnapshot,
  serializeSave,
  setHolderPos,
  syncCampaignClaims,
  validateGameState,
  worldOf,
  COMMAND,
} from '@iron-ridge/engine';
import type { Army, CampaignNodeSite, Era, GameAction, GameState, Team } from '@iron-ridge/engine';

export type FoundationDemoScenarioId = 'capture-start' | 'capture-move' | 'annex-raid';
export type FoundationDemoSelection = 'standard' | FoundationDemoScenarioId;

export const FOUNDATION_DEMO_SCENARIOS: {
  value: FoundationDemoSelection;
  label: string;
  description: string;
}[] = [
  {
    value: 'standard',
    label: 'STANDARD CAMPAIGN',
    description: 'Start normally using your selected map and opponent settings.',
  },
  {
    value: 'capture-start',
    label: 'TURN-START CAPTURE',
    description: 'Choose independently for three enemy outposts after actual turn-start income.',
  },
  {
    value: 'capture-move',
    label: 'CAPTURE AFTER MOVEMENT',
    description: 'Move a commander onto an empty enemy node center, then choose its outcome.',
  },
  {
    value: 'annex-raid',
    label: 'ANNEX RAID',
    description:
      'Raze an enemy Workshop using tactical ACT, then finish the battle and inspect it.',
  },
];

const DEMO_PREFIX = 'prepared-foundation-';

export function foundationDemoScenarioId(state: GameState): FoundationDemoScenarioId | null {
  const id = state.settings.infrastructure?.id;
  return (
    (FOUNDATION_DEMO_SCENARIOS.find(
      (scenario) => scenario.value !== 'standard' && id === `${DEMO_PREFIX}${scenario.value}`,
    )?.value as FoundationDemoScenarioId | undefined) ?? null
  );
}

function commander(state: GameState, team: Team): Army {
  const holder = state.armies.find((army) => army.team === team && army.kind === 'commander');
  if (!holder) throw new Error(`Prepared demo requires a ${team} commander`);
  return holder;
}

function step(state: GameState, action: GameAction): GameState {
  const result = apply(state, action);
  if (result.error) throw new Error(`Prepared demo ${action.type}: ${result.error}`);
  const errors = validateGameState(result.state);
  if (errors.length) throw new Error(`Prepared demo ${action.type}: ${errors.join('; ')}`);
  return result.state;
}

/** Explicit scenario positions, not earned movement or an alternate gameplay action. */
function position(state: GameState, holder: Army, subHex: string): void {
  setHolderPos(worldOf(state).world, holder, subHex);
  syncCampaignClaims(state);
  refreshCampaignNodeSnapshot(state);
}

function freeCell(state: GameState, cells: readonly string[], exceptHolderId?: string): string {
  const key = cells.find(
    (cell) => !state.armies.some((army) => army.id !== exceptHolderId && army.pos === cell),
  );
  if (!key) throw new Error('Prepared demo has no free holder position');
  return key;
}

function middleSites(state: GameState): CampaignNodeSite[] {
  const { world } = worldOf(state);
  return state
    .infrastructure!.sites.filter((site) => world.mainByKey.get(site.mainHex)!.col === 1)
    .sort((a, b) => world.mainByKey.get(a.mainHex)!.row - world.mainByKey.get(b.mainHex)!.row);
}

function prepareEnemySites(state: GameState, sites: CampaignNodeSite[]): GameState {
  for (const site of sites) {
    position(state, commander(state, 'B'), freeCell(state, site.annexSubHexes));
    state = step(state, { type: 'endTurn' });
    state = step(state, {
      type: 'nodeWork',
      request: constructCampaignNodeRequest(state, {
        kind: 'activate',
        nodeId: site.nodeId,
        commanderId: commander(state, 'B').id,
        centerDefinitionId: 'generic',
      }),
    });
    const home = worldOf(state).world.mainByKey.get(state.hq.B)!;
    const b = commander(state, 'B');
    position(state, b, freeCell(state, home.subKeys, b.id));
    state = step(state, { type: 'endTurn' });
  }
  return state;
}

function captureStart(state: GameState): GameState {
  const sites = middleSites(state);
  state = prepareEnemySites(state, sites);
  // Split the actual starting army using normal unit-holder actions; no troops or CP are minted.
  for (let index = 0; index < 2; index++) {
    const source = commander(state, 'A');
    state = step(state, {
      type: 'formCommander',
      fromId: source.id,
      unitIds: [source.units[0].id],
    });
  }
  const holders = state.armies.filter((army) => army.team === 'A' && army.kind === 'commander');
  for (let index = 0; index < sites.length; index++)
    position(state, holders[index], freeCell(state, sites[index].annexSubHexes));
  state = step(state, { type: 'endTurn' });
  state = step(state, { type: 'endTurn' });
  if (
    state.infrastructure?.capture.pending?.event.kind !== 'turn-start-after-income' ||
    state.infrastructure.capture.pending.candidates.length !== 3
  )
    throw new Error('Prepared demo did not open three actual turn-start choices');
  return state;
}

function captureMove(state: GameState): GameState {
  const site = middleSites(state)[1];
  state = prepareEnemySites(state, [site]);
  if (!commanderReach(state, commander(state, 'A')).has(site.centerSubHex))
    throw new Error('Prepared demo node center is outside actual commander reach');
  return state;
}

function annexRaid(state: GameState): GameState {
  const site = middleSites(state)[1];
  state = prepareEnemySites(state, [site]);
  state = step(state, { type: 'endTurn' });
  const build = campaignNodeActionChoices(state, site.nodeId).find(
    (choice) =>
      choice.legal && choice.request.kind === 'build' && choice.request.definitionId === 'workshop',
  );
  if (!build) throw new Error('Prepared demo Workshop cannot be legally built');
  state = step(state, { type: 'nodeWork', request: build.request });
  state = step(state, { type: 'endTurn' });
  const node = state.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!;
  const workshop = node.buildings.find(
    (building) => campaignBuildingData(building).definitionId === 'workshop',
  )!;
  const workshopCell = campaignBuildingData(workshop).subHex;
  const defender = commander(state, 'B');
  position(
    state,
    defender,
    freeCell(
      state,
      site.annexSubHexes.filter((cell) => cell !== workshopCell),
    ),
  );
  const { world } = worldOf(state);
  const attacker = commander(state, 'A');
  const near = world.subs
    .filter(
      (cell) =>
        cell.main !== site.mainHex &&
        hexDistance(cell.hex, parseKey(defender.pos)) <=
          COMMAND.engageRange(state.settings.grid.subRadius),
    )
    .sort(
      (a, b) =>
        hexDistance(a.hex, parseKey(defender.pos)) - hexDistance(b.hex, parseKey(defender.pos)) ||
        a.key.localeCompare(b.key),
    );
  position(
    state,
    attacker,
    freeCell(
      state,
      near.map((cell) => cell.key),
      attacker.id,
    ),
  );
  state = step(state, { type: 'engage', armyId: attacker.id, targetId: defender.id });
  state = step(state, { type: 'startBattle' });
  state = step(state, { type: 'finishDeploy' });
  state = step(state, { type: 'finishDeploy' });
  const battle = state.battle!;
  const alpha = battle.units.filter((unit) => unit.team === 'A');
  alpha[0].pos = workshopCell;
  alpha[1].pos = site.centerSubHex;
  const reserved = new Set([workshopCell, site.centerSubHex]);
  const remaining = battle.mains
    .flatMap((main) => world.mainByKey.get(main)!.subKeys)
    .filter((cell) => !reserved.has(cell))
    .sort(
      (a, b) =>
        hexDistance(parseKey(b), parseKey(site.centerSubHex)) -
          hexDistance(parseKey(a), parseKey(site.centerSubHex)) || a.localeCompare(b),
    );
  for (const unit of battle.units) {
    if (unit.id === alpha[0].id || unit.id === alpha[1].id) continue;
    unit.pos = remaining.shift()!;
  }
  battle.log.push({
    round: battle.round,
    team: 'A',
    kind: 'info',
    text: 'Prepared demo positions: Alpha holds the center and stands on the enemy Workshop. No combat result has been awarded.',
  });
  refreshCampaignNodeSnapshot(state);
  return state;
}

/**
 * Reproducible review assets. Infrastructure was activated/built and income paid by actual
 * commands; only explicitly labelled holder/deployment positions are prepared. CP is never minted.
 */
export function createFoundationDemoScenario(
  id: FoundationDemoScenarioId,
  capture: number,
  raze: number,
  era: Era = 'ww2',
  commanderTrainingCp?: number,
): GameState {
  const configuration = createFoundationPlaytestConfiguration(capture, raze);
  const label = FOUNDATION_DEMO_SCENARIOS.find((scenario) => scenario.value === id)!.label;
  let state = createGame({
    ...defaultSettings(),
    era,
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    seed: 1,
    fog: false,
    controllers: { A: 'human', B: 'human' },
    infrastructure: {
      ...configuration,
      id: `${DEMO_PREFIX}${id}`,
      name: `Prepared demo: ${label}`,
    },
  });
  state =
    id === 'capture-start'
      ? captureStart(state)
      : id === 'capture-move'
        ? captureMove(state)
        : annexRaid(state);
  if (commanderTrainingCp !== undefined) state.settings.commanderTrainingCp = commanderTrainingCp;
  const errors = validateGameState(state);
  if (errors.length) throw new Error(`Prepared demo: ${errors.join('; ')}`);
  const loaded = deserializeSave(serializeSave(state, `Prepared demo: ${label}`));
  if (!loaded.ok) throw new Error(`Prepared demo save: ${loaded.error}`);
  return loaded.save.state;
}

/** Selection only: all subsequent gameplay still runs through normal store commands. */
export function foundationDemoFocus(state: GameState): {
  selectedMain: string | null;
  selectedArmy: string | null;
  selectedUnit: string | null;
} {
  const id = foundationDemoScenarioId(state);
  const site = id ? middleSites(state)[1] : null;
  const workshop = state.infrastructure?.capture.nodes
    .find((node) => node.id === site?.nodeId)
    ?.buildings.find((building) => campaignBuildingData(building).definitionId === 'workshop');
  return {
    selectedMain: site?.mainHex ?? null,
    selectedArmy:
      id === 'capture-move'
        ? (state.armies.find((army) => army.team === 'A' && army.kind === 'commander')?.id ?? null)
        : null,
    selectedUnit:
      id === 'annex-raid' && workshop
        ? (state.battle?.units.find(
            (unit) => unit.team === 'A' && unit.pos === campaignBuildingData(workshop).subHex,
          )?.id ?? null)
        : null,
  };
}

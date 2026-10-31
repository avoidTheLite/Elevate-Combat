// ── Single entry point: apply(state, action) → new state ─────────────────────
// State is treated immutably at this boundary (structuredClone), which keeps the
// UI store, the AI and the tests all going through the same code path.

import type { HexKey } from './hex.ts';
import type { AttackOutcome } from './combat.ts';
import { createRng } from './rng.ts';
import {
  autoResolve,
  cancelPendingBattle,
  concludeBattle,
  endStrategicTurn,
  fortify,
  recruit,
  startPendingBattle,
  continueFoundationResolution,
  afterFoundationMovement,
  checkCampaignVictory,
} from './strategic.ts';
import {
  attack,
  autoDeploy,
  contextFor,
  deployUnit,
  digIn,
  endTurn,
  finishDeployment,
  moveUnit,
  packUp,
  placeWarnedFort,
  retreat,
  rotateUnit,
  secureObjective,
  extractFromBattle,
  setUp,
} from './tactical.ts';
import {
  configureCommanderTraining,
  engage,
  formCommander,
  moveArmy,
  moveCommander,
  transferUnits,
} from './command.ts';
import type { GameState } from './types.ts';
import { withRules } from './rules.ts';
import type { CampaignNodeAction } from './foundation/campaignNodes.ts';
import {
  applyCampaignNodeAction,
  chooseCampaignCapture,
  commitCampaignCapture,
  refreshCampaignNodeSnapshot,
} from './foundation/campaignNodes.ts';
import type { FoundationCaptureOutcome } from './foundation/capture.ts';
import {
  foundationHasPending,
  syncCampaignClaims,
  refreshCampaignNetworks,
} from './foundation/campaign.ts';
import {
  beginCampaignFreeShots,
  toggleCampaignStationing,
  commitCampaignStationing,
  selectCampaignFreeShotTarget,
  resolveCampaignFreeShot,
} from './foundation/campaignGarrisons.ts';
import { buildWorld } from './grid.ts';
import { applyCampaignRoadRepair } from './foundation/campaignRoads.ts';
import type { CampaignRoadRepairRequest } from './foundation/campaignRoads.ts';
import { applyCampaignRazeTile } from './foundation/campaignRaze.ts';

export type GameAction =
  | { type: 'moveCommander'; armyId: string; dest: HexKey }
  | { type: 'engage'; armyId: string; targetId: string }
  | { type: 'transferUnits'; fromId: string; toId: string; unitIds: string[] }
  | { type: 'formCommander'; fromId: string; unitIds: string[] }
  | { type: 'configureCommanderTraining'; cpCost: number }
  /** V0.9 adapter: `dest` is a main hex (engage there, or step into it). */
  | { type: 'moveArmy'; armyId: string; dest: HexKey }
  | { type: 'recruit'; typeId: string; nodeId?: string }
  | { type: 'nodeWork'; request: CampaignNodeAction }
  | { type: 'repairRoad'; request: CampaignRoadRepairRequest }
  | { type: 'captureChoice'; nodeId: string; outcome: FoundationCaptureOutcome }
  | { type: 'captureCommit' }
  | { type: 'stationingToggle'; unitId: string }
  | { type: 'stationingCommit' }
  | { type: 'freeShotTarget'; targetId: string }
  | { type: 'freeShotResolve' }
  | { type: 'razeTile'; unitId: string; buildingId: string }
  | { type: 'fortify'; hex: HexKey }
  | { type: 'endTurn' }
  | { type: 'startBattle' }
  | { type: 'autoResolve' }
  | { type: 'cancelBattle' }
  | { type: 'deploy'; unitId: string; cell: HexKey | null }
  | { type: 'placeFort'; cell: HexKey }
  | { type: 'autoDeploy' }
  | { type: 'finishDeploy' }
  | { type: 'move'; unitId: string; cell: HexKey }
  | { type: 'attack'; unitId: string; cell: HexKey }
  | { type: 'setUp'; unitId: string }
  | { type: 'packUp'; unitId: string }
  | { type: 'dig'; unitId: string }
  | { type: 'rotate'; unitId: string; dir: number }
  | { type: 'endBattleTurn' }
  | { type: 'retreat' }
  | { type: 'secureObjective' }
  | { type: 'extract' }
  | { type: 'concludeBattle' };

export interface ApplyResult {
  state: GameState;
  error: string | null;
  outcome: AttackOutcome | null;
}

/** Every action runs under the game's own rules override (settings.rules). */
export function apply(prev: GameState, action: GameAction): ApplyResult {
  return withRules(prev.settings.rules, () => applyAction(prev, action));
}

function applyAction(prev: GameState, action: GameAction): ApplyResult {
  if (foundationHasPending(prev)) {
    const f = prev.infrastructure!;
    const allowed = f.capture.pending
      ? ['captureChoice', 'captureCommit']
      : f.garrisons?.pendingStationing
        ? ['stationingToggle', 'stationingCommit']
        : ['freeShotTarget', 'freeShotResolve'];
    if (!allowed.includes(action.type))
      return { state: prev, error: 'Resolve the pending campaign choices first', outcome: null };
  }
  const state = structuredClone(prev);
  const rng = createRng(state.rng);
  let res: { ok: boolean; error?: string; outcome?: AttackOutcome } = {
    ok: false,
    error: 'Unknown action',
  };

  const battleAction = (fn: () => typeof res): typeof res => {
    if (state.phase !== 'battle' || !state.battle) return { ok: false, error: 'No active battle' };
    return fn();
  };

  switch (action.type) {
    case 'moveCommander':
      res = moveCommander(state, action.armyId, action.dest);
      break;
    case 'engage':
      res = engage(state, action.armyId, action.targetId);
      break;
    case 'transferUnits':
      res = transferUnits(state, action.fromId, action.toId, action.unitIds);
      break;
    case 'configureCommanderTraining':
      res = configureCommanderTraining(state, action.cpCost);
      break;
    case 'formCommander':
      res = formCommander(state, action.fromId, action.unitIds);
      break;
    case 'moveArmy':
      res = moveArmy(state, action.armyId, action.dest);
      break;
    case 'recruit':
      res = recruit(state, action.typeId, action.nodeId);
      break;
    case 'nodeWork':
      res = applyCampaignNodeAction(state, buildWorld(state.settings.grid), action.request);
      break;
    case 'repairRoad':
      res = applyCampaignRoadRepair(state, action.request);
      break;
    case 'captureChoice': {
      const f = state.infrastructure;
      if (!f?.capture.pending) {
        res = { ok: false, error: 'No pending capture choices' };
        break;
      }
      res = chooseCampaignCapture(state, {
        requestId: `capture-choice:${state.nextId++}`,
        expectedVersion: f.capture.version,
        batchId: f.capture.pending.request.requestId,
        nodeId: action.nodeId,
        outcome: action.outcome,
      });
      break;
    }
    case 'captureCommit': {
      const f = state.infrastructure;
      if (!f?.capture.pending) {
        res = { ok: false, error: 'No pending capture choices' };
        break;
      }
      res = commitCampaignCapture(state, {
        requestId: `capture-commit:${state.nextId++}`,
        expectedVersion: f.capture.version,
        batchId: f.capture.pending.request.requestId,
      });
      if (res.ok) continueFoundationResolution(state);
      break;
    }
    case 'stationingToggle': {
      const pending = state.infrastructure?.garrisons?.pendingStationing;
      res = pending
        ? toggleCampaignStationing(state, action.unitId, pending.version)
        : { ok: false, error: 'No pending stationing choices' };
      break;
    }
    case 'stationingCommit': {
      const pending = state.infrastructure?.garrisons?.pendingStationing;
      res = pending
        ? commitCampaignStationing(state, pending.version)
        : { ok: false, error: 'No pending stationing choices' };
      if (res.ok) continueFoundationResolution(state);
      break;
    }
    case 'freeShotTarget':
      res = selectCampaignFreeShotTarget(state, action.targetId);
      break;
    case 'freeShotResolve':
      res = resolveCampaignFreeShot(state);
      if (res.ok) {
        syncCampaignClaims(state);
        checkCampaignVictory(state);
        continueFoundationResolution(state);
      }
      break;
    case 'razeTile':
      res = applyCampaignRazeTile(state, action.unitId, action.buildingId);
      break;
    case 'fortify':
      res = fortify(state, action.hex);
      break;
    case 'endTurn':
      res = endStrategicTurn(state);
      break;
    case 'startBattle':
      res = startPendingBattle(state);
      break;
    case 'autoResolve':
      res = autoResolve(state);
      break;
    case 'cancelBattle':
      res = cancelPendingBattle(state);
      break;
    case 'concludeBattle':
      res = concludeBattle(state);
      break;
    case 'deploy':
      res = battleAction(() =>
        deployUnit(contextFor(state), state.battle!, action.unitId, action.cell),
      );
      break;
    case 'placeFort':
      res = battleAction(() => placeWarnedFort(contextFor(state), state.battle!, action.cell));
      break;
    case 'autoDeploy':
      res = battleAction(() => {
        const b = state.battle!;
        if (b.phase !== 'deploy') return { ok: false, error: 'Not in deployment' };
        autoDeploy(contextFor(state), b, b.deployTeam, rng);
        return { ok: true };
      });
      break;
    case 'finishDeploy':
      res = battleAction(() => finishDeployment(contextFor(state), state.battle!, rng));
      break;
    case 'move':
      res = battleAction(() =>
        moveUnit(contextFor(state), state.battle!, action.unitId, action.cell),
      );
      break;
    case 'attack':
      res = battleAction(() =>
        attack(contextFor(state), state.battle!, rng, action.unitId, action.cell),
      );
      break;
    case 'setUp':
      res = battleAction(() => setUp(state.battle!, action.unitId));
      break;
    case 'packUp':
      res = battleAction(() => packUp(state.battle!, action.unitId));
      break;
    case 'dig':
      res = battleAction(() => digIn(state.battle!, action.unitId));
      break;
    case 'rotate':
      res = battleAction(() => rotateUnit(state.battle!, action.unitId, action.dir));
      break;
    case 'endBattleTurn':
      res = battleAction(() => endTurn(contextFor(state), state.battle!));
      break;
    case 'retreat':
      res = battleAction(() => retreat(state.battle!, state.battle!.active));
      break;
    case 'secureObjective':
      res = battleAction(() => secureObjective(contextFor(state), state.battle!));
      break;
    case 'extract':
      res = battleAction(() => extractFromBattle(contextFor(state), state.battle!));
      break;
  }

  if (!res.ok) return { state: prev, error: res.error ?? 'Action failed', outcome: null };
  // Tactical actions roll on the local rng; strategic auto-resolve advances state.rng itself.
  if (rng.state() !== prev.rng >>> 0) state.rng = rng.state();
  if (state.infrastructure) {
    if (
      (action.type === 'finishDeploy' || action.type === 'autoDeploy') &&
      state.battle?.phase === 'combat'
    ) {
      const opened = beginCampaignFreeShots(state, 'tactical-after-deployment');
      if (!opened.ok) return { state: prev, error: opened.error, outcome: null };
    }
    if (action.type === 'moveCommander' || action.type === 'moveArmy')
      afterFoundationMovement(state, action.armyId);
    else if (
      ![
        'captureChoice',
        'captureCommit',
        'stationingToggle',
        'freeShotTarget',
        'nodeWork',
        'repairRoad',
        'endTurn',
        'concludeBattle',
      ].includes(action.type)
    )
      refreshCampaignNodeSnapshot(state);
    syncCampaignClaims(state);
    if (!state.infrastructure.capture.pending) refreshCampaignNetworks(state);
  }
  return { state, error: null, outcome: res.outcome ?? null };
}

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
import { engage, formCommander, moveArmy, moveCommander, transferUnits } from './command.ts';
import type { GameState } from './types.ts';

export type GameAction =
  | { type: 'moveCommander'; armyId: string; dest: HexKey }
  | { type: 'engage'; armyId: string; targetId: string }
  | { type: 'transferUnits'; fromId: string; toId: string; unitIds: string[] }
  | { type: 'formCommander'; fromId: string; unitIds: string[] }
  /** V0.9 adapter: `dest` is a main hex (engage there, or step into it). */
  | { type: 'moveArmy'; armyId: string; dest: HexKey }
  | { type: 'recruit'; typeId: string }
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

export function apply(prev: GameState, action: GameAction): ApplyResult {
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
    case 'formCommander':
      res = formCommander(state, action.fromId, action.unitIds);
      break;
    case 'moveArmy':
      res = moveArmy(state, action.armyId, action.dest);
      break;
    case 'recruit':
      res = recruit(state, action.typeId);
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
  return { state, error: null, outcome: res.outcome ?? null };
}

// Compatibility shim — prefer importing from `./unitModels/index.ts`.
export type { ArmyCategory, ModelOptions, RosterModelUnit } from './unitModels/index.ts';
export {
  MAX_ESCORTS,
  armyCategory,
  armyEscorts,
  buildArmyModel,
  buildFormationModel,
  buildHqModel,
  buildUnitModel,
  hasUnitModel,
  modelTop,
} from './unitModels/index.ts';

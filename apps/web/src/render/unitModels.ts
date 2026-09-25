// Compatibility shim — prefer importing from `./unitModels/index.ts`.
export type { ArmyCategory, ModelOptions } from './unitModels/index.ts';
export {
  MAX_ESCORTS,
  armyCategory,
  armyEscorts,
  buildArmyModel,
  buildHqModel,
  buildUnitModel,
  hasUnitModel,
} from './unitModels/index.ts';

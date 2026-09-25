// Unit models: chunky geometric primitives, "chibi" proportions.
// Every model faces +X (the scene rotates it to the unit's facing). Figures get
// a big head, a short stubby body and ball hands that sit on their weapon;
// vehicles are short and chunky with oversized turrets and cylinder barrels.
// Team colour is the body; weapons are a neutral light metal.
//
// Layout:
//   shared/   — kit, materials, figure/horse/crown primitives
//   units/    — per-era unit builders + registry
//   army/     — strategic commander clusters
//   hq/       — strategic HQ buildings

export type { ModelOptions } from './shared/index.ts';
export { buildUnitModel, hasUnitModel } from './units/index.ts';
export type { ArmyCategory } from './army/index.ts';
export { MAX_ESCORTS, armyCategory, armyEscorts, buildArmyModel } from './army/index.ts';
export { buildHqModel } from './hq/index.ts';

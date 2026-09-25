// ── Standard scenario library (bundled JSON, no fs — safe in a Web Worker) ────

import tankVsAtGun from '../../scenarios/ww2-tank-vs-at-gun.json' with { type: 'json' };
import mgVsRifles from '../../scenarios/ww2-mg-vs-3-rifles.json' with { type: 'json' };
import rifleMirror from '../../scenarios/ww2-rifle-mirror.json' with { type: 'json' };
import mortarVsDugIn from '../../scenarios/ww2-mortar-vs-dug-in.json' with { type: 'json' };
import cavVsSpears from '../../scenarios/med-cav-vs-spears.json' with { type: 'json' };
import archersVsInfantry from '../../scenarios/med-archers-vs-infantry.json' with { type: 'json' };
import infantryMirror from '../../scenarios/med-infantry-mirror.json' with { type: 'json' };
import artilleryVsRidge from '../../scenarios/ww2-artillery-vs-ridge.json' with { type: 'json' };
import type { BattleSpec } from './spec.ts';
import { assertBattleSpec } from './spec.ts';

/** The ~8 standard matchups, validated at import. Order is stable. */
export const STANDARD_SCENARIOS: readonly BattleSpec[] = Object.freeze(
  [
    tankVsAtGun,
    mgVsRifles,
    rifleMirror,
    mortarVsDugIn,
    cavVsSpears,
    archersVsInfantry,
    infantryMirror,
    artilleryVsRidge,
  ].map((raw) => assertBattleSpec(raw)),
);

export function scenarioByName(name: string): BattleSpec | undefined {
  return STANDARD_SCENARIOS.find((s) => s.name === name);
}

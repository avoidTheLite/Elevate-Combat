// ── Headless baseline-vs-draft comparison (runs inside the balance worker) ──
// Pure: no DOM, no rendering. The worker is a thin shell around runComparison
// so the logic is testable directly under vitest.

import type { BattleSpec, RulesComparison, RulesOverride } from '@iron-ridge/engine';
import { STANDARD_SCENARIOS, compareRules } from '@iron-ridge/engine';

export interface CompareRequest {
  type: 'run';
  id: number;
  /** Scenario names from STANDARD_SCENARIOS (unknown names are ignored). */
  scenarios: string[];
  runs: number;
  /** Old rules (undefined = code baseline). */
  baseline?: RulesOverride;
  /** New rules (the page draft). */
  candidate?: RulesOverride;
  seedBase?: number;
}

export type CompareMessage =
  | { type: 'start'; id: number; total: number; current: string | null }
  | {
      type: 'progress';
      id: number;
      done: number;
      total: number;
      last: RulesComparison;
      /** Next scenario being run, null when finished. */
      current: string | null;
    }
  | { type: 'done'; id: number; results: RulesComparison[]; ms: number }
  | { type: 'error'; id: number; message: string };

export function scenarioSpecs(names: string[]): BattleSpec[] {
  const want = new Set(names);
  return STANDARD_SCENARIOS.filter((s) => want.has(s.name));
}

/** Run the comparison synchronously, reporting each scenario as it finishes. */
export function runComparison(
  req: CompareRequest,
  post: (m: CompareMessage) => void = () => {},
): RulesComparison[] {
  const t0 = performance.now();
  const specs = scenarioSpecs(req.scenarios);
  const runs = Math.max(1, Math.min(500, Math.floor(req.runs)));
  post({ type: 'start', id: req.id, total: specs.length, current: specs[0]?.name ?? null });
  const results = compareRules(
    specs,
    req.baseline,
    req.candidate,
    runs,
    req.seedBase ?? 1,
    (done, total, last) =>
      post({
        type: 'progress',
        id: req.id,
        done,
        total,
        last,
        current: specs[done]?.name ?? null,
      }),
  );
  post({ type: 'done', id: req.id, results, ms: Math.round(performance.now() - t0) });
  return results;
}

/** Old → new pass counts for the summary line (scenarios with an `expect`). */
export function passSummary(results: RulesComparison[]): {
  judged: number;
  oldPass: number;
  newPass: number;
} {
  const judged = results.filter((r) => r.baseline.pass !== undefined);
  return {
    judged: judged.length,
    oldPass: judged.filter((r) => r.baseline.pass).length,
    newPass: judged.filter((r) => r.candidate.pass).length,
  };
}

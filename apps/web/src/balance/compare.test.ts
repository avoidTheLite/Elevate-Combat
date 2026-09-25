import { describe, expect, it } from 'vitest';
import { baseUnitType } from '@iron-ridge/engine';
import type { CompareMessage } from './compare.ts';
import { passSummary, runComparison, scenarioSpecs } from './compare.ts';

describe('runComparison (worker logic, headless)', () => {
  it('runs one scenario under old and new rules and streams progress', () => {
    const msgs: CompareMessage[] = [];
    const tank = baseUnitType('ww2_tank');
    const results = runComparison(
      {
        type: 'run',
        id: 7,
        scenarios: ['ww2-tank-vs-at-gun', 'not-a-scenario'],
        runs: 2,
        candidate: { units: { ww2_tank: { hp: tank.hp * 3 } } },
      },
      (m) => msgs.push(m),
    );
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.name).toBe('ww2-tank-vs-at-gun');
    expect(r.baseline.runs).toBe(2);
    expect(r.candidate.runs).toBe(2);
    expect(r.band).not.toBeNull();
    for (const s of [r.baseline, r.candidate])
      expect(s.attackerWinPct + s.defenderWinPct + s.drawPct).toBeCloseTo(100, 0);
    expect(msgs.map((m) => m.type)).toEqual(['start', 'progress', 'done']);
    expect(msgs.every((m) => m.id === 7)).toBe(true);
    const sum = passSummary(results);
    expect(sum.judged).toBe(1);
  }, 30000);

  it('ignores unknown scenario names', () => {
    expect(scenarioSpecs(['nope'])).toEqual([]);
    expect(runComparison({ type: 'run', id: 1, scenarios: [], runs: 1 })).toEqual([]);
  });
});

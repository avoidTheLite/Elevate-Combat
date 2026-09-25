import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RulesComparison, SeriesResult } from '@iron-ridge/engine';
import { ComparisonResults } from './ComparisonResults.tsx';

function series(name: string, att: number, def: number, pass?: boolean): SeriesResult {
  return {
    name,
    runs: 20,
    attackerWinPct: att,
    defenderWinPct: def,
    drawPct: Math.round((100 - att - def) * 10) / 10,
    avgRounds: 5,
    margin: att - def,
    ...(pass === undefined ? {} : { pass, expect: { winner: 'defender' as const } }),
    ms: 10,
  };
}

const FIXTURE: RulesComparison[] = [
  {
    name: 'ww2-tank-vs-at-gun',
    baseline: series('ww2-tank-vs-at-gun', 60, 40, false),
    candidate: series('ww2-tank-vs-at-gun', 30, 70, true),
    delta: { attackerWinPct: -30, defenderWinPct: 30, drawPct: 0, avgRounds: 0 },
    band: { lo: 0, hi: 42.5, winner: 'defender' },
  },
  {
    name: 'ww2-rifle-mirror',
    baseline: series('ww2-rifle-mirror', 50, 45, true),
    candidate: series('ww2-rifle-mirror', 55, 45, true),
    delta: { attackerWinPct: 5, defenderWinPct: 0, drawPct: -5, avgRounds: 0 },
    band: { lo: 42.5, hi: 57.5, winner: 'even' },
  },
];

describe('ComparisonResults', () => {
  it('renders old/new bars, the target band, deltas and pass badges', () => {
    render(<ComparisonResults results={FIXTURE} />);
    expect(screen.getByTestId('pass-summary')).toHaveTextContent('PASSES 1/2 → 2/2');

    const tank = screen.getByTestId('cmp-ww2-tank-vs-at-gun');
    const t = within(tank);
    expect(t.getByTestId('badge-old')).toHaveTextContent(/FAIL/);
    expect(t.getByTestId('badge-new')).toHaveTextContent(/PASS/);
    expect(t.getByTestId('delta')).toHaveTextContent('(-30 pts)');

    const band = t.getByTestId('target-band');
    expect(band.getAttribute('x')).toBe('0');
    expect(band.getAttribute('width')).toBe('42.5');

    const oldAtk = t.getByTestId('bar-old').querySelector('[data-seg="attacker"]')!;
    const newAtk = t.getByTestId('bar-new').querySelector('[data-seg="attacker"]')!;
    expect(Number(oldAtk.getAttribute('width'))).toBeCloseTo(59.6, 1);
    expect(Number(newAtk.getAttribute('width'))).toBeCloseTo(29.6, 1);
    // Defender segment starts where attacker + draw end.
    const newDef = t.getByTestId('bar-new').querySelector('[data-seg="defender"]')!;
    expect(newDef.getAttribute('x')).toBe('30');

    const mirror = within(screen.getByTestId('cmp-ww2-rifle-mirror'));
    expect(mirror.getByTestId('target-band').getAttribute('x')).toBe('42.5');
    // 5% draws are drawn as their own segment.
    expect(mirror.getByTestId('bar-old').querySelector('[data-seg="draw"]')).not.toBeNull();
    expect(mirror.getByRole('img').getAttribute('aria-label')).toMatch(/50% old, 55% new/);
  });

  it('renders nothing without results', () => {
    const { container } = render(<ComparisonResults results={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

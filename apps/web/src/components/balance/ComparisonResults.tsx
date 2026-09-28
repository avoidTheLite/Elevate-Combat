import type { RulesComparison, SeriesResult } from '@iron-ridge/engine';
import { scenarioByName } from '@iron-ridge/engine';
import { passSummary } from '../../balance/compare.ts';
import { cn } from '../../lib/utils.ts';

// Validated (dataviz validator, dark surface): attacker / defender are the two
// categorical slots; draw is a neutral gray; the target band is a lime outline.
export const CHART_COLORS = {
  attacker: '#1f9cbc',
  defender: '#e8508a',
  draw: '#56616b',
  band: '#c8f53d',
} as const;

const W = 100;
const BAR_H = 9;
const GAP = 4;
const TOP = 3;

function fmt(n: number): string {
  return `${Math.round(n * 10) / 10}`;
}

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${fmt(n)}`;
}

function PassBadge({
  label,
  pass,
}: {
  label: string;
  pass: boolean | undefined;
}): React.ReactElement {
  if (pass === undefined)
    return (
      <span className="px-1 border border-[hsl(var(--muted-foreground))] text-[hsl(var(--muted-foreground))]">
        {label} N/A
      </span>
    );
  return (
    <span
      data-testid={`badge-${label.toLowerCase()}`}
      className={cn(
        'px-1 border',
        pass
          ? 'border-[hsl(var(--success))] text-[hsl(var(--success))]'
          : 'border-[hsl(var(--destructive))] text-[hsl(var(--destructive))]',
      )}
    >
      {label} {pass ? '✓ PASS' : '✗ FAIL'}
    </span>
  );
}

/** One stacked bar: attacker | draw | defender, left to right on 0–100. */
function SeriesBar({
  y,
  s,
  label,
  dim,
}: {
  y: number;
  s: SeriesResult;
  label: string;
  dim: boolean;
}): React.ReactElement {
  const segs = [
    { key: 'attacker', w: s.attackerWinPct, fill: CHART_COLORS.attacker, name: 'attacker win' },
    { key: 'draw', w: s.drawPct, fill: CHART_COLORS.draw, name: 'draw' },
    { key: 'defender', w: s.defenderWinPct, fill: CHART_COLORS.defender, name: 'defender win' },
  ];
  let x = 0;
  return (
    <g opacity={dim ? 0.6 : 1} data-testid={`bar-${label.toLowerCase()}`}>
      {segs.map((g) => {
        const x0 = x;
        x += g.w;
        if (g.w <= 0) return null;
        return (
          <rect
            key={g.key}
            data-seg={g.key}
            x={x0}
            y={y}
            width={Math.max(0, g.w - (x < W ? 0.4 : 0))}
            height={BAR_H}
            fill={g.fill}
            rx={0.8}
          >
            <title>{`${label}: ${fmt(g.w)}% ${g.name}`}</title>
          </rect>
        );
      })}
      {/* Attacker-win marker, the value the band is judged on. */}
      <line
        x1={s.attackerWinPct}
        x2={s.attackerWinPct}
        y1={y - 1}
        y2={y + BAR_H + 1}
        stroke="#ffffff"
        strokeWidth={0.5}
      />
    </g>
  );
}

export function ComparisonChart({ c }: { c: RulesComparison }): React.ReactElement {
  const h = TOP + BAR_H * 2 + GAP + 6;
  const band = c.band;
  return (
    <svg
      viewBox={`-1 0 ${W + 2} ${h}`}
      preserveAspectRatio="none"
      className="w-full h-[74px]"
      role="img"
      aria-label={`${c.name}: attacker wins ${fmt(c.baseline.attackerWinPct)}% old, ${fmt(
        c.candidate.attackerWinPct,
      )}% new${band ? `; target ${fmt(band.lo)}–${fmt(band.hi)}%` : ''}`}
    >
      {[0, 25, 50, 75, 100].map((t) => (
        <line
          key={t}
          x1={t}
          x2={t}
          y1={TOP - 1}
          y2={TOP + BAR_H * 2 + GAP + 1}
          stroke="hsl(195 80% 18%)"
          strokeWidth={0.3}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {band && (
        <rect
          x={band.lo}
          y={TOP - 2}
          width={Math.max(0.5, band.hi - band.lo)}
          height={BAR_H * 2 + GAP + 4}
          fill={CHART_COLORS.band}
          fillOpacity={0.14}
        />
      )}
      <SeriesBar y={TOP} s={c.baseline} label="OLD" dim />
      <SeriesBar y={TOP + BAR_H + GAP} s={c.candidate} label="NEW" dim={false} />
      {/* Band outline on top so it stays visible over the bars. */}
      {band && (
        <rect
          data-testid="target-band"
          x={band.lo}
          y={TOP - 2}
          width={Math.max(0.5, band.hi - band.lo)}
          height={BAR_H * 2 + GAP + 4}
          fill="none"
          stroke={CHART_COLORS.band}
          strokeWidth={1.5}
          strokeDasharray="3 2"
          vectorEffect="non-scaling-stroke"
        >
          <title>{`Target band (attacker win %): ${fmt(band.lo)}–${fmt(band.hi)} (${band.winner})`}</title>
        </rect>
      )}
    </svg>
  );
}

function Row({ c }: { c: RulesComparison }): React.ReactElement {
  const spec = scenarioByName(c.name);
  const d = c.delta.attackerWinPct;
  return (
    <li
      className="border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-2 flex flex-col gap-1"
      data-testid={`cmp-${c.name}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="text-[hsl(var(--primary))] tracking-widest">{c.name}</span>
        <span className="flex flex-wrap gap-1 text-[10px]">
          <PassBadge label="OLD" pass={c.baseline.pass} />
          <span className="text-[hsl(var(--muted-foreground))]">→</span>
          <PassBadge label="NEW" pass={c.candidate.pass} />
        </span>
      </div>
      {spec?.description && (
        <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
          {spec.description}
          {c.band && <> · expect: {c.band.winner}</>}
        </div>
      )}
      <div className="grid grid-cols-[34px_1fr] gap-x-2 items-center">
        <div className="flex flex-col justify-around h-[74px] text-[9px] tracking-widest text-[hsl(var(--muted-foreground))]">
          <span>OLD</span>
          <span className="text-[hsl(var(--foreground))]">NEW</span>
        </div>
        <ComparisonChart c={c} />
        <span />
        <div className="relative h-3 mx-[1%] text-[9px] text-[hsl(var(--muted-foreground))]">
          {[0, 25, 50, 75, 100].map((t) => (
            <span key={t} className="absolute -translate-x-1/2" style={{ left: `${t}%` }}>
              {t}
              {t === 0 || t === 100 ? '%' : ''}
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-3 text-[10px] text-[hsl(var(--muted-foreground))]">
        <span>
          ATK WIN {fmt(c.baseline.attackerWinPct)}% →{' '}
          <span className="text-[hsl(var(--foreground))]">{fmt(c.candidate.attackerWinPct)}%</span>{' '}
          <span
            data-testid="delta"
            className={cn(
              'font-bold',
              d > 0
                ? 'text-[hsl(var(--primary))]'
                : d < 0
                  ? 'text-[hsl(var(--secondary))]'
                  : 'text-[hsl(var(--muted-foreground))]',
            )}
          >
            ({signed(d)} pts)
          </span>
        </span>
        <span>
          DEF WIN {fmt(c.baseline.defenderWinPct)}% →{' '}
          <span className="text-[hsl(var(--foreground))]">{fmt(c.candidate.defenderWinPct)}%</span>
          {' · '}DRAW {fmt(c.baseline.drawPct)}% →{' '}
          <span className="text-[hsl(var(--foreground))]">{fmt(c.candidate.drawPct)}%</span>
        </span>
        <span>
          AVG ROUNDS {fmt(c.baseline.avgRounds)} → {fmt(c.candidate.avgRounds)} · {c.candidate.runs}{' '}
          runs
        </span>
      </div>
    </li>
  );
}

export function ChartLegend(): React.ReactElement {
  const sw = (color: string, label: string, dashed = false): React.ReactElement => (
    <span className="flex items-center gap-1">
      <span
        className="inline-block w-3 h-2.5"
        style={
          dashed
            ? { border: `1px dashed ${color}`, background: `${color}22` }
            : { background: color }
        }
      />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-3 text-[10px] text-[hsl(var(--muted-foreground))]">
      {sw(CHART_COLORS.attacker, 'Attacker win')}
      {sw(CHART_COLORS.draw, 'Draw')}
      {sw(CHART_COLORS.defender, 'Defender win')}
      {sw(CHART_COLORS.band, 'Target band (attacker win %)', true)}
      <span>OLD = applied rules · NEW = page draft · same seeds</span>
    </div>
  );
}

export function ComparisonResults({
  results,
}: {
  results: RulesComparison[];
}): React.ReactElement | null {
  if (!results.length) return null;
  const sum = passSummary(results);
  return (
    <div className="flex flex-col gap-2" data-testid="comparison-results">
      <div className="text-[11px] tracking-widest" data-testid="pass-summary">
        PASSES{' '}
        <span className="text-[hsl(var(--muted-foreground))]">
          {sum.oldPass}/{sum.judged}
        </span>{' '}
        →{' '}
        <span
          className={cn(
            'font-bold',
            sum.newPass > sum.oldPass
              ? 'text-[hsl(var(--success))]'
              : sum.newPass < sum.oldPass
                ? 'text-[hsl(var(--destructive))]'
                : 'text-[hsl(var(--foreground))]',
          )}
        >
          {sum.newPass}/{sum.judged}
        </span>{' '}
        <span className="text-[hsl(var(--muted-foreground))]">(old → new)</span>
      </div>
      <ChartLegend />
      <ul className="flex flex-col gap-2">
        {results.map((c) => (
          <Row key={c.name} c={c} />
        ))}
      </ul>
    </div>
  );
}

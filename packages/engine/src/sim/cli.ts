// ── Headless combat simulator CLI ─────────────────────────────────────────────
// Runs on Node ≥ 22.18 with native type stripping (no build step):
//
//   node packages/engine/src/sim/cli.ts [scenario|file.json …] [--runs N] [--seed N]
//                                        [--rules overrides.json] [--compare] [--json]
//   pnpm --filter @iron-ridge/engine sim -- --runs 50
//
// With no scenarios, runs the whole standard library. `--compare` runs baseline
// rules vs the `--rules` file with the same seeds and prints both plus the delta.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RulesOverride } from '../rules.ts';
import { validateRulesOverride } from '../rulesValidate.ts';
import type { RulesComparison, SeriesResult } from './run.ts';
import { compareRules, expectBand, runSeries } from './run.ts';
import { STANDARD_SCENARIOS, scenarioByName } from './scenarios.ts';
import type { BattleSpec } from './spec.ts';
import { parseBattleSpec } from './spec.ts';

interface Args {
  targets: string[];
  runs: number;
  seed: number;
  rules: string | null;
  compare: boolean;
  json: boolean;
}

const USAGE = `usage: sim [scenario|file.json …] [--runs N] [--seed N] [--rules file.json] [--compare] [--json]
scenarios: ${STANDARD_SCENARIOS.map((s) => s.name).join(', ')}`;

function parseArgs(argv: string[]): Args {
  const a: Args = { targets: [], runs: 20, seed: 1, rules: null, compare: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === '--runs') a.runs = Math.max(1, Number.parseInt(val(), 10));
    else if (x === '--seed') a.seed = Number.parseInt(val(), 10);
    else if (x === '--rules') a.rules = val();
    else if (x === '--compare') a.compare = true;
    else if (x === '--json') a.json = true;
    else if (x === '--help' || x === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (x === '--') continue;
    else if (x.startsWith('--')) throw new Error(`unknown flag ${x}\n${USAGE}`);
    else a.targets.push(x);
  }
  if (!Number.isFinite(a.runs) || !Number.isFinite(a.seed)) throw new Error('bad --runs/--seed');
  return a;
}

function readJson(path: string, what: string): unknown {
  const full = resolve(process.env.INIT_CWD ?? process.cwd(), path);
  if (!existsSync(full))
    throw new Error(`${what} not found: ${path}
${USAGE}`);
  return JSON.parse(readFileSync(full, 'utf8'));
}

function loadSpecs(targets: string[]): BattleSpec[] {
  if (!targets.length) return [...STANDARD_SCENARIOS];
  return targets.map((t) => {
    const named = scenarioByName(t);
    if (named) return named;
    const r = parseBattleSpec(readJson(t, 'scenario'));
    if (!r.ok) throw new Error(`${t}: ${r.errors.join('; ')}`);
    return r.spec;
  });
}

function loadRules(path: string | null): RulesOverride | undefined {
  if (!path) return undefined;
  const r = validateRulesOverride(readJson(path, 'rules file'));
  if (!r.ok) throw new Error(`${path}: ${r.errors.join('; ')}`);
  return r.rules;
}

const BAR = 30;

/** Attacker-win bar: '#' attacker wins, '.' draws, '-' defender wins; '|' marks the target band. */
function bar(s: SeriesResult): string {
  const att = Math.round((s.attackerWinPct / 100) * BAR);
  const draw = Math.round((s.drawPct / 100) * BAR);
  const cells = ('#'.repeat(att) + '.'.repeat(draw)).padEnd(BAR, '-').split('');
  if (s.expect) {
    const b = expectBand(s.expect);
    for (const p of [b.lo, b.hi]) {
      const i = Math.min(BAR - 1, Math.round((p / 100) * BAR));
      if (p > 0 && p < 100) cells[i] = '|';
    }
  }
  return `[${cells.join('')}]`;
}

const verdict = (s: SeriesResult): string => (s.pass === undefined ? '' : s.pass ? 'PASS' : 'FAIL');

const pad = (x: string | number, n: number): string => String(x).padStart(n);

function printSeries(rows: SeriesResult[]): void {
  const w = Math.max(8, ...rows.map((r) => r.name.length));
  console.log(
    `${'scenario'.padEnd(w)}  ${pad('att%', 6)} ${pad('def%', 6)} ${pad('draw%', 6)} ${pad('rounds', 6)}  ${'attacker win (| = target band)'.padEnd(BAR + 2)}  expect     result  ms/run`,
  );
  for (const r of rows) {
    const exp = r.expect ? r.expect.winner : '-';
    console.log(
      `${r.name.padEnd(w)}  ${pad(r.attackerWinPct, 6)} ${pad(r.defenderWinPct, 6)} ${pad(r.drawPct, 6)} ${pad(r.avgRounds, 6)}  ${bar(r)}  ${exp.padEnd(9)}  ${verdict(r).padEnd(6)}  ${pad(Math.round(r.ms / r.runs), 6)}`,
    );
  }
}

function printCompare(rows: RulesComparison[]): void {
  const w = Math.max(8, ...rows.map((r) => r.name.length));
  console.log(
    `${'scenario'.padEnd(w)}  ${'baseline'.padEnd(BAR + 2)} ${pad('att%', 6)}  ${'candidate'.padEnd(BAR + 2)} ${pad('att%', 6)} ${pad('Δatt', 7)}  expect     base  cand`,
  );
  for (const r of rows) {
    const d = r.delta.attackerWinPct;
    console.log(
      `${r.name.padEnd(w)}  ${bar(r.baseline)} ${pad(r.baseline.attackerWinPct, 6)}  ${bar(r.candidate)} ${pad(r.candidate.attackerWinPct, 6)} ${pad((d > 0 ? '+' : '') + d, 7)}  ${(r.band?.winner ?? '-').padEnd(9)}  ${verdict(r.baseline).padEnd(4)}  ${verdict(r.candidate)}`,
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const specs = loadSpecs(args.targets);
  const rules = loadRules(args.rules);
  const t0 = performance.now();
  if (args.compare) {
    if (!rules) throw new Error('--compare needs --rules file.json');
    const rows = compareRules(specs, undefined, rules, args.runs, args.seed);
    if (args.json) console.log(JSON.stringify(rows, null, 2));
    else printCompare(rows);
  } else {
    const rows = specs.map((s) => runSeries(s, args.runs, args.seed, rules));
    if (args.json) console.log(JSON.stringify(rows, null, 2));
    else printSeries(rows);
  }
  if (!args.json)
    console.log(
      `\n${specs.length} scenario(s) × ${args.runs} run(s)${args.compare ? ' × 2' : ''} in ${((performance.now() - t0) / 1000).toFixed(1)}s (seeds ${args.seed}…${args.seed + args.runs - 1})`,
    );
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

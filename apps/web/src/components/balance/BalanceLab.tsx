import { useEffect, useRef, useState } from 'react';
import type { Era, RulesComparison } from '@iron-ridge/engine';
import { STANDARD_SCENARIOS, unitsForEra } from '@iron-ridge/engine';
import type { CompareMessage } from '../../balance/compare.ts';
import { isEmptyRules, normalizeRules, rulesChangeCount } from '../../balance/draft.ts';
import { useBalanceStore, withActiveRules } from '../../balance/store.ts';
import type { ComparisonJob } from '../../balance/worker.ts';
import { startComparison } from '../../balance/worker.ts';
import { cn } from '../../lib/utils.ts';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';
import { ComparisonResults } from './ComparisonResults.tsx';
import { MechanicsCard } from './MechanicsCard.tsx';
import { UnitCard } from './UnitCard.tsx';

const ERAS: { id: Era; label: string }[] = [
  { id: 'ww2', label: 'WW2' },
  { id: 'medieval', label: 'MEDIEVAL' },
];
export const RUN_OPTIONS = [5, 10, 20, 50] as const;

function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface TestState {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  results: RulesComparison[];
  error: string | null;
  ms: number | null;
}

const IDLE: TestState = {
  running: false,
  done: 0,
  total: 0,
  current: null,
  results: [],
  error: null,
  ms: null,
};

function TestPanel(): React.ReactElement {
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(STANDARD_SCENARIOS.map((s) => s.name)),
  );
  const [runs, setRuns] = useState<number>(10);
  const [test, setTest] = useState<TestState>(IDLE);
  const job = useRef<ComparisonJob | null>(null);
  const seq = useRef(0);

  useEffect(() => () => job.current?.cancel(), []);

  const run = (): void => {
    job.current?.cancel();
    const { active, draft } = useBalanceStore.getState();
    const id = ++seq.current;
    const scenarios = STANDARD_SCENARIOS.filter((s) => picked.has(s.name)).map((s) => s.name);
    setTest({ ...IDLE, running: true, total: scenarios.length, current: scenarios[0] ?? null });
    const candidate = normalizeRules(draft);
    job.current = startComparison(
      {
        type: 'run',
        id,
        scenarios,
        runs,
        ...(active ? { baseline: active } : {}),
        ...(isEmptyRules(candidate) ? {} : { candidate }),
      },
      (m: CompareMessage) => {
        if (m.id !== seq.current) return;
        setTest((t) => {
          switch (m.type) {
            case 'start':
              return { ...t, total: m.total, current: m.current };
            case 'progress':
              return {
                ...t,
                done: m.done,
                total: m.total,
                current: m.current,
                results: [...t.results, m.last],
              };
            case 'done':
              return { ...t, running: false, current: null, results: m.results, ms: m.ms };
            case 'error':
              return { ...t, running: false, current: null, error: m.message };
          }
        });
        if (m.type === 'done' || m.type === 'error') job.current = null;
      },
    );
  };

  const cancel = (): void => {
    job.current?.cancel();
    job.current = null;
    setTest((t) => ({ ...t, running: false, current: null, error: 'Cancelled' }));
  };

  const toggle = (name: string): void =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const pct = test.total ? Math.round((100 * test.done) / test.total) : 0;

  return (
    <section
      aria-label="Balance test"
      className="border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-2.5 flex flex-col gap-2"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-[hsl(var(--primary))] tracking-widest">
          [ TEST: OLD (APPLIED) vs NEW (DRAFT) — HEADLESS ]
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 text-[hsl(var(--muted-foreground))] tracking-widest">
            RUNS / SCENARIO
            <select
              aria-label="Runs per scenario"
              value={runs}
              onChange={(e) => setRuns(Number(e.target.value))}
              className="bg-[hsl(var(--panel))] border border-[hsl(var(--border-bright))] text-[hsl(var(--foreground))] px-1"
            >
              {RUN_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {test.running ? (
            <Button size="sm" variant="destructive" onClick={cancel}>
              CANCEL
            </Button>
          ) : (
            <Button size="sm" variant="attack" onClick={run} disabled={picked.size === 0}>
              ▶ RUN TEST
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
        {STANDARD_SCENARIOS.map((s) => (
          <label
            key={s.name}
            className="flex items-center gap-1 cursor-pointer"
            title={s.description ?? s.name}
          >
            <input
              type="checkbox"
              checked={picked.has(s.name)}
              onChange={() => toggle(s.name)}
              className="accent-[hsl(var(--primary))]"
            />
            <span className="text-[hsl(var(--foreground))]">{s.name}</span>
            <span className="text-[hsl(var(--muted-foreground))]">
              ({s.expect?.winner ?? 'no target'})
            </span>
          </label>
        ))}
        <button
          className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] tracking-widest"
          onClick={() =>
            setPicked((p) =>
              p.size === STANDARD_SCENARIOS.length
                ? new Set()
                : new Set(STANDARD_SCENARIOS.map((s) => s.name)),
            )
          }
        >
          [ALL / NONE]
        </button>
      </div>

      {(test.running || test.ms !== null || test.error) && (
        <div className="flex flex-col gap-1 text-[10px]" aria-live="polite">
          <div
            className="h-1.5 bg-[hsl(var(--muted))] overflow-hidden"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-[hsl(var(--primary))]" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[hsl(var(--muted-foreground))]">
            {test.running ? (
              `Running ${test.current ?? '…'} (${test.done}/${test.total} scenarios, ${runs} runs × 2 rule sets)`
            ) : test.error ? (
              <span className="text-[hsl(var(--destructive))]">{test.error}</span>
            ) : (
              `Done: ${test.results.length} scenarios in ${((test.ms ?? 0) / 1000).toFixed(1)}s`
            )}
          </div>
        </div>
      )}

      <ComparisonResults results={test.results} />
    </section>
  );
}

export function BalanceLab(): React.ReactElement {
  const closeLab = useBalanceStore((s) => s.closeLab);
  const draft = useBalanceStore((s) => s.draft);
  const active = useBalanceStore((s) => s.active);
  const draftVersion = useBalanceStore((s) => s.draftVersion);
  const dirtyCards = useBalanceStore((s) => s.dirtyCards);
  const applyAll = useBalanceStore((s) => s.applyAll);
  const clearActive = useBalanceStore((s) => s.clearActive);
  const resetDraft = useBalanceStore((s) => s.resetDraft);
  const importJson = useBalanceStore((s) => s.importJson);
  const newGame = useGameStore((s) => s.newGame);
  const [era, setEra] = useState<Era>(() => useBalanceStore.getState().setup.era);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const draftCount = rulesChangeCount(draft);
  const activeCount = rulesChangeCount(active);
  const draftDiffers =
    JSON.stringify(normalizeRules(draft)) !== JSON.stringify(normalizeRules(active));
  const unsaved = Object.keys(dirtyCards).length;

  const doApply = (): void => {
    const a = applyAll();
    setNotice({
      tone: 'ok',
      text: [
        a
          ? `Applied ${rulesChangeCount(a)} change(s). New games use these rules.`
          : 'Applied: code baseline (no overrides).',
      ],
    });
  };

  const applyAndPlay = (): void => {
    applyAll();
    const setup = useBalanceStore.getState().setup;
    newGame(withActiveRules(setup));
    closeLab();
  };

  const onImport = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const errs = importJson(await file.text());
    setNotice(
      errs.length
        ? { tone: 'err', text: ['Import rejected:', ...errs] }
        : { tone: 'ok', text: [`Imported ${file.name} into the draft (not applied yet).`] },
    );
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="min-h-screen flex flex-col gap-3 p-3 sm:p-4 max-w-[1500px] mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xl font-bold tracking-[0.3em] text-glow">▲ BALANCE LAB</div>
          <div className="text-[10px] text-[hsl(var(--muted-foreground))] tracking-widest">
            // DEV ONLY :: RUNTIME RULE OVERRIDES :: NO REBUILD
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] tracking-widest">
          <span
            data-testid="applied-badge"
            className={cn(
              'px-1.5 py-0.5 border',
              active
                ? 'border-[hsl(var(--accent))] text-[hsl(var(--accent))]'
                : 'border-[hsl(var(--muted-foreground))] text-[hsl(var(--muted-foreground))]',
            )}
          >
            APPLIED: {active ? `${activeCount} CHANGE(S)` : 'BASELINE'}
          </span>
          <span
            data-testid="draft-badge"
            className={cn(
              'px-1.5 py-0.5 border',
              draftDiffers
                ? 'border-[hsl(var(--warning))] text-[hsl(var(--warning))]'
                : 'border-[hsl(var(--muted-foreground))] text-[hsl(var(--muted-foreground))]',
            )}
          >
            DRAFT: {draftCount} CHANGE(S){draftDiffers ? ' · NOT APPLIED' : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={closeLab}>
            ◂ BACK TO SETUP
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={doApply} disabled={!draftDiffers}>
          APPLY ALL
        </Button>
        <Button size="sm" onClick={applyAndPlay}>
          APPLY &amp; NEW GAME
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => downloadJson('iron-ridge-rules.json', normalizeRules(draft))}
        >
          EXPORT JSON
        </Button>
        <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
          IMPORT JSON
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          aria-label="Import rules JSON"
          className="hidden"
          onChange={(e) => void onImport(e.target.files?.[0])}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            resetDraft();
            setNotice({
              tone: 'ok',
              text: ['Draft reset to code baseline (Apply all to use it).'],
            });
          }}
          disabled={isEmptyRules(draft)}
        >
          RESET TO BASELINE
        </Button>
        {active && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              clearActive();
              setNotice({
                tone: 'ok',
                text: ['Applied rules cleared; new games use the code baseline.'],
              });
            }}
          >
            CLEAR APPLIED
          </Button>
        )}
      </div>

      {unsaved > 0 && (
        <div className="text-[10px] text-[hsl(var(--warning))]" data-testid="unsaved-warning">
          ● {unsaved} card(s) have unsaved edits — press SAVE on each card to include them in the
          draft, test and apply.
        </div>
      )}
      {notice && (
        <div
          role={notice.tone === 'err' ? 'alert' : 'status'}
          className={cn(
            'text-[10px] border p-1.5',
            notice.tone === 'err'
              ? 'border-[hsl(var(--destructive))] text-[hsl(var(--destructive))]'
              : 'border-[hsl(var(--success))] text-[hsl(var(--success))]',
          )}
        >
          {notice.text.map((t) => (
            <div key={t}>{t}</div>
          ))}
        </div>
      )}

      <TestPanel />

      <div role="tablist" aria-label="Era" className="flex gap-1">
        {ERAS.map((e) => (
          <Button
            key={e.id}
            role="tab"
            aria-selected={era === e.id}
            size="sm"
            variant={era === e.id ? 'default' : 'ghost'}
            onClick={() => setEra(e.id)}
          >
            {e.label}
          </Button>
        ))}
      </div>

      {/* Both eras stay mounted so switching tabs keeps unsaved card edits. */}
      {ERAS.map((e) => (
        <div
          key={`${e.id}:${draftVersion}`}
          className={cn(
            'grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4',
            era !== e.id && 'hidden',
          )}
          data-testid={`era-grid-${e.id}`}
        >
          {unitsForEra(e.id).map((u) => (
            <UnitCard key={u.id} typeId={u.id} />
          ))}
        </div>
      ))}
      <div className="grid" key={`mech:${draftVersion}`}>
        <MechanicsCard />
      </div>
    </div>
  );
}

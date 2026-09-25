import { useEffect, useMemo, useState } from 'react';
import type { MechForm } from '../../balance/draft.ts';
import { mechForm, mechFormToOverride, mechanicsLeaves } from '../../balance/draft.ts';
import { useBalanceStore } from '../../balance/store.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/Button.tsx';

const inputCls =
  'w-full min-w-0 bg-transparent border px-1 py-0.5 text-[11px] text-[hsl(var(--foreground))] focus:outline-none focus:border-[hsl(var(--primary))]';

/** Combat constants (engine `mechanics()`), grouped by top-level knob. */
export function MechanicsCard(): React.ReactElement {
  const saved = useBalanceStore((s) => s.draft.mechanics);
  const saveMechanics = useBalanceStore((s) => s.saveMechanics);
  const baseline = useMemo(() => mechanicsLeaves(), []);
  const savedForm = useMemo(() => mechForm(saved), [saved]);
  const [form, setForm] = useState<MechForm>(savedForm);
  const [errors, setErrors] = useState<string[]>([]);

  const paths = Object.keys(baseline);
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const g = p.split('.')[0]!;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const isDirty = paths.some((p) => Number(form[p]) !== Number(savedForm[p]));
  const setCardDirty = useBalanceStore((s) => s.setCardDirty);
  useEffect(() => setCardDirty('mechanics', isDirty), [isDirty, setCardDirty]);
  useEffect(() => () => setCardDirty('mechanics', false), [setCardDirty]);

  const save = (): void => {
    const r = mechFormToOverride(form);
    if (r.errors.length) return setErrors(r.errors);
    const errs = saveMechanics(r.override);
    setErrors(errs);
    if (!errs.length) setForm(mechForm(r.override));
  };

  return (
    <section
      aria-label="Mechanics card"
      data-testid="mechanics-card"
      className={cn(
        'border bg-[hsl(var(--panel))] p-2.5 flex flex-col gap-2 col-span-full',
        isDirty ? 'border-[hsl(var(--warning))]' : 'border-[hsl(var(--border-bright))]',
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="text-[12px] text-[hsl(var(--primary))] tracking-widest">
          COMBAT MECHANICS
        </div>
        <div className="text-[9px] text-[hsl(var(--muted-foreground))] tracking-widest">
          {isDirty ? (
            <span className="text-[hsl(var(--warning))]">● UNSAVED EDITS</span>
          ) : saved ? (
            <span className="text-[hsl(var(--accent))]">◆ MODIFIED VS BASELINE</span>
          ) : (
            'BASELINE'
          )}
        </div>
      </header>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-3 gap-y-2">
        {[...groups.entries()].map(([g, ps]) => (
          <fieldset key={g} className="flex flex-col gap-1 min-w-0">
            <legend className="text-[9px] tracking-widest text-[hsl(var(--primary))] truncate">
              {g}
            </legend>
            {ps.map((p) => {
              const sub = p.slice(g.length + 1);
              const dirty = Number(form[p]) !== Number(savedForm[p]);
              const changed = Number(form[p]) !== baseline[p];
              return (
                <label
                  key={p}
                  className="flex items-center gap-1"
                  title={`baseline ${baseline[p]}`}
                >
                  {sub && (
                    <span className="text-[9px] text-[hsl(var(--muted-foreground))] w-16 truncate">
                      {sub}
                    </span>
                  )}
                  <input
                    type="number"
                    step="any"
                    aria-label={`mechanics ${p}`}
                    value={form[p] ?? ''}
                    onChange={(e) => setForm({ ...form, [p]: e.target.value })}
                    className={cn(
                      inputCls,
                      dirty
                        ? 'border-[hsl(var(--warning))]'
                        : changed
                          ? 'border-[hsl(var(--accent))]'
                          : 'border-[hsl(var(--border-bright))]',
                    )}
                  />
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
      {errors.length > 0 && (
        <ul
          role="alert"
          className="text-[10px] text-[hsl(var(--destructive))] border border-[hsl(var(--destructive))] p-1.5"
        >
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-1.5">
        <Button size="sm" onClick={save} disabled={!isDirty}>
          SAVE MECHANICS
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!isDirty}
          onClick={() => {
            setForm(savedForm);
            setErrors([]);
          }}
        >
          REVERT
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setForm(mechForm())}>
          BASELINE
        </Button>
      </div>
    </section>
  );
}

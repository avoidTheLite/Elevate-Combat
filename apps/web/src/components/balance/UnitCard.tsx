import { useEffect, useMemo, useState } from 'react';
import type { RangeProfile } from '@iron-ridge/engine';
import { UNIT_STAT_BOUNDS, baseUnitType } from '@iron-ridge/engine';
import type { FlagField, NumField, PoolField, PoolForm, UnitForm } from '../../balance/draft.ts';
import {
  FIELD_LABEL,
  FLAG_FIELDS,
  NUM_FIELDS,
  POOL_FIELDS,
  PROFILES,
  changedFields,
  formToOverride,
  formsEqual,
  unitForm,
} from '../../balance/draft.ts';
import { useBalanceStore } from '../../balance/store.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/Button.tsx';
import { UnitThumb } from './UnitThumb.tsx';

const TEAM_A = 0x00f0ff;

const inputCls =
  'w-full min-w-0 bg-transparent border px-1 py-0.5 text-[11px] text-[hsl(var(--foreground))] focus:outline-none focus:border-[hsl(var(--primary))]';

/** Field tone: unsaved edit > differs from code baseline > normal. */
function tone(key: string, dirty: Set<string>, overridden: Set<string>): string {
  if (dirty.has(key)) return 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.08)]';
  if (overridden.has(key)) return 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/0.08)]';
  return 'border-[hsl(var(--border-bright))]';
}

function PoolInputs({
  name,
  label,
  pool,
  prefix,
  dirty,
  overridden,
  disabled,
  onChange,
}: {
  name: string;
  label: string;
  pool: PoolForm;
  prefix: 'direct' | 'splash';
  dirty: Set<string>;
  overridden: Set<string>;
  disabled?: boolean;
  onChange: (k: PoolField, v: string) => void;
}): React.ReactElement {
  const sep: Record<PoolField, string> = { count: '', sides: 'd', bonus: '+' };
  return (
    <div className="flex items-center gap-1 text-[10px]">
      {POOL_FIELDS.map((k) => (
        <span key={k} className="flex items-center gap-0.5 flex-1 min-w-0">
          {sep[k] && <span className="text-[hsl(var(--muted-foreground))]">{sep[k]}</span>}
          <input
            type="number"
            step={1}
            aria-label={`${name} ${label} ${k}`}
            disabled={disabled}
            value={pool[k]}
            onChange={(e) => onChange(k, e.target.value)}
            className={cn(
              inputCls,
              tone(`${prefix}.${k}`, dirty, overridden),
              'disabled:opacity-40',
            )}
          />
        </span>
      ))}
    </div>
  );
}

export function UnitCard({ typeId }: { typeId: string }): React.ReactElement {
  const base = baseUnitType(typeId);
  const savedOverride = useBalanceStore((s) => s.draft.units?.[typeId]);
  const saveUnit = useBalanceStore((s) => s.saveUnit);
  const baseForm = useMemo(() => unitForm(typeId), [typeId]);
  const savedForm = useMemo(() => unitForm(typeId, savedOverride), [typeId, savedOverride]);
  const [form, setForm] = useState<UnitForm>(savedForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);

  const dirty = changedFields(form, savedForm);
  const overridden = changedFields(form, baseForm);
  const isDirty = !formsEqual(form, savedForm);
  const setCardDirty = useBalanceStore((s) => s.setCardDirty);
  useEffect(() => setCardDirty(typeId, isDirty), [typeId, isDirty, setCardDirty]);
  useEffect(() => () => setCardDirty(typeId, false), [typeId, setCardDirty]);

  const edit = (patch: Partial<UnitForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setSavedFlash(false);
  };
  const setNum = (f: NumField, v: string): void => edit({ nums: { ...form.nums, [f]: v } });
  const setFlag = (f: FlagField, v: boolean): void => edit({ flags: { ...form.flags, [f]: v } });

  const save = (): void => {
    const r = formToOverride(typeId, form);
    if (r.errors.length) {
      setErrors(r.errors);
      return;
    }
    const errs = saveUnit(typeId, r.override);
    setErrors(errs);
    if (!errs.length) {
      // Re-seed from the normalized saved values (e.g. "08" → "8").
      setForm(unitForm(typeId, r.override));
      setSavedFlash(true);
    }
  };

  const label = (key: string, text: string): React.ReactElement => (
    <span
      className={cn(
        'text-[9px] tracking-widest',
        dirty.has(key)
          ? 'text-[hsl(var(--warning))]'
          : overridden.has(key)
            ? 'text-[hsl(var(--accent))]'
            : 'text-[hsl(var(--muted-foreground))]',
      )}
    >
      {text}
    </span>
  );

  return (
    <section
      aria-label={`${base.name} card`}
      data-testid={`unit-card-${typeId}`}
      className={cn(
        'border bg-[hsl(var(--panel))] p-2.5 flex flex-col gap-2',
        isDirty ? 'border-[hsl(var(--warning))]' : 'border-[hsl(var(--border-bright))]',
      )}
    >
      <header className="flex gap-2">
        <UnitThumb typeId={typeId} short={base.short} color={TEAM_A} />
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="text-[12px] text-[hsl(var(--primary))] tracking-widest truncate">
            {base.name}
          </div>
          <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-3.5">
            {base.role}
          </div>
          <div className="text-[9px] text-[hsl(var(--muted-foreground))] tracking-widest">
            {base.unitClass} · {base.armorClass.replace('_', ' ')} · {base.damageType} ·{' '}
            {base.attackType.replace('_', ' ')}
          </div>
          <div className="text-[9px] tracking-widest">
            {isDirty ? (
              <span className="text-[hsl(var(--warning))]">● UNSAVED EDITS</span>
            ) : savedOverride ? (
              <span className="text-[hsl(var(--accent))]">◆ MODIFIED VS BASELINE</span>
            ) : (
              <span className="text-[hsl(var(--muted-foreground))]">BASELINE</span>
            )}
            {savedFlash && !isDirty && (
              <span className="ml-2 text-[hsl(var(--success))]">✓ SAVED TO DRAFT</span>
            )}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-x-2 gap-y-1.5">
        <label className="flex flex-col gap-0.5">
          {label('short', 'SHORT')}
          <input
            aria-label={`${base.name} SHORT`}
            maxLength={6}
            value={form.short}
            onChange={(e) => edit({ short: e.target.value })}
            className={cn(inputCls, tone('short', dirty, overridden))}
          />
        </label>
        {NUM_FIELDS.map((f) => {
          const b = UNIT_STAT_BOUNDS[f]!;
          return (
            <label key={f} className="flex flex-col gap-0.5" title={`${b.min}–${b.max}`}>
              {label(f, FIELD_LABEL[f])}
              <input
                type="number"
                aria-label={`${base.name} ${FIELD_LABEL[f]}`}
                min={b.min}
                max={b.max}
                step={b.int ? 1 : 0.1}
                value={form.nums[f]}
                onChange={(e) => setNum(f, e.target.value)}
                className={cn(inputCls, tone(f, dirty, overridden))}
              />
            </label>
          );
        })}
        <label className="flex flex-col gap-0.5 col-span-2">
          {label('profile', 'RANGE PROFILE')}
          <select
            aria-label={`${base.name} RANGE PROFILE`}
            value={form.profile}
            onChange={(e) => edit({ profile: e.target.value as RangeProfile })}
            className={cn(inputCls, 'bg-[hsl(var(--panel))]', tone('profile', dirty, overridden))}
          >
            {PROFILES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-0.5">
        {label('direct', 'DIRECT DICE (count d sides + bonus)')}
        <PoolInputs
          name={base.name}
          label="DIRECT"
          pool={form.direct}
          prefix="direct"
          dirty={dirty}
          overridden={overridden}
          onChange={(k, v) => edit({ direct: { ...form.direct, [k]: v } })}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            aria-label={`${base.name} HAS SPLASH`}
            checked={form.hasSplash}
            onChange={(e) => edit({ hasSplash: e.target.checked })}
            className="accent-[hsl(var(--primary))]"
          />
          {label('hasSplash', 'SPLASH DICE')}
        </label>
        <PoolInputs
          name={base.name}
          label="SPLASH"
          pool={form.splash}
          prefix="splash"
          dirty={dirty}
          overridden={overridden}
          disabled={!form.hasSplash}
          onChange={(k, v) => edit({ splash: { ...form.splash, [k]: v } })}
        />
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {FLAG_FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              aria-label={`${base.name} ${FIELD_LABEL[f]}`}
              checked={form.flags[f]}
              onChange={(e) => setFlag(f, e.target.checked)}
              className="accent-[hsl(var(--primary))]"
            />
            {label(f, FIELD_LABEL[f])}
          </label>
        ))}
      </div>

      {errors.length > 0 && (
        <ul
          role="alert"
          className="text-[10px] text-[hsl(var(--destructive))] border border-[hsl(var(--destructive))] p-1.5 flex flex-col gap-0.5"
        >
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-1.5 mt-auto">
        <Button size="sm" onClick={save} disabled={!isDirty} className="flex-1">
          SAVE
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
        <Button
          size="sm"
          variant="ghost"
          disabled={formsEqual(form, baseForm)}
          onClick={() => edit({ ...baseForm })}
          title="Load the code baseline into this card (Save to commit)"
        >
          BASELINE
        </Button>
      </div>
    </section>
  );
}

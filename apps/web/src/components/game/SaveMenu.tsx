import { useMemo, useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import { MANUAL_SLOTS, slotName } from '../../stores/saveSlots.ts';
import type { SlotInfo } from '../../stores/saveSlots.ts';

/** Browser download of a text file (no-op where Blob URLs are unavailable, e.g. jsdom). */
export function downloadText(text: string, filename: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function describeSlot(info: SlotInfo): string {
  if (info.empty) return 'EMPTY';
  if (!info.ok) return 'CORRUPTED';
  const phase = info.phase === 'battle' ? `battle/${info.battlePhase ?? '?'}` : info.phase;
  return `T${info.turn} · ${phase} · ${info.era?.toUpperCase()}`;
}

export function formatSavedAt(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/**
 * In-game save menu: a SAVE GAME button that expands into the three manual slots
 * (overwrite shows what is there) plus EXPORT to a .json file.
 */
export function SaveMenu(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const saveToSlot = useGameStore((s) => s.saveToSlot);
  const listSlots = useGameStore((s) => s.listSlots);
  const exportSave = useGameStore((s) => s.exportSave);
  const notice = useGameStore((s) => s.saveNotice);
  const rev = useGameStore((s) => s.saveRev);
  const slots = useMemo(() => (open ? listSlots() : []), [open, rev, listSlots]);

  if (!open)
    return (
      <Button size="lg" variant="default" onClick={() => setOpen(true)}>
        SAVE GAME…
      </Button>
    );

  return (
    <div className="w-full flex flex-col gap-2 border border-[hsl(var(--border-bright))] p-3 text-left">
      <div className="text-[11px] text-[hsl(var(--primary))] tracking-widest">[ SAVE GAME ]</div>
      <label className="flex flex-col gap-1 text-[10px] text-[hsl(var(--muted-foreground))]">
        LABEL (optional)
        <input
          aria-label="Save label"
          value={label}
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
          className="bg-transparent border border-[hsl(var(--border-bright))] px-2 py-1 text-[hsl(var(--primary))] text-xs"
        />
      </label>
      {MANUAL_SLOTS.map((slot) => {
        const info = slots.find((s) => s.slot === slot);
        return (
          <div key={slot} className="flex items-center gap-2 text-[10px]">
            <Button
              size="sm"
              aria-label={`Save to ${slotName(slot).toLowerCase()}`}
              onClick={() => saveToSlot(slot, label)}
            >
              {slotName(slot)}
            </Button>
            <span className="flex-1 truncate text-[hsl(var(--muted-foreground))]">
              {info && !info.empty && info.ok ? `${info.label} — ` : ''}
              {info ? describeSlot(info) : ''}
            </span>
          </div>
        );
      })}
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const out = exportSave();
            if (out) downloadText(out.text, out.filename);
          }}
        >
          EXPORT .JSON
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          CLOSE
        </Button>
      </div>
      {notice && (
        <div role="status" className="text-[10px] text-[hsl(var(--primary))]">
          ✔ {notice}
        </div>
      )}
    </div>
  );
}

import { useMemo, useRef } from 'react';
import { Button } from '../ui/Button.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import { slotName } from '../../stores/saveSlots.ts';
import { describeSlot, formatSavedAt } from '../game/SaveMenu.tsx';

/**
 * Setup-screen LOAD list: autosave + manual slots with label / turn / phase /
 * date, LOAD and DELETE, an IMPORT of a .json save file, and any load error.
 */
export function LoadList(): React.ReactElement {
  const listSlots = useGameStore((s) => s.listSlots);
  const loadSlot = useGameStore((s) => s.loadSlot);
  const deleteSlot = useGameStore((s) => s.deleteSlot);
  const importSave = useGameStore((s) => s.importSave);
  const loadError = useGameStore((s) => s.loadError);
  const clearLoadError = useGameStore((s) => s.clearLoadError);
  const rev = useGameStore((s) => s.saveRev);
  const slots = useMemo(() => listSlots(), [rev, listSlots]);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const text = await file.text();
    importSave(text);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="w-full max-w-[560px] border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-4 flex flex-col gap-2">
      <div className="text-[11px] text-[hsl(var(--primary))] tracking-widest">
        [ LOAD CAMPAIGN ]
      </div>
      {loadError && (
        <div
          role="alert"
          className="flex items-start gap-2 border border-[hsl(var(--destructive))] text-[hsl(var(--destructive))] text-[11px] px-2 py-1"
        >
          <span className="flex-1">✖ {loadError}</span>
          <button aria-label="Dismiss load error" onClick={() => clearLoadError()}>
            ×
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-1" aria-label="Save slots">
        {slots.map((info) => (
          <li key={info.slot} className="flex items-center gap-2 text-[10px]">
            <span className="w-[72px] shrink-0 text-[hsl(var(--muted-foreground))] tracking-widest">
              {slotName(info.slot)}
            </span>
            <span className="flex-1 min-w-0 truncate">
              {info.ok && <span className="text-[hsl(var(--primary))]">{info.label} </span>}
              <span className="text-[hsl(var(--muted-foreground))]">
                {describeSlot(info)}
                {info.ok && info.savedAt ? ` · ${formatSavedAt(info.savedAt)}` : ''}
              </span>
            </span>
            {!info.empty && (
              <>
                <Button
                  size="sm"
                  aria-label={`Load ${slotName(info.slot).toLowerCase()}`}
                  onClick={() => loadSlot(info.slot)}
                >
                  LOAD
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${slotName(info.slot).toLowerCase()}`}
                  onClick={() => deleteSlot(info.slot)}
                >
                  DELETE
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2 text-[10px] text-[hsl(var(--muted-foreground))] tracking-widest cursor-pointer">
        IMPORT SAVE (.json)
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          aria-label="Import save file"
          onChange={(e) => void onFile(e.target.files?.[0])}
          className="text-[10px]"
        />
      </label>
    </div>
  );
}

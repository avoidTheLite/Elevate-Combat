import type { GameSettings } from '@iron-ridge/engine';
import { rulesChangeCount } from '../../balance/draft.ts';
import { labEnabled, useBalanceStore } from '../../balance/store.ts';
import { Button } from '../ui/Button.tsx';

/**
 * Setup-screen footer: "Custom rules active" badge (with reset) whenever an
 * override is applied, and the BALANCE LAB entry in dev / `?lab`.
 */
export function LabEntry({
  settings,
}: {
  settings: () => GameSettings;
}): React.ReactElement | null {
  const active = useBalanceStore((s) => s.active);
  const openLab = useBalanceStore((s) => s.openLab);
  const clearActive = useBalanceStore((s) => s.clearActive);
  const enabled = labEnabled();
  if (!enabled && !active) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--border-bright))] pt-3">
      {active && (
        <span
          data-testid="custom-rules-badge"
          className="flex items-center gap-2 px-1.5 py-0.5 border border-[hsl(var(--accent))] text-[hsl(var(--accent))] text-[10px] tracking-widest"
          title="New games use the balance-lab override (settings.rules)"
        >
          ◆ CUSTOM RULES ACTIVE ({rulesChangeCount(active)})
          <button
            className="underline hover:text-[hsl(var(--destructive))]"
            onClick={clearActive}
            aria-label="Reset custom rules to baseline"
          >
            RESET
          </button>
        </span>
      )}
      {enabled && (
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openLab(settings())}>
          ⚙ BALANCE LAB
        </Button>
      )}
    </div>
  );
}

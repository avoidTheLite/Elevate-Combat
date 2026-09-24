import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils.ts';
import { usePanelStore } from '../../stores/usePanelStore.ts';

interface StackApi {
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
}

const StackContext = createContext<StackApi | null>(null);

/** Gap between a panel's header and its body (matches `gap-2`). */
const HEADER_GAP = 8;

/**
 * Scrollable column of collapsible panels. When the user expands a panel and the
 * stack no longer fits, other panels are folded in `priority` order (first = folded
 * first) until it fits again. If folding every candidate still isn't enough (small
 * screens), the stack simply scrolls — it is its own scroll container, so the map
 * beside/above it never moves.
 */
export function PanelStack({
  priority,
  children,
  className,
}: {
  priority: string[];
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const collapsed = usePanelStore((s) => s.collapsed);
  const setCollapsed = usePanelStore((s) => s.setCollapsed);
  const autoCollapse = usePanelStore((s) => s.autoCollapse);
  const setAutoCollapse = usePanelStore((s) => s.setAutoCollapse);
  const [justExpanded, setJustExpanded] = useState<string | null>(null);

  const isCollapsed = useCallback((id: string) => collapsed[id] === true, [collapsed]);
  const toggle = useCallback(
    (id: string) => {
      const opening = collapsed[id] === true;
      setCollapsed({ [id]: !opening });
      if (opening) setJustExpanded(id);
    },
    [collapsed, setCollapsed],
  );

  // After an expand has been laid out, fold other panels until the stack fits.
  useLayoutEffect(() => {
    if (!justExpanded) return;
    setJustExpanded(null);
    const el = ref.current;
    if (!el || !autoCollapse) return;
    let overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 0) return;
    const fold: Record<string, boolean> = {};
    for (const id of priority) {
      if (overflow <= 0) break;
      if (id === justExpanded || collapsed[id]) continue;
      const body = el.querySelector<HTMLElement>(`[data-panel-id="${id}"] > [data-panel-body]`);
      if (!body) continue; // panel not on screen right now
      fold[id] = true;
      overflow -= body.offsetHeight + HEADER_GAP;
    }
    if (Object.keys(fold).length) setCollapsed(fold);
  }, [justExpanded, autoCollapse, priority, collapsed, setCollapsed]);

  const setAll = (value: boolean): void =>
    setCollapsed(Object.fromEntries(priority.map((id) => [id, value])));

  return (
    <StackContext.Provider value={{ isCollapsed, toggle }}>
      <div
        ref={ref}
        className={cn(
          'h-full overflow-y-auto overscroll-contain p-2 flex flex-col gap-2',
          className,
        )}
        data-testid="panel-stack"
      >
        <div className="flex items-center justify-end gap-2 text-[9px] tracking-widest text-[hsl(var(--muted-foreground))] shrink-0">
          <label
            className="flex items-center gap-1 cursor-pointer"
            title="Fold other panels when an expanded panel would overflow"
          >
            <input
              type="checkbox"
              checked={autoCollapse}
              onChange={(e) => setAutoCollapse(e.target.checked)}
              className="accent-[hsl(var(--primary))]"
            />
            AUTO-FOLD
          </label>
          <button className="hover:text-[hsl(var(--primary))]" onClick={() => setAll(true)}>
            FOLD ALL
          </button>
          <button className="hover:text-[hsl(var(--primary))]" onClick={() => setAll(false)}>
            OPEN ALL
          </button>
        </div>
        {children}
      </div>
    </StackContext.Provider>
  );
}

export function Panel({
  id,
  title,
  children,
  className,
  bodyClassName,
  right,
}: {
  /** Stable id; enables the collapse button when inside a PanelStack. */
  id?: string;
  title: string;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  right?: React.ReactNode;
}): React.ReactElement {
  const stack = useContext(StackContext);
  const collapsible = id !== undefined && stack !== null;
  const folded = collapsible && stack.isCollapsed(id);

  return (
    <section
      data-panel-id={id}
      className={cn(
        'border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-2.5 flex flex-col gap-2 shrink-0',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2 text-[10px] tracking-widest text-[hsl(var(--primary))]">
        {collapsible ? (
          <button
            className="flex items-center gap-1.5 text-left min-w-0 hover:text-glow"
            onClick={() => stack.toggle(id)}
            aria-expanded={!folded}
            aria-label={`${folded ? 'Expand' : 'Collapse'} ${title}`}
          >
            <span className="w-3 shrink-0">{folded ? '▸' : '▾'}</span>
            <span className="truncate">[ {title} ]</span>
          </button>
        ) : (
          <span className="truncate">[ {title} ]</span>
        )}
        {right && <span className="shrink-0">{right}</span>}
      </header>
      {!folded && (
        <div data-panel-body className={cn('flex flex-col gap-2', bodyClassName)}>
          {children}
        </div>
      )}
    </section>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}): React.ReactElement {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <span className="text-[hsl(var(--muted-foreground))] shrink-0">{label}</span>
      <span className={cn('text-right truncate', tone ?? 'text-[hsl(var(--foreground))]')}>
        {value}
      </span>
    </div>
  );
}

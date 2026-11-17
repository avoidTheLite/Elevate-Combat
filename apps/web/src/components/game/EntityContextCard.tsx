import type { ReactNode } from 'react';
import type { TileEntity } from '../../lib/selection.ts';

/** All cards open on tile inspection; an explicit choice focuses one entity. */
export function EntityContextCard({
  entity,
  selectedId,
  onChoose,
  children,
}: {
  entity: TileEntity;
  selectedId: string | null;
  onChoose: () => void;
  children: ReactNode;
}): React.ReactElement {
  const expanded = selectedId === null || selectedId === entity.id;
  return (
    <section
      data-entity-id={entity.id}
      className="border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] shrink-0"
    >
      <button
        type="button"
        onClick={onChoose}
        aria-expanded={expanded}
        aria-pressed={selectedId === entity.id}
        aria-label={`Select ${entity.label}`}
        className="w-full min-h-11 p-2 text-left text-[11px] text-[hsl(var(--primary))]"
      >
        {expanded ? '▾' : '▸'} {entity.icon} {entity.label}
      </button>
      {expanded && (
        <div className="flex flex-col gap-2 p-2 pt-0" data-testid="entity-context-body">
          {children}
        </div>
      )}
    </section>
  );
}

import { cn } from '../../lib/utils.ts';

export function Panel({
  title,
  children,
  className,
  right,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  right?: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      className={cn(
        'border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-2.5 flex flex-col gap-2',
        className,
      )}
    >
      <header className="flex items-center justify-between text-[10px] tracking-widest text-[hsl(var(--primary))]">
        <span>[ {title} ]</span>
        {right}
      </header>
      {children}
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
      <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
      <span className={tone ?? 'text-[hsl(var(--foreground))]'}>{value}</span>
    </div>
  );
}

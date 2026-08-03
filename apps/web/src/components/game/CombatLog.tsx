interface Props {
  log: string[];
}

export function CombatLog({ log }: Props): React.ReactElement {
  return (
    <div className="border border-[hsl(var(--border))] p-3 font-mono text-xs h-48 overflow-y-auto">
      <div className="text-[hsl(var(--muted-foreground))] mb-1">// COMBAT LOG</div>
      {log.length === 0 ? (
        <div className="text-[hsl(var(--muted-foreground))]">No engagements yet.</div>
      ) : (
        log.map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith('---')
                ? 'text-[hsl(var(--muted-foreground))] mt-1'
                : line.includes('DIRECT HIT')
                  ? 'text-[hsl(var(--warning))]'
                  : line.includes('SPLASH HIT')
                    ? 'text-[hsl(var(--success))]'
                    : line.includes('MISS') || line.includes('DEAD') || line.includes('ZONE')
                      ? 'text-[hsl(var(--destructive))]'
                      : line.includes('damage')
                        ? 'text-[hsl(var(--primary))]'
                        : 'text-[hsl(var(--muted-foreground))]'
            }
          >
            {line || '\u00a0'}
          </div>
        ))
      )}
    </div>
  );
}

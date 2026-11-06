import { useState } from 'react';
import { serializeSave } from '@iron-ridge/engine';
import { createMovementDemo, movementDemoFocus } from '../../controls/demoScenario.ts';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';

export type HomeDestination = 'create' | 'scenario' | 'resume' | 'settings';

export function HomeScreen({
  onNavigate,
}: {
  onNavigate: (destination: HomeDestination) => void;
}): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const quickStart = (): void => {
    try {
      const game = createMovementDemo();
      const store = useGameStore.getState();
      if (store.importSave(serializeSave(game, 'Prepared initial tactical controls sandbox')))
        store.setUi(movementDemoFocus(game));
      else setError(store.loadError ?? 'Could not open tactical controls.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open tactical controls.');
    }
  };
  const entries = [
    {
      label: 'CREATE CAMPAIGN',
      icon: '◆',
      description: 'Apply a preset, then choose era, opponent, map and independent rules.',
      action: () => onNavigate('create'),
    },
    {
      label: 'PLAY SCENARIO',
      icon: '⚑',
      description: 'Choose an authored foundation scenario or the ready regular campaign.',
      action: () => onNavigate('scenario'),
    },
    {
      label: 'RESUME GAME',
      icon: '↥',
      description: 'Restore exact progress from an autosave, saved slot or imported save file.',
      action: () => onNavigate('resume'),
    },
    {
      label: 'QUICK START TACTICAL CONTROLS',
      icon: '▶',
      description:
        'Open the prepared tactical sandbox immediately to try movement, attack and unit actions.',
      action: quickStart,
    },
    {
      label: 'SETTINGS',
      icon: '⚙',
      description: 'Player control preferences for this browser.',
      action: () => onNavigate('settings'),
    },
  ];
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-4 py-8 scanlines">
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-[0.3em] text-glow">▲ IRON RIDGE</h1>
        <p className="text-xs text-[hsl(var(--muted-foreground))] tracking-widest mt-2">
          STRATEGIC + TACTICAL TRAINING SIMULATION
        </p>
      </header>
      <main
        aria-label="Home"
        className="w-full max-w-[620px] border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-4 flex flex-col gap-3"
      >
        {entries.map((entry) => (
          <div
            key={entry.label}
            className="border border-[hsl(var(--border))] p-3 flex flex-col gap-2"
          >
            <Button className="w-full justify-start gap-2 text-left" onClick={entry.action}>
              <span aria-hidden="true">{entry.icon}</span>
              {entry.label}
            </Button>
            <p className="text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
              {entry.description}
            </p>
          </div>
        ))}
        {error && (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {error}
          </p>
        )}
      </main>
      <p className="max-w-[620px] text-center text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">
        Capture the enemy HQ. Move armies on the strategic map and fight tactical battles across a
        shared hex lattice, where elevation shapes movement, line of sight and fire.
      </p>
    </div>
  );
}

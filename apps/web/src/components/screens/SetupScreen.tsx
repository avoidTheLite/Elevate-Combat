import { useState } from 'react';
import type { Controller, Era, GameSettings } from '@iron-ridge/engine';
import { GRID_LIMITS, clusterSize, defaultSettings } from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import { LoadList } from './LoadList.tsx';

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  hint?: string;
}): React.ReactElement {
  const id = `f-${props.label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-[11px]">
      <span className="text-[hsl(var(--muted-foreground))] tracking-widest">{props.label}</span>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={props.min}
          max={props.max}
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))}
          className="flex-1 accent-[hsl(var(--primary))]"
        />
        <span className="w-8 text-right text-[hsl(var(--primary))] font-bold">{props.value}</span>
      </div>
      {props.hint && (
        <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{props.hint}</span>
      )}
    </label>
  );
}

function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <span className="text-[hsl(var(--muted-foreground))] tracking-widest">{props.label}</span>
      <div className="flex gap-1 flex-wrap">
        {props.options.map((o) => (
          <Button
            key={o.value}
            size="sm"
            variant={props.value === o.value ? 'default' : 'ghost'}
            onClick={() => props.onChange(o.value)}
            aria-pressed={props.value === o.value}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

type Mode = 'ai' | 'hotseat' | 'spectate';

export function SetupScreen(): React.ReactElement {
  const newGame = useGameStore((s) => s.newGame);
  const loadSaved = useGameStore((s) => s.loadSaved);
  useGameStore((s) => s.saveRev); // re-render when a slot changes (CONTINUE visibility)
  const hasSave = useGameStore((s) => s.hasSave)();
  const [settings, setSettings] = useState<GameSettings>(defaultSettings());
  const [mode, setMode] = useState<Mode>('ai');

  const g = settings.grid;
  const perMain = clusterSize(g.subRadius);
  const total = perMain * g.mainCols * g.mainRows;
  const setGrid = (patch: Partial<GameSettings['grid']>): void =>
    setSettings({ ...settings, grid: { ...settings.grid, ...patch } });

  const start = (): void => {
    const controllers: Record<'A' | 'B', Controller> =
      mode === 'ai'
        ? { A: 'human', B: 'ai' }
        : mode === 'hotseat'
          ? { A: 'human', B: 'human' }
          : { A: 'ai', B: 'ai' };
    newGame({ ...settings, controllers });
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-4 scanlines">
      <div className="text-center">
        <div className="text-3xl font-bold tracking-[0.4em] text-glow">▲ IRON RIDGE</div>
        <div className="text-[hsl(var(--muted-foreground))] text-xs tracking-widest mt-1">
          // TRAINING SIMULATION :: V0.9 :: STRATEGIC + TACTICAL
        </div>
      </div>

      <div className="w-full max-w-[560px] border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-4 flex flex-col gap-4">
        <div className="text-[11px] text-[hsl(var(--primary))] tracking-widest">
          [ NEW CAMPAIGN ]
        </div>

        <Choice<Era>
          label="ERA"
          value={settings.era}
          options={[
            { value: 'ww2', label: 'WW2' },
            { value: 'medieval', label: 'MEDIEVAL' },
          ]}
          onChange={(era) => setSettings({ ...settings, era })}
        />
        <Choice<Mode>
          label="OPPONENT"
          value={mode}
          options={[
            { value: 'ai', label: 'VS AI' },
            { value: 'hotseat', label: 'HOTSEAT 2P' },
            { value: 'spectate', label: 'AI vs AI' },
          ]}
          onChange={setMode}
        />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <NumberField
            label="MAIN COLS"
            value={g.mainCols}
            min={GRID_LIMITS.mainCols.min}
            max={GRID_LIMITS.mainCols.max}
            onChange={(v) => setGrid({ mainCols: v })}
          />
          <NumberField
            label="MAIN ROWS"
            value={g.mainRows}
            min={GRID_LIMITS.mainRows.min}
            max={GRID_LIMITS.mainRows.max}
            onChange={(v) => setGrid({ mainRows: v })}
          />
          <NumberField
            label="SUB-GRID RADIUS"
            value={g.subRadius}
            min={GRID_LIMITS.subRadius.min}
            max={GRID_LIMITS.subRadius.max}
            onChange={(v) => setGrid({ subRadius: v })}
          />
        </div>
        <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
          {g.mainCols}×{g.mainRows} main hexes · {perMain} sub-hexes each · {total.toLocaleString()}{' '}
          tactical cells. Every main hex is a radius-{g.subRadius} cluster on one shared sub-hex
          lattice, so sub-hexes line up exactly across every main-hex border.
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <NumberField
            label="BATTLE ROUND LIMIT"
            value={settings.battleRounds}
            min={4}
            max={20}
            onChange={(v) => setSettings({ ...settings, battleRounds: v })}
          />
          <label className="flex flex-col gap-1 text-[11px]" htmlFor="f-seed">
            <span className="text-[hsl(var(--muted-foreground))] tracking-widest">MAP SEED</span>
            <div className="flex gap-2">
              <input
                id="f-seed"
                type="number"
                value={settings.seed}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    seed: Math.abs(Math.floor(Number(e.target.value) || 0)),
                  })
                }
                className="flex-1 bg-transparent border border-[hsl(var(--border-bright))] px-2 py-1 text-[hsl(var(--primary))]"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSettings({ ...settings, seed: Math.floor(Math.random() * 1e6) })}
              >
                RANDOM
              </Button>
            </div>
          </label>
        </div>

        <label className="flex items-center gap-2 text-[11px] cursor-pointer">
          <input
            type="checkbox"
            checked={settings.fog}
            onChange={(e) => setSettings({ ...settings, fog: e.target.checked })}
            className="accent-[hsl(var(--primary))]"
          />
          <span className="tracking-widest text-[hsl(var(--muted-foreground))]">
            FOG OF WAR (LOS-based spotting)
          </span>
        </label>

        <div className="flex gap-2 pt-1">
          <Button size="lg" onClick={start} className="flex-1">
            START NEW GAME
          </Button>
          {hasSave && (
            <Button size="lg" variant="ghost" onClick={() => loadSaved()}>
              CONTINUE
            </Button>
          )}
        </div>
      </div>

      <LoadList />

      <div className="text-[10px] text-[hsl(var(--muted-foreground))] max-w-[560px] text-center leading-4">
        Capture the enemy HQ. Move armies across the strategic hex map; attacking an occupied hex
        opens a tactical battle on the sub-hex grid of that hex and its neighbours. Elevation drives
        line of sight, movement and fire.
      </div>
    </div>
  );
}

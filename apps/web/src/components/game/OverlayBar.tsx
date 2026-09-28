import { useEffect } from 'react';
import type { Team } from '@iron-ridge/engine';
import { TEAM_NAME } from '@iron-ridge/engine';
import type { LegendItem } from '../../render/overlays.ts';
import {
  BASIC_LINE,
  CAPTURE_COLOR,
  OVERLAYS,
  controlColors,
  heightLegend,
} from '../../render/overlays.ts';
import { TEAM_COLOR } from '../../render/spec.ts';
import { useViewStore } from '../../stores/useViewStore.ts';
import { Button } from '../ui/Button.tsx';

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

function legendFor(
  mode: string,
  battle: { attacker: Team; contested: string } | null,
): { items: LegendItem[]; note: string } {
  if (mode === 'height')
    return { items: heightLegend(), note: 'Elevation drives LOS, movement and range.' };
  if (mode === 'control') {
    if (battle) {
      return {
        items: [
          { color: CAPTURE_COLOR, label: `Capture point ${battle.contested}` },
          {
            color: TEAM_COLOR[battle.attacker],
            label: `${TEAM_NAME[battle.attacker]} staging hex`,
          },
          { color: controlColors({ kind: 'none' }).line, label: 'Flanking ground' },
        ],
        note: 'Attacker must clear and hold the capture point by the round limit.',
      };
    }
    return {
      items: [
        { color: TEAM_COLOR.A, label: `${TEAM_NAME.A} territory` },
        { color: TEAM_COLOR.B, label: `${TEAM_NAME.B} territory` },
        { color: controlColors({ kind: 'none' }).line, label: 'Neutral' },
      ],
      note: 'Take the enemy HQ to win.',
    };
  }
  return {
    items: [{ color: BASIC_LINE, label: 'Terrain (relief from 3D shape)' }],
    note: battle ? 'Orange outline = capture point.' : 'Coloured outlines = territory frontiers.',
  };
}

/** Map-mode switcher + legend, overlaid on the top-left of the 3D view. Keys 1–3. */
export function OverlayBar({
  battle,
}: {
  battle: { attacker: Team; contested: string } | null;
}): React.ReactElement {
  const overlay = useViewStore((s) => s.overlay);
  const setOverlay = useViewStore((s) => s.setOverlay);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const def = OVERLAYS.find((o) => o.key === e.key);
      if (def) setOverlay(def.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOverlay]);

  const legend = legendFor(overlay, battle);

  return (
    <div className="absolute left-2 top-2 flex flex-col gap-1 pointer-events-none max-w-[60%]">
      <div
        className="flex gap-1 pointer-events-auto flex-wrap"
        role="group"
        aria-label="Map overlay"
      >
        {OVERLAYS.map((o) => (
          <Button
            key={o.id}
            size="sm"
            variant={overlay === o.id ? 'default' : 'ghost'}
            aria-pressed={overlay === o.id}
            title={`${o.description} (${o.key})`}
            onClick={() => setOverlay(o.id)}
            className="bg-[hsl(var(--panel)/0.85)]"
          >
            {o.key} {o.label}
          </Button>
        ))}
      </div>
      <div
        className="bg-[hsl(var(--panel)/0.85)] border border-[hsl(var(--border-bright))] px-2 py-1 text-[9px] leading-4 w-max max-w-full"
        data-testid="overlay-legend"
      >
        <ul className={overlay === 'height' ? 'grid grid-cols-3 gap-x-2' : 'flex flex-col'}>
          {legend.items.map((it) => (
            <li key={it.label} className="flex items-center gap-1 whitespace-nowrap">
              <span
                className="inline-block w-2.5 h-2.5 border"
                style={{ borderColor: hex(it.color), background: `${hex(it.color)}55` }}
              />
              <span className="text-[hsl(var(--muted-foreground))]">{it.label}</span>
            </li>
          ))}
        </ul>
        <div className="text-[hsl(var(--muted-foreground))] mt-0.5">{legend.note}</div>
      </div>
    </div>
  );
}

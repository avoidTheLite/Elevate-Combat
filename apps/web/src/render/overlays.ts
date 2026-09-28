// ── Information overlays (map modes) ─────────────────────────────────────────
// The renderer paints whatever fill/line colour each cell is given; this module
// decides those colours per overlay mode. Outlines that carry rules meaning
// (capture point, main-hex borders, territory frontiers) are border layers and
// stay visible in every mode.

import type { Team } from '@iron-ridge/engine';
import { TEAM_COLOR } from './spec.ts';

export type OverlayMode = 'basic' | 'height' | 'control';

export interface OverlayDef {
  id: OverlayMode;
  label: string;
  key: string; // keyboard shortcut
  description: string;
}

export const OVERLAYS: OverlayDef[] = [
  {
    id: 'basic',
    label: 'BASIC',
    key: '1',
    description: 'Neutral terrain — relief from the 3D shape only',
  },
  { id: 'height', label: 'HEIGHT', key: '2', description: 'Elevation colour ramp (H0–H8)' },
  { id: 'control', label: 'CONTROL', key: '3', description: 'Capture point and territory control' },
];

// Neutral base: one tone for every cell; lighting on the prism sides shows relief.
export const BASIC_FILL = 0x0a2236;
export const BASIC_LINE = 0x1d5f7c;

// Elevation ramp (index = height 0..8): deep violet valleys → cyan highs → amber peak.
export const HEIGHT_FILL = [
  0x05071c, 0x07112c, 0x091d3c, 0x0b2a4b, 0x0d3958, 0x104a64, 0x15606e, 0x1e7a76, 0x6a4a0c,
];
export const HEIGHT_LINE = [
  0x2c2c80, 0x2b4198, 0x2a5eb2, 0x2a7ec8, 0x22a0dc, 0x20c2e8, 0x44e2e0, 0x9cfff0, 0xffc030,
];
export const HEIGHT_NAMES = [
  'Marsh',
  'Valley',
  'Defile',
  'Slope',
  'Plateau',
  'Hi plateau',
  'Ridge lo',
  'Ridge hi',
  'Peak',
];

export const CAPTURE_COLOR = 0xffa030;

export interface CellColors {
  fill: number;
  line: number;
}

function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number): number => (c >> s) & 255;
  const lerp = (s: number): number => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (lerp(16) << 16) | (lerp(8) << 8) | lerp(0);
}

export function heightColors(h: number): CellColors {
  const i = Math.max(0, Math.min(8, h));
  return { fill: HEIGHT_FILL[i]!, line: HEIGHT_LINE[i]! };
}

export const basicColors: CellColors = { fill: BASIC_FILL, line: BASIC_LINE };

/** Control overlay: a cell's highlight role → colours. */
export type ControlRole = { kind: 'capture' } | { kind: 'team'; team: Team } | { kind: 'none' };

export function controlColors(role: ControlRole): CellColors {
  switch (role.kind) {
    case 'capture':
      return {
        fill: mix(BASIC_FILL, CAPTURE_COLOR, 0.38),
        line: mix(BASIC_LINE, CAPTURE_COLOR, 0.8),
      };
    case 'team':
      return {
        fill: mix(BASIC_FILL, TEAM_COLOR[role.team], 0.3),
        line: mix(BASIC_LINE, TEAM_COLOR[role.team], 0.7),
      };
    default:
      return { fill: mix(BASIC_FILL, 0x000000, 0.25), line: mix(BASIC_LINE, 0x000000, 0.35) };
  }
}

export interface LegendItem {
  color: number;
  label: string;
}

export function heightLegend(): LegendItem[] {
  return HEIGHT_LINE.map((color, h) => ({ color, label: `H${h} ${HEIGHT_NAMES[h]}` }));
}

export function isOverlayMode(v: unknown): v is OverlayMode {
  return v === 'basic' || v === 'height' || v === 'control';
}

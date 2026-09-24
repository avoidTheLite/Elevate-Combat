// ── Declarative scene description handed to HexScene each frame-of-state ─────

import type { Era, LosStatus, Team } from '@iron-ridge/engine';

export interface CellSpec {
  key: string;
  q: number;
  r: number;
  h: number;
  /** Top/side fill and top-outline colours — chosen by the active overlay (overlays.ts). */
  fill: number;
  line: number;
  /** Fogged / out-of-play cells are drawn darker. */
  dim?: boolean;
  fort?: number;
}

export interface OverlaySpec {
  key: string;
  color: number;
  opacity: number;
}

export type TokenKind =
  'infantry' | 'cavalry' | 'vehicle' | 'artillery' | 'engineer' | 'army' | 'hq';

export interface TokenSpec {
  id: string;
  key: string;
  kind: TokenKind;
  team: Team;
  label: string;
  sub?: string;
  hpFrac?: number;
  facing?: number;
  /** Unit type id — selects the detailed unit model (tactical units). */
  model?: string;
  /** Strategic army: era + unit roster, rendered as a commander cluster. */
  army?: { era: Era; units: string[] };
  /** Heading in the world group's local frame (radians, atan2(z, x)); 0 = +X. */
  yaw?: number;
  /** Can still act this turn (glow). Undefined = always glow (HQ beacons). */
  ready?: boolean;
  selected?: boolean;
  spent?: boolean;
  scale?: number;
  badge?: string;
}

export interface TrajectorySpec {
  from: string;
  to: string;
  status: LosStatus;
  indirect: boolean;
  eye: number;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Segment3 {
  a: Point3;
  b: Point3;
}

export interface BorderLayer {
  /** World-space (unrotated) 3D line segments. Horizontal edges plus vertical connectors. */
  segments: Segment3[];
  color: number;
  width: number;
  opacity?: number;
}

export interface SceneSpec {
  terrainId: string;
  cells: CellSpec[];
  overlays: OverlaySpec[];
  borders: BorderLayer[];
  tokens: TokenSpec[];
  path: string[];
  trajectory: TrajectorySpec | null;
  /** Rotation (radians) that squares the main grid to the screen. */
  worldRotation: number;
  fireView: { from: string; to: string } | null;
}

export const TEAM_COLOR: Record<Team, number> = { A: 0x00f0ff, B: 0xff3366 };
export const HEIGHT_SCALE = 0.42;
export const BASE_HEIGHT = 0.3;

export function topY(h: number): number {
  return BASE_HEIGHT + h * HEIGHT_SCALE;
}

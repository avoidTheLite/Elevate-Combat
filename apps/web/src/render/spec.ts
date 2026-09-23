// ── Declarative scene description handed to HexScene each frame-of-state ─────

import type { LosStatus, Team } from '@iron-ridge/engine';

export interface CellSpec {
  key: string;
  q: number;
  r: number;
  h: number;
  /** Optional tint mixed into the terrain fill (e.g. territory owner). */
  tint?: number | null;
  tintAmount?: number;
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

export interface BorderLayer {
  /** World-space (unrotated) segments as [x1,z1,x2,z2,...] with a y per segment. */
  segments: { ax: number; az: number; bx: number; bz: number; y: number }[];
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

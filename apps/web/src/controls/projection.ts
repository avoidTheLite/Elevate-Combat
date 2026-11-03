import type { SceneTileAnchor } from './types.ts';

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Proposed demo calibration: one tile at 10 across, seven tiles at 50 across. */
export function dragOriginExpansion(visibleTilesAcross: number): number {
  return Math.max(0, Math.min(1, (visibleTilesAcross - 10) / 40));
}

export function pointInPolygon(point: ScreenPoint, polygon: readonly ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!;
    const b = polygon[i]!;
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (
      Math.abs(cross) < 1e-6 &&
      point.x >= Math.min(a.x, b.x) - 1e-6 &&
      point.x <= Math.max(a.x, b.x) + 1e-6 &&
      point.y >= Math.min(a.y, b.y) - 1e-6 &&
      point.y <= Math.max(a.y, b.y) + 1e-6
    )
      return true;
    if (
      b.y > point.y !== a.y > point.y &&
      point.x < ((a.x - b.x) * (point.y - b.y)) / (a.y - b.y) + b.x
    )
      inside = !inside;
  }
  return inside;
}

/** This tolerance is exclusively for an already-selected unit's drag origin. */
export function selectedDragOriginContains(input: {
  selectedKey: string;
  hitKey: string | null;
  protectedKeys: readonly string[];
  pointer: ScreenPoint;
  selectedPolygon: readonly ScreenPoint[];
  neighborPolygons: readonly (readonly ScreenPoint[])[];
  visibleTilesAcross: number;
}): boolean {
  if (
    input.hitKey &&
    input.hitKey !== input.selectedKey &&
    input.protectedKeys.includes(input.hitKey)
  )
    return false;
  if (input.hitKey === input.selectedKey) return true;
  if (pointInPolygon(input.pointer, input.selectedPolygon)) return true;
  const expansion = dragOriginExpansion(input.visibleTilesAcross);
  if (expansion === 0) return false;
  return input.neighborPolygons.some((polygon) => {
    if (polygon.length !== input.selectedPolygon.length) return false;
    const expanded = polygon.map((p, i) => ({
      x: input.selectedPolygon[i]!.x + (p.x - input.selectedPolygon[i]!.x) * expansion,
      y: input.selectedPolygon[i]!.y + (p.y - input.selectedPolygon[i]!.y) * expansion,
    }));
    return pointInPolygon(input.pointer, expanded);
  });
}

export function projectedTileAnchor(
  key: string,
  center: ScreenPoint,
  corners: readonly ScreenPoint[],
): SceneTileAnchor | null {
  if (
    !corners.length ||
    ![center, ...corners].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  )
    return null;
  return {
    key,
    x: center.x,
    y: center.y,
    radius: Math.max(...corners.map((p) => Math.hypot(p.x - center.x, p.y - center.y))),
    width: Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x)),
    height: Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y)),
  };
}

/** Camera motion updates anchors; identical React renders do not trigger a loop. */
export function sameTileLayout(
  a: readonly SceneTileAnchor[],
  b: readonly SceneTileAnchor[],
  epsilon = 0.2,
): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i]!;
      return (
        p.key === q.key &&
        (['x', 'y', 'radius', 'width', 'height'] as const).every(
          (key) => Math.abs(p[key] - q[key]) <= epsilon,
        )
      );
    })
  );
}

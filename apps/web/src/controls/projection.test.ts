import { describe, expect, it } from 'vitest';
import {
  dragOriginExpansion,
  pointInPolygon,
  projectedTileAnchor,
  sameTileLayout,
  selectedDragOriginContains,
} from './projection.ts';
import type { ScreenPoint } from './projection.ts';

const hex = (x = 0, y = 0): ScreenPoint[] =>
  Array.from({ length: 6 }, (_, i) => ({
    x: x + Math.cos((i * Math.PI) / 3) * 10,
    y: y + Math.sin((i * Math.PI) / 3) * 10,
  }));
const selected = hex();
const neighbors = [
  hex(15, 8.66),
  hex(0, 17.32),
  hex(-15, 8.66),
  hex(-15, -8.66),
  hex(0, -17.32),
  hex(15, -8.66),
];

function contains(
  pointer: ScreenPoint,
  across: number,
  hitKey: string | null = null,
  protectedKeys: string[] = [],
): boolean {
  return selectedDragOriginContains({
    selectedKey: '0,0',
    hitKey,
    protectedKeys,
    pointer,
    selectedPolygon: selected,
    neighborPolygons: neighbors,
    visibleTilesAcross: across,
  });
}

describe('selected-unit-only drag origin calibration', () => {
  it('requires the selected tile at close zoom and expands to all six neighbors at far zoom', () => {
    expect(contains({ x: 0, y: 0 }, 10)).toBe(true);
    for (const center of [
      { x: 15, y: 8.66 },
      { x: 0, y: 17.32 },
      { x: -15, y: 8.66 },
      { x: -15, y: -8.66 },
      { x: 0, y: -17.32 },
      { x: 15, y: -8.66 },
    ]) {
      expect(contains(center, 10)).toBe(false);
      expect(contains(center, 50)).toBe(true);
    }
    expect(contains({ x: 45, y: 0 }, 50)).toBe(false);
  });

  it('interpolates and clamps the proposed zoom calibration without a global pick radius', () => {
    expect(dragOriginExpansion(1)).toBe(0);
    expect(dragOriginExpansion(10)).toBe(0);
    expect(dragOriginExpansion(30)).toBe(0.5);
    expect(dragOriginExpansion(50)).toBe(1);
    expect(dragOriginExpansion(200)).toBe(1);
  });

  it('protects another unit body at every zoom, while accepting the selected model', () => {
    expect(contains({ x: 15, y: 8.66 }, 50, '1,0', ['1,0'])).toBe(false);
    expect(contains({ x: 15, y: 8.66 }, 10, '0,0')).toBe(true);
    expect(contains({ x: 0, y: 0 }, 50, '1,0', ['1,0'])).toBe(false);
  });

  it('includes polygon edges without admitting outside points', () => {
    expect(pointInPolygon({ x: 10, y: 0 }, selected)).toBe(true);
    expect(pointInPolygon({ x: 10.1, y: 0 }, selected)).toBe(false);
  });
});

describe('projected callout layout', () => {
  it('provides local tile dimensions for overlap and rejects invalid projection coordinates', () => {
    const anchor = projectedTileAnchor('0,0', { x: 0, y: 0 }, selected)!;
    expect(anchor).toMatchObject({ key: '0,0', x: 0, y: 0, radius: 10, width: 20 });
    expect(anchor.height).toBeCloseTo(17.3205);
    expect(projectedTileAnchor('0,0', { x: Infinity, y: 0 }, selected)).toBeNull();
  });

  it('updates for camera motion or tracked-key changes but ignores subpixel jitter', () => {
    const anchor = projectedTileAnchor('0,0', { x: 0, y: 0 }, selected)!;
    expect(sameTileLayout([anchor], [{ ...anchor, x: 0.1 }])).toBe(true);
    expect(sameTileLayout([anchor], [{ ...anchor, x: 1 }])).toBe(false);
    expect(sameTileLayout([anchor], [{ ...anchor, key: '1,0' }])).toBe(false);
    expect(sameTileLayout([anchor], [])).toBe(false);
  });
});

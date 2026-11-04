import { describe, expect, it } from 'vitest';
import { bridgeSegments, calloutBridge, placeCallouts } from './calloutLayout.ts';
import type { CalloutRect } from './calloutLayout.ts';
import type { SceneTileAnchor } from './types.ts';

const anchor = (key: string, x: number, y: number): SceneTileAnchor => ({
  key,
  x,
  y,
  width: 60,
  height: 45,
  radius: 30,
});
const covers = (rect: CalloutRect, point: SceneTileAnchor): boolean =>
  point.x >= rect.left &&
  point.x <= rect.left + rect.width &&
  point.y >= rect.top &&
  point.y <= rect.top + rect.height;
const overlaps = (a: CalloutRect, b: CalloutRect): boolean =>
  a.left < b.left + b.width &&
  a.left + a.width > b.left &&
  a.top < b.top + b.height &&
  a.top + a.height > b.top;

describe('proposed collision-aware callout placement', () => {
  it('keeps tiny overview tile cards locally detached instead of jumping to viewport corners', () => {
    const tile = { ...anchor('tiny', 500, 380), width: 23, height: 18, radius: 12 };
    const rect = placeCallouts(
      [{ id: 'selected', selected: true, width: 260, height: 140, anchor: tile }],
      [tile],
      { width: 1000, height: 700 },
      25,
    ).selected!;
    expect(rect.left + rect.width).toBe(481);
    expect(rect.top).toBe(310);
    expect(covers(rect, tile)).toBe(false);
  });

  it('aligns a detached hover corridor with a tile-to-card-center pointer journey', () => {
    const tile = anchor('tile', 290, 389);
    const card = { left: 8, top: 82, width: 260, height: 156 };
    const bridge = calloutBridge(tile, card)!;
    const center = { x: 138, y: 160 };
    for (const point of [
      { x: bridge.x1, y: bridge.y1 },
      { x: bridge.x2, y: bridge.y2 },
    ]) {
      const cross =
        (point.x - tile.x) * (center.y - tile.y) - (point.y - tile.y) * (center.x - tile.x);
      expect(Math.abs(cross)).toBeLessThan(0.00001);
    }
  });
  it('cuts detached hover bridges around every real unit body instead of stealing canvas input', () => {
    const segments = bridgeSegments({ x1: 0, y1: 100, x2: 300, y2: 100 }, [
      anchor('unit', 150, 100),
    ]);
    expect(segments).toEqual([
      { x1: 0, y1: 100, x2: 124, y2: 100 },
      { x1: 176, y1: 100, x2: 300, y2: 100 },
    ]);
  });
  it('keeps portrait mobile source/target centers and both cards clear when tile-side placement cannot fit', () => {
    const selected = anchor('selected', 195, 320);
    const target = anchor('target', 235, 345);
    const result = placeCallouts(
      [
        { id: 'selected', selected: true, width: 228, height: 140, anchor: selected },
        { id: 'target', selected: false, width: 228, height: 250, anchor: target },
      ],
      [selected, target],
      { width: 390, height: 650 },
      25,
    );
    expect(overlaps(result.selected!, result.target!)).toBe(false);
    for (const rect of Object.values(result)) {
      expect(covers(rect, selected)).toBe(false);
      expect(covers(rect, target)).toBe(false);
      expect(rect.left).toBeGreaterThanOrEqual(8);
      expect(rect.left + rect.width).toBeLessThanOrEqual(382);
      expect(rect.top + rect.height).toBeLessThanOrEqual(596);
    }
  });

  it('chooses a different desktop side when the preferred card would cover an actual enemy body', () => {
    const selected = anchor('selected', 560, 420);
    const enemy = anchor('enemy', 430, 420);
    const result = placeCallouts(
      [{ id: 'selected', selected: true, width: 260, height: 125, anchor: selected }],
      [selected, enemy],
      { width: 1000, height: 700 },
      25,
    );
    expect(covers(result.selected!, selected)).toBe(false);
    expect(covers(result.selected!, enemy)).toBe(false);
  });
});

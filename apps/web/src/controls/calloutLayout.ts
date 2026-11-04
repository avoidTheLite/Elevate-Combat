import type { SceneTileAnchor } from './types.ts';

export interface CalloutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface CalloutBox {
  id: string;
  width: number;
  height: number;
  anchor?: SceneTileAnchor;
  selected: boolean;
}

export interface BridgeSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The corridor follows a natural tile-center → card-center pointer journey. */
export function calloutBridge(anchor: SceneTileAnchor, rect: CalloutRect): BridgeSegment | null {
  const dx = rect.left + rect.width / 2 - anchor.x;
  const dy = rect.top + rect.height / 2 - anchor.y;
  const length = Math.hypot(dx, dy);
  const ratio = (size: number, delta: number): number =>
    Math.abs(delta) > 0.001 ? size / Math.abs(delta) : Infinity;
  const start =
    Math.min(ratio(anchor.width / 2, dx), ratio(anchor.height / 2, dy)) + 9 / Math.max(1, length);
  const end = 1 - Math.min(ratio(rect.width / 2, dx), ratio(rect.height / 2, dy));
  return start < end
    ? {
        x1: anchor.x + dx * start,
        y1: anchor.y + dy * start,
        x2: anchor.x + dx * end,
        y2: anchor.y + dy * end,
      }
    : null;
}

/** Leave actual unit bodies available to the canvas, even across a detached hover corridor. */
export function bridgeSegments(
  segment: BridgeSegment,
  anchors: readonly SceneTileAnchor[],
): BridgeSegment[] {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const cuts: [number, number][] = [];
  for (const anchor of anchors) {
    // 18px body + half the 16px bridge stroke; butt-ended segments stop outside it.
    const radius = 26;
    let lo = 0;
    let hi = 1;
    for (const [start, delta, center] of [
      [segment.x1, dx, anchor.x],
      [segment.y1, dy, anchor.y],
    ]) {
      if (Math.abs(delta!) < 0.001) {
        if (Math.abs(start! - center!) > radius) {
          hi = -1;
          break;
        }
      } else {
        const a = (center! - radius - start!) / delta!;
        const b = (center! + radius - start!) / delta!;
        lo = Math.max(lo, Math.min(a, b));
        hi = Math.min(hi, Math.max(a, b));
      }
    }
    if (lo < hi) cuts.push([lo, hi]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  let start = 0;
  for (const [lo, hi] of cuts) {
    if (lo > start) ranges.push([start, lo]);
    start = Math.max(start, hi);
  }
  if (start < 1) ranges.push([start, 1]);
  return ranges.map(([a, b]) => ({
    x1: segment.x1 + dx * a,
    y1: segment.y1 + dy * a,
    x2: segment.x1 + dx * b,
    y2: segment.y1 + dy * b,
  }));
}

const intersectArea = (a: CalloutRect, b: CalloutRect): number =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/** Proposed placement: prefer tile overlap, then detach to keep bodies and cards usable. */
export function placeCallouts(
  boxes: readonly CalloutBox[],
  anchors: readonly SceneTileAnchor[],
  viewport: { width: number; height: number },
  overlap: number,
): Record<string, CalloutRect> {
  const top = viewport.width < 768 ? 90 : 82;
  const bottom = Math.max(top + 1, viewport.height - 54);
  const makeCandidates = (box: CalloutBox): CalloutRect[] => {
    const { width, height, anchor } = box;
    const x = anchor?.x ?? viewport.width / 2;
    const y = anchor?.y ?? viewport.height / 2;
    const dx = (anchor?.width ?? 40) * (0.5 - overlap / 100);
    const dy = (anchor?.height ?? 40) * (0.5 - overlap / 100);
    const right = { left: x + dx, top: y - height / 2 };
    const left = { left: x - dx - width, top: y - height / 2 };
    const points = [
      ...(box.selected ? [left, right] : [right, left]),
      { left: x - width / 2, top: y - dy - height },
      { left: x - width / 2, top: y + dy },
      // At overview zoom, 25% overlap may touch the protected unit body.
      // Prefer a small local gap before moving the entire card to a far corner.
      ...(box.selected
        ? [
            { left: x - 19 - width, top: y - height / 2 },
            { left: x + 19, top: y - height / 2 },
          ]
        : [
            { left: x + 19, top: y - height / 2 },
            { left: x - 19 - width, top: y - height / 2 },
          ]),
      { left: x - width / 2, top: y - 19 - height },
      { left: x - width / 2, top: y + 19 },
      { left: 8, top },
      { left: viewport.width - width - 8, top },
      { left: 8, top: bottom - height },
      { left: viewport.width - width - 8, top: bottom - height },
    ];
    return points.map((point) => ({
      width,
      height,
      left: Math.max(8, Math.min(point.left, viewport.width - width - 8)),
      top: Math.max(top, Math.min(point.top, bottom - height)),
    }));
  };
  const candidates = boxes.map(makeCandidates);
  let bestScore = Infinity;
  let best: CalloutRect[] = [];
  const scoreRect = (rect: CalloutRect, box: CalloutBox, index: number): number => {
    let score = index * 50;
    for (const anchor of anchors) {
      if (anchor.x < 0 || anchor.y < 0 || anchor.x > viewport.width || anchor.y > viewport.height)
        continue;
      const critical = boxes.some((candidate) => candidate.anchor?.key === anchor.key);
      const radius = critical ? 15 : 10;
      const area = intersectArea(rect, {
        left: anchor.x - radius,
        top: anchor.y - radius,
        width: radius * 2,
        height: radius * 2,
      });
      if (area) score += (critical ? 1e10 : 1e6) + area * 1000;
    }
    if (box.anchor)
      score +=
        Math.hypot(
          rect.left + rect.width / 2 - box.anchor.x,
          rect.top + rect.height / 2 - box.anchor.y,
        ) * 0.1;
    return score;
  };
  const visit = (index: number, chosen: CalloutRect[], score: number): void => {
    if (index === boxes.length) {
      if (score < bestScore) {
        bestScore = score;
        best = chosen;
      }
      return;
    }
    candidates[index]!.forEach((rect, candidateIndex) => {
      let next = score + scoreRect(rect, boxes[index]!, candidateIndex);
      for (const other of chosen) {
        const area = intersectArea(
          {
            ...rect,
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          },
          other,
        );
        if (area) next += 1e9 + area * 10000;
      }
      if (next < bestScore) visit(index + 1, [...chosen, rect], next);
    });
  };
  visit(0, [], 0);
  return Object.fromEntries(boxes.map((box, index) => [box.id, best[index]!]));
}

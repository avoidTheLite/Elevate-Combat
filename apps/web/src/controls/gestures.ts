import type { SceneInteraction } from './types.ts';

export const DRAG_START_DISTANCE = 5;

export interface PointerSample {
  pointerId: number;
  x: number;
  y: number;
  button: number;
  pointerType: string;
  key: string | null;
}

export interface PointerGesture {
  pointerId: number;
  x: number;
  y: number;
  button: number;
  pointerType: string;
  originKey: string | null;
  commandOriginKey: string | null;
  mode: 'pending' | 'pan' | 'command';
}

export function beginPointerGesture(
  sample: PointerSample,
  commandOriginKey: string | null,
): PointerGesture {
  return {
    pointerId: sample.pointerId,
    x: sample.x,
    y: sample.y,
    button: sample.button,
    pointerType: sample.pointerType,
    originKey: sample.key,
    commandOriginKey: sample.button === 0 ? commandOriginKey : null,
    mode: 'pending',
  };
}

/** A press remains an ordinary click until it crosses the drag threshold. */
export function advancePointerGesture(
  gesture: PointerGesture,
  sample: PointerSample,
): {
  gesture: PointerGesture;
  pan: { dx: number; dy: number } | null;
  interaction: SceneInteraction | null;
} {
  if (gesture.pointerId !== sample.pointerId) return { gesture, pan: null, interaction: null };
  const dx = sample.x - gesture.x;
  const dy = sample.y - gesture.y;
  if (gesture.mode === 'pending' && Math.hypot(dx, dy) <= DRAG_START_DISTANCE)
    return { gesture, pan: null, interaction: null };
  const mode = gesture.commandOriginKey ? 'command' : 'pan';
  const next: PointerGesture = { ...gesture, mode, x: sample.x, y: sample.y };
  return {
    gesture: next,
    pan: mode === 'pan' ? { dx, dy } : null,
    interaction:
      mode === 'command'
        ? {
            source: 'drag',
            stage: gesture.mode === 'pending' ? 'start' : 'move',
            originKey: gesture.commandOriginKey,
            targetKey: sample.key,
            button: gesture.button,
            pointerType: gesture.pointerType,
          }
        : null,
  };
}

export function finishPointerGesture(
  gesture: PointerGesture,
  sample: PointerSample,
): SceneInteraction | null {
  if (gesture.pointerId !== sample.pointerId || gesture.mode === 'pan' || gesture.button === 1)
    return null;
  return {
    source: gesture.mode === 'command' ? 'drag' : 'click',
    ...(gesture.mode === 'command' ? { stage: 'end' as const } : {}),
    originKey: gesture.mode === 'command' ? gesture.commandOriginKey : gesture.originKey,
    targetKey: sample.key,
    button: gesture.button,
    pointerType: gesture.pointerType,
  };
}

export function cancelPointerGesture(gesture: PointerGesture | null): SceneInteraction | null {
  return gesture?.mode === 'command'
    ? {
        source: 'drag',
        stage: 'cancel',
        originKey: gesture.commandOriginKey,
        targetKey: null,
        button: gesture.button,
        pointerType: gesture.pointerType,
      }
    : null;
}

export function isInteractiveKeyTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      'input, select, textarea, button, a, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="slider"]',
    )
  );
}

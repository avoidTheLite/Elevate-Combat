import { describe, expect, it } from 'vitest';
import {
  advancePointerGesture,
  beginPointerGesture,
  cancelPointerGesture,
  finishPointerGesture,
  isInteractiveKeyTarget,
} from './gestures.ts';
import type { PointerSample } from './gestures.ts';

function sample(overrides: Partial<PointerSample> = {}): PointerSample {
  return {
    pointerId: 1,
    x: 100,
    y: 100,
    button: 0,
    pointerType: 'mouse',
    key: '0,0',
    ...overrides,
  };
}

describe('map pointer gesture routing', () => {
  it('a press inside the expanded drag area remains an ordinary click before dragging', () => {
    const down = sample({ key: '1,0' });
    const press = beginPointerGesture(down, '0,0');
    const moved = advancePointerGesture(press, sample({ x: 103, key: '1,0' }));
    expect(moved.pan).toBeNull();
    expect(moved.interaction).toBeNull();
    expect(finishPointerGesture(moved.gesture, sample({ x: 103, key: '1,0' }))).toMatchObject({
      source: 'click',
      originKey: '1,0',
      targetKey: '1,0',
    });
  });

  it('a selected-unit drag previews start, updates and release without camera panning', () => {
    const press = beginPointerGesture(sample(), '0,0');
    const start = advancePointerGesture(press, sample({ x: 110, key: '1,0' }));
    expect(start.pan).toBeNull();
    expect(start.interaction).toMatchObject({
      source: 'drag',
      stage: 'start',
      originKey: '0,0',
      targetKey: '1,0',
    });
    const move = advancePointerGesture(start.gesture, sample({ x: 130, key: '2,0' }));
    expect(move.interaction).toMatchObject({ source: 'drag', stage: 'move', targetKey: '2,0' });
    expect(finishPointerGesture(move.gesture, sample({ x: 130, key: '2,0' }))).toMatchObject({
      source: 'drag',
      stage: 'end',
      targetKey: '2,0',
    });
  });

  it.each([0, 1, 2])(
    'dragging button %i from another origin pans and never clicks on release',
    (button) => {
      const press = beginPointerGesture(sample({ button }), null);
      const move = advancePointerGesture(press, sample({ button, x: 120, y: 95 }));
      expect(move.pan).toEqual({ dx: 20, dy: -5 });
      expect(move.interaction).toBeNull();
      expect(finishPointerGesture(move.gesture, sample({ button, x: 120, y: 95 }))).toBeNull();
    },
  );

  it('right and middle drags stay camera gestures even when they start over the selected unit', () => {
    for (const button of [1, 2]) {
      const press = beginPointerGesture(sample({ button }), '0,0');
      expect(advancePointerGesture(press, sample({ button, x: 120 })).pan).toEqual({
        dx: 20,
        dy: 0,
      });
    }
    expect(
      finishPointerGesture(
        beginPointerGesture(sample({ button: 2 }), '0,0'),
        sample({ button: 2 }),
      ),
    ).toMatchObject({ source: 'click', button: 2 });
  });

  it('unrelated pointer IDs cannot alter or complete an active gesture', () => {
    const press = beginPointerGesture(sample(), '0,0');
    const unrelated = sample({ pointerId: 2, x: 500, key: '4,0' });
    expect(advancePointerGesture(press, unrelated)).toEqual({
      gesture: press,
      pan: null,
      interaction: null,
    });
    expect(finishPointerGesture(press, unrelated)).toBeNull();
  });

  it.each(['touch', 'pen', 'mouse'])(
    '%s cancellation produces only a cancel event for active command dragging',
    (pointerType) => {
      const press = beginPointerGesture(sample({ pointerType }), '0,0');
      expect(cancelPointerGesture(press)).toBeNull();
      const drag = advancePointerGesture(
        press,
        sample({ pointerType, x: 120, key: '1,0' }),
      ).gesture;
      expect(cancelPointerGesture(drag)).toEqual({
        source: 'drag',
        stage: 'cancel',
        originKey: '0,0',
        targetKey: null,
        button: 0,
        pointerType,
      });
      expect(cancelPointerGesture(null)).toBeNull();
    },
  );

  it('drag release outside the map carries no stale destination', () => {
    const press = beginPointerGesture(sample(), '0,0');
    const drag = advancePointerGesture(press, sample({ x: 120, key: '1,0' })).gesture;
    expect(finishPointerGesture(drag, sample({ x: 1200, key: null }))).toMatchObject({
      source: 'drag',
      stage: 'end',
      targetKey: null,
    });
  });

  it('camera shortcuts yield to buttons, fields, links and inherited editable content', () => {
    for (const tag of ['button', 'input', 'textarea', 'select', 'a', 'summary']) {
      const node = document.createElement(tag);
      expect(isInteractiveKeyTarget(node)).toBe(true);
    }
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editor.append(child);
    expect(isInteractiveKeyTarget(child)).toBe(true);
    expect(isInteractiveKeyTarget(document.createElement('canvas'))).toBe(false);
  });
});

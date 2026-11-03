import { afterEach, describe, expect, it, vi } from 'vitest';
import { HexScene } from './HexScene.ts';
import type { SceneCommandControls } from '../controls/types.ts';
import type { PointerGesture, PointerSample } from '../controls/gestures.ts';

interface InputHarness {
  renderer: { domElement: HTMLCanvasElement };
  handlers: { onClick: ReturnType<typeof vi.fn>; onHover: ReturnType<typeof vi.fn> };
  commandControls: SceneCommandControls;
  dragging: PointerGesture | null;
  activePointers: Map<number, { x: number; y: number }>;
  multiPointer: boolean;
  multiPanCenter: { x: number; y: number } | null;
  lastPointerType: string;
  lastLayout: [];
  hoverKey: string | null;
  hoverRing: { visible: boolean };
  selectedDragOrigin: ReturnType<typeof vi.fn>;
  pointerSample: (event: PointerEvent) => PointerSample;
  panPixels: ReturnType<typeof vi.fn>;
  setPointer: ReturnType<typeof vi.fn>;
  pickKey: ReturnType<typeof vi.fn>;
  onKeyDown: EventListener;
  onKeyUp: EventListener;
  onBlur: EventListener;
  bindInput: () => void;
  setCommandControls: (controls?: SceneCommandControls) => void;
  cancelAllPointers: () => void;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

/** Exercise the real DOM bindings without constructing a WebGL renderer. */
function harness(): InputHarness {
  const scene = Object.create(HexScene.prototype) as InputHarness;
  const canvas = document.createElement('canvas');
  const captures = new Set<number>();
  canvas.setPointerCapture = (id) => {
    captures.add(id);
  };
  canvas.hasPointerCapture = (id) => captures.has(id);
  canvas.releasePointerCapture = (id) => {
    captures.delete(id);
  };
  document.body.append(canvas);
  Object.assign(scene, {
    renderer: { domElement: canvas },
    handlers: { onClick: vi.fn(), onHover: vi.fn() },
    commandControls: {
      enabled: true,
      selectedOriginKey: '0,0',
      protectedKeys: [],
      trackedKeys: [],
      onInteraction: vi.fn(),
      onLayout: vi.fn(),
    },
    dragging: null,
    activePointers: new Map(),
    multiPointer: false,
    multiPanCenter: null,
    lastPointerType: 'mouse',
    lastLayout: [],
    hoverKey: '1,0',
    hoverRing: { visible: true },
    selectedDragOrigin: vi.fn(() => '0,0'),
    panPixels: vi.fn(),
    setPointer: vi.fn(),
    pickKey: vi.fn(() => '1,0'),
    onKeyDown: vi.fn(),
    onKeyUp: vi.fn(),
    onBlur: vi.fn(),
  });
  scene.pointerSample = (event) => ({
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    button: event.button,
    pointerType: event.pointerType,
    key: event.clientX > 110 ? '1,0' : '0,0',
  });
  scene.onBlur = () => scene.cancelAllPointers();
  scene.bindInput();
  cleanup.push(() => {
    window.removeEventListener('keydown', scene.onKeyDown);
    window.removeEventListener('keyup', scene.onKeyUp);
    window.removeEventListener('blur', scene.onBlur);
    canvas.remove();
  });
  return scene;
}

function pointer(
  scene: InputHarness,
  type: string,
  options: {
    id?: number;
    x?: number;
    y?: number;
    button?: number;
    pointerType?: string;
  } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.x ?? 100,
    clientY: options.y ?? 100,
    button: options.button ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.id ?? 1 },
    pointerType: { value: options.pointerType ?? 'mouse' },
  });
  scene.renderer.domElement.dispatchEvent(event);
  return event;
}

describe('real scene pointer bindings', () => {
  it('window blur cancels command dragging and clears all pointer ownership', () => {
    const scene = harness();
    pointer(scene, 'pointerdown');
    pointer(scene, 'pointermove', { x: 130 });
    window.dispatchEvent(new Event('blur'));
    pointer(scene, 'pointerup', { x: 130 });
    expect(
      vi
        .mocked(scene.commandControls.onInteraction)
        .mock.calls.map(([interaction]) => interaction.stage),
    ).toEqual(['start', 'cancel']);
    expect(scene.activePointers.size).toBe(0);
  });

  it.each(['scope', 'disable'])(
    '%s change cancels an active gesture without a later command release',
    (change) => {
      const scene = harness();
      const interactions = scene.commandControls.onInteraction;
      pointer(scene, 'pointerdown');
      pointer(scene, 'pointermove', { x: 130 });
      scene.setCommandControls({
        ...scene.commandControls,
        ...(change === 'scope' ? { selectionScope: 'next-actor-same-cell' } : { enabled: false }),
      });
      pointer(scene, 'pointerup', { x: 130 });
      expect(vi.mocked(interactions).mock.calls.map(([interaction]) => interaction.stage)).toEqual([
        'start',
        'cancel',
      ]);
      expect(scene.handlers.onClick).not.toHaveBeenCalled();
    },
  );

  it('selected-origin movement previews and releases; another origin pans', () => {
    const scene = harness();
    pointer(scene, 'pointerdown');
    pointer(scene, 'pointermove', { x: 130 });
    pointer(scene, 'pointerup', { x: 130 });
    expect(scene.commandControls.onInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'drag', stage: 'start', targetKey: '1,0' }),
    );
    expect(scene.commandControls.onInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'drag', stage: 'end', targetKey: '1,0' }),
    );
    expect(scene.panPixels).not.toHaveBeenCalled();
    scene.selectedDragOrigin.mockReturnValue(null);
    vi.mocked(scene.commandControls.onInteraction).mockClear();
    pointer(scene, 'pointerdown');
    pointer(scene, 'pointermove', { x: 140 });
    pointer(scene, 'pointerup', { x: 140 });
    expect(scene.panPixels).toHaveBeenCalledWith(40, 0);
    expect(scene.commandControls.onInteraction).not.toHaveBeenCalled();
  });

  it.each(['pointercancel', 'lostpointercapture'])(
    '%s terminates a command without a release or click',
    (cancel) => {
      const scene = harness();
      pointer(scene, 'pointerdown');
      pointer(scene, 'pointermove', { x: 130 });
      pointer(scene, cancel, { x: 130 });
      pointer(scene, 'pointerup', { x: 130 });
      const calls = vi
        .mocked(scene.commandControls.onInteraction)
        .mock.calls.map(([interaction]) => interaction.stage);
      expect(calls).toEqual(['start', 'cancel']);
      expect(scene.dragging).toBeNull();
    },
  );

  it('a second touch cancels command dragging; two-finger motion pans and cannot end as a command', () => {
    const scene = harness();
    pointer(scene, 'pointerdown', { pointerType: 'touch' });
    pointer(scene, 'pointermove', { x: 130, pointerType: 'touch' });
    pointer(scene, 'pointerdown', { id: 2, x: 180, pointerType: 'touch' });
    pointer(scene, 'pointermove', { id: 2, x: 200, pointerType: 'touch' });
    pointer(scene, 'pointerup', { id: 2, x: 200, pointerType: 'touch' });
    pointer(scene, 'pointerup', { x: 130, pointerType: 'touch' });
    expect(
      vi
        .mocked(scene.commandControls.onInteraction)
        .mock.calls.map(([interaction]) => interaction.stage),
    ).toEqual(['start', 'cancel']);
    expect(scene.panPixels).toHaveBeenCalledWith(10, 0);
    expect(scene.activePointers.size).toBe(0);
  });

  it('right-click cancels without reopening context actions regardless of native contextmenu ordering', () => {
    const scene = harness();
    pointer(scene, 'pointerdown', { button: 2 });
    expect(pointer(scene, 'contextmenu', { button: 2 }).defaultPrevented).toBe(true);
    pointer(scene, 'pointerup', { button: 2 });
    expect(pointer(scene, 'contextmenu', { button: 2 }).defaultPrevented).toBe(true);
    expect(scene.commandControls.onInteraction).toHaveBeenCalledTimes(1);
    expect(scene.commandControls.onInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'click', button: 2 }),
    );
  });

  it('right dragging still pans if contextmenu fires at pointerdown', () => {
    const scene = harness();
    pointer(scene, 'pointerdown', { button: 2 });
    pointer(scene, 'contextmenu', { button: 2 });
    pointer(scene, 'pointermove', { button: 2, x: 130 });
    pointer(scene, 'pointerup', { button: 2, x: 130 });
    expect(scene.panPixels).toHaveBeenCalledWith(30, 0);
    expect(scene.commandControls.onInteraction).not.toHaveBeenCalled();
  });

  it('native touch context consumes its press without a later tap or cancel erasing the preview', () => {
    const scene = harness();
    pointer(scene, 'pointerdown', { pointerType: 'touch' });
    expect(pointer(scene, 'contextmenu', { pointerType: 'touch' }).defaultPrevented).toBe(true);
    pointer(scene, 'pointercancel', { pointerType: 'touch' });
    pointer(scene, 'pointerup', { pointerType: 'touch' });
    expect(scene.commandControls.onInteraction).toHaveBeenCalledTimes(1);
    expect(scene.commandControls.onInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'context', targetKey: '1,0' }),
    );
  });

  it('keyboard context targets the selected actor; an unhandled context target keeps browser behavior', () => {
    const scene = harness();
    const keyboard = pointer(scene, 'contextmenu', { x: 0, y: 0, pointerType: '', id: -1 });
    expect(keyboard.defaultPrevented).toBe(true);
    expect(scene.commandControls.onInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'context', targetKey: '0,0', pointerType: 'keyboard' }),
    );
    scene.pickKey.mockReturnValue(null);
    expect(pointer(scene, 'contextmenu', { pointerType: 'touch' }).defaultPrevented).toBe(false);
  });

  it('trusted Chromium Shift+F10 event shape uses keyboard fallback despite its mouse pointer type', () => {
    const scene = harness();
    const keyboard = pointer(scene, 'contextmenu', {
      x: 596,
      y: 586,
      pointerType: 'mouse',
      id: 1,
      button: -1,
    });
    expect(keyboard.defaultPrevented).toBe(true);
    expect(scene.commandControls.onInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'context',
        targetKey: '0,0',
        pointerType: 'keyboard',
      }),
    );
  });
});

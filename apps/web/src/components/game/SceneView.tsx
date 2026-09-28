import { useEffect, useRef, useState } from 'react';
import { HexScene } from '../../render/HexScene.ts';
import type { AttackFx } from '../../render/effects.ts';
import type { SceneSpec } from '../../render/spec.ts';
import { Button } from '../ui/Button.tsx';

interface Props {
  spec: SceneSpec;
  /** Latest attack animation; played once per new id. */
  fx?: AttackFx | null;
  selectedKey: string | null;
  focusKey?: string | null;
  onHover: (key: string | null) => void;
  onClick: (key: string, button: number) => void;
}

export function SceneView({
  spec,
  fx,
  selectedKey,
  focusKey,
  onHover,
  onClick,
}: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HexScene | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [fireView, setFireView] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      sceneRef.current = new HexScene(host);
      if (import.meta.env.DEV) {
        const hook = (window as unknown as { __ironRidge?: Record<string, unknown> }).__ironRidge;
        if (hook) hook.scene = sceneRef.current;
      }
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'WebGL unavailable');
    }
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setHandlers({ onHover, onClick });
  }, [onHover, onClick]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.update(spec, selectedKey);
    setFireView(s.isFireView());
  }, [spec, selectedKey]);

  useEffect(() => {
    if (focusKey) sceneRef.current?.focus(focusKey);
  }, [focusKey]);

  // Play each attack once. Runs after the spec effect above, so the scene already
  // shows the post-attack state (lingering tokens cover units killed by this shot).
  const playedFx = useRef(0);
  useEffect(() => {
    if (!fx || fx.id === playedFx.current) return;
    playedFx.current = fx.id;
    sceneRef.current?.playAttack(fx);
  }, [fx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'f')
        setTimeout(() => setFireView(sceneRef.current?.isFireView() ?? false), 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative w-full h-full overflow-hidden scanlines">
      <div ref={hostRef} className="absolute inset-0" data-testid="scene-host" />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-[hsl(var(--warning))] p-6 text-center">
          3D view unavailable ({failed}). The game still runs — try a WebGL-capable browser.
        </div>
      )}
      <div className="absolute left-2 bottom-2 flex gap-1 flex-wrap">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => sceneRef.current?.rotate(-1)}
          title="Rotate left (Q)"
        >
          ⟲ Q
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => sceneRef.current?.rotate(1)}
          title="Rotate right (E)"
        >
          E ⟳
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => sceneRef.current?.zoom(0.8)}
          title="Zoom in"
        >
          +
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => sceneRef.current?.zoom(1.25)}
          title="Zoom out"
        >
          −
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => sceneRef.current?.frameAll()}
          title="Reset view (R)"
        >
          ⌂ R
        </Button>
        {spec.fireView && (
          <Button
            size="sm"
            variant={fireView ? 'default' : 'ghost'}
            onClick={() => {
              sceneRef.current?.toggleFireView();
              setFireView(sceneRef.current?.isFireView() ?? false);
            }}
            title="Firing view (F)"
          >
            ◎ FIRE VIEW (F)
          </Button>
        )}
      </div>
      <div className="hidden sm:block absolute right-2 bottom-2 text-[9px] text-[hsl(var(--muted-foreground))] text-right leading-4 pointer-events-none">
        WASD/drag pan · Q/E rotate · wheel zoom · R reset · right-click cancel
      </div>
    </div>
  );
}

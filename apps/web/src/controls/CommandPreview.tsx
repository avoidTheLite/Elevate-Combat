import { useEffect, useId, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { MapCommand, PendingCommand } from './commands.ts';
import type { SceneTileAnchor } from './types.ts';
import { TEAM_COLOR } from '../render/spec.ts';

// Reuse the existing healthy-unit green and enemy-name red; no team palette change.
export const MOVE_PREVIEW_COLOR = '#33ff88';
export const ATTACK_PREVIEW_COLOR = `#${TEAM_COLOR.B.toString(16).padStart(6, '0')}`;
export type PreviewRoute = Pick<MapCommand, 'kind' | 'origin' | 'target' | 'path'>;

/** Never connect across a missing path cell with a misleading straight shortcut. */
export function commandRoute(
  command: PreviewRoute,
  anchors: readonly SceneTileAnchor[],
  compactConfirmation = false,
): string | null {
  const keys = command.kind === 'move' ? command.path : [command.origin, command.target];
  if (keys.length < 2) return null;
  const byKey = new Map(anchors.map((anchor) => [anchor.key, anchor]));
  const points = keys.map((key) => byKey.get(key));
  if (points.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)))
    return null;
  const route = points.map((point) => ({ x: point!.x, y: point!.y }));
  if (compactConfirmation && command.kind === 'move') {
    const end = route.at(-1)!;
    const previous = route.at(-2)!;
    const dx = end.x - previous.x;
    const dy = end.y - previous.y;
    // Stop just before the two controls, so the directional head stays visible.
    const inset = Math.min(
      dx ? 58 / Math.abs(dx) : Infinity,
      dy ? 34 / Math.abs(dy) : Infinity,
      0.8,
    );
    end.x -= dx * inset;
    end.y -= dy * inset;
  }
  return route.map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
}

export function CommandPreviewLine({
  command,
  anchors,
  staged,
  animate,
}: {
  command: PreviewRoute | null;
  anchors: readonly SceneTileAnchor[];
  staged: boolean;
  animate: boolean;
}): React.ReactElement | null {
  const id = useId().replace(/:/g, '');
  if (!command || command.kind === 'action') return null;
  const route = commandRoute(command, anchors, staged);
  if (!route) return null;
  return (
    <svg
      className="map-command-route"
      data-kind={command.kind}
      data-staged={staged}
      data-motion={animate ? 'on' : 'off'}
      style={{ color: command.kind === 'move' ? MOVE_PREVIEW_COLOR : ATTACK_PREVIEW_COLOR }}
      aria-hidden="true"
    >
      <defs>
        <path id={`${id}-route`} data-command-route="true" d={route} pathLength="100" />
        <marker
          id={`${id}-arrow`}
          markerWidth="5"
          markerHeight="5"
          refX="4.5"
          refY="2.5"
          orient="auto"
        >
          <path d="M0,0 L5,2.5 L0,5 L1.5,2.5 Z" fill="currentColor" />
        </marker>
        <filter
          id={`${id}-glow`}
          filterUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="100%"
          height="100%"
        >
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>
      <use className="map-command-line" href={`#${id}-route`} markerEnd={`url(#${id}-arrow)`} />
      {/* One luminous segment travels on that same route, never a second connector. */}
      <use className="map-command-glow" href={`#${id}-route`} filter={`url(#${id}-glow)`} />
    </svg>
  );
}

export function MoveConfirmation({
  pending,
  anchor,
  helpId,
  confirm,
  cancel,
}: {
  pending: PendingCommand;
  anchor?: SceneTileAnchor;
  helpId: string;
  confirm: () => void;
  cancel: () => void;
}): React.ReactElement {
  const confirmButton = useRef<HTMLButtonElement>(null);
  const pressed = useRef<'confirm' | 'cancel' | null>(null);
  useEffect(() => {
    if (!pending.dragging) confirmButton.current?.focus({ preventScroll: true });
  }, [pending.command.target, pending.dragging]);
  const style = anchor
    ? ({
        left: `clamp(46px, ${anchor.x}px, calc(100% - 46px))`,
        top: `clamp(22px, ${anchor.y}px, calc(100% - 22px))`,
      } as CSSProperties)
    : undefined;
  return (
    <div
      className={`map-move-confirmation${anchor ? '' : ' map-move-confirmation-fallback'}`}
      style={style}
      role="dialog"
      aria-label="MOVE command preview"
      aria-describedby={helpId}
      data-testid="map-command-preview"
      data-anchor-key={pending.command.target}
    >
      <span id={helpId} className="sr-only" aria-live="polite">
        Move from {pending.command.origin} to {pending.command.target}.{' '}
        {pending.command.details.join(' ')}{' '}
        {pending.dragging
          ? 'Release, then confirm. Release does not execute.'
          : 'Confirm with the check mark or cancel with X or Escape. Details remain in the unit sidebar.'}
      </span>
      <button
        ref={confirmButton}
        type="button"
        className="map-move-confirm"
        disabled={pending.dragging}
        aria-label="CONFIRM MOVE"
        aria-describedby={helpId}
        title={pending.command.details.join(' ')}
        onPointerDown={(event) => {
          if (event.button === 0 && event.isPrimary !== false) pressed.current = 'confirm';
        }}
        onPointerCancel={() => {
          pressed.current = null;
        }}
        onBlur={() => {
          if (pressed.current === 'confirm') pressed.current = null;
        }}
        onClick={(event) => {
          const intentional = event.detail === 0 || pressed.current === 'confirm';
          pressed.current = null;
          // Touch compatibility clicks can be retargeted onto a control created
          // by pointerup. Require a new press, or native keyboard/AT activation.
          if (intentional) confirm();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m5 12 4 4 10-10" />
        </svg>
      </button>
      <button
        type="button"
        className="map-move-cancel"
        aria-label="CANCEL"
        title="Cancel this preview without spending movement, AP or CP"
        onPointerDown={(event) => {
          if (event.button === 0 && event.isPrimary !== false) pressed.current = 'cancel';
        }}
        onPointerCancel={() => {
          pressed.current = null;
        }}
        onBlur={() => {
          if (pressed.current === 'cancel') pressed.current = null;
        }}
        onClick={(event) => {
          const intentional = event.detail === 0 || pressed.current === 'cancel';
          pressed.current = null;
          if (intentional) cancel();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

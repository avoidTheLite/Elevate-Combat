import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { SceneTileAnchor } from './types.ts';
import type { useMapControls } from './useMapControls.ts';
import { bridgeSegments, calloutBridge, placeCallouts } from './calloutLayout.ts';
import { CommandPreviewLine, MoveConfirmation } from './CommandPreview.tsx';
import type { PreviewRoute } from './CommandPreview.tsx';

type Controls = ReturnType<typeof useMapControls>;

function AnchoredCallout({
  anchor,
  controls,
  children,
}: {
  anchor?: SceneTileAnchor;
  controls: Controls;
  children: ReactNode;
}): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [bridge, setBridge] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const element = box.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const place = (): void => {
      const pw = parent.clientWidth || window.innerWidth;
      const ph = parent.clientHeight || window.innerHeight;
      const elements = [...parent.querySelectorAll<HTMLDivElement>('.map-callout')];
      const boxes = elements.map((node) => ({
        id: node.dataset.calloutKind!,
        selected: node.dataset.calloutKind === 'selected',
        width: node.offsetWidth || 228,
        height: node.offsetHeight || 120,
        anchor: controls.anchors.find((a) => a.key === node.dataset.anchorKey),
      }));
      const positions = placeCallouts(
        boxes,
        controls.anchors,
        { width: pw, height: ph },
        controls.preferences.overlap,
      );
      elements.forEach((node) => {
        const rect = positions[node.dataset.calloutKind!];
        if (rect) {
          node.style.left = `${rect.left}px`;
          node.style.top = `${rect.top}px`;
        }
      });
      const rect = positions.target;
      if (!rect) return;
      // Keep the tile body available, while aligning the corridor with the
      // pointer's natural route to the card center after edge detachment.
      setBridge(anchor ? calloutBridge(anchor, rect) : null);
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(element);
    observer.observe(parent);
    parent.querySelectorAll('.map-callout').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [anchor, controls.anchors, controls.preferences.overlap, children]);
  return (
    <>
      {bridge && (
        <svg className="map-callout-bridge" aria-hidden="true">
          {bridgeSegments(bridge, controls.anchors).map((segment, index) => (
            <line
              key={index}
              {...segment}
              onPointerEnter={controls.calloutEnter}
              onPointerLeave={controls.calloutLeave}
            />
          ))}
        </svg>
      )}
      <div
        ref={box}
        className={`map-callout${controls.exiting ? ' map-callout-exit' : ''}`}
        data-callout-kind="target"
        data-callout-mode={controls.pending ? 'preview' : 'context'}
        data-anchor-key={anchor?.key}
        onPointerEnter={controls.calloutEnter}
        onPointerLeave={controls.calloutLeave}
        onFocus={controls.calloutFocus}
        onBlur={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            controls.calloutBlur();
        }}
      >
        {children}
      </div>
    </>
  );
}

export function MapCallouts({
  controls,
  previewRoute,
}: {
  controls: Controls;
  previewRoute?: PreviewRoute | null;
}): React.ReactElement | null {
  const helpId = useId();
  if (!controls.enabled) return null;
  const anchor = (key: string | null | undefined): SceneTileAnchor | undefined =>
    controls.anchors.find((a) => a.key === key);
  const selected = controls.actor;
  const pending = controls.pending;
  const to = anchor(pending?.command.target);
  const atSelected = controls.targetKey === selected?.pos;
  const showTarget =
    pending?.command.kind !== 'move' &&
    !!controls.targetKey &&
    (!!pending ||
      !!controls.hoverCommand ||
      !!controls.moveCommand ||
      !!controls.attackCommand ||
      controls.targetOccupants.length > 0 ||
      atSelected);
  const style = {
    '--map-callout-duration': `${controls.preferences.animationMs}ms`,
    '--map-callout-easing': controls.preferences.easing,
  } as CSSProperties;
  return (
    <div className="map-callouts" style={style} data-testid="map-callouts">
      <CommandPreviewLine
        command={previewRoute === undefined ? controls.previewCommand : previewRoute}
        anchors={controls.anchors}
        staged={!!pending}
        animate={controls.preferences.animationMs > 0}
      />
      {pending?.command.kind === 'move' && (
        <MoveConfirmation
          pending={pending}
          anchor={to}
          helpId={helpId}
          confirm={controls.confirm}
          cancel={controls.cancel}
        />
      )}
      {showTarget && (
        <AnchoredCallout anchor={anchor(controls.targetKey)} controls={controls}>
          {pending ? (
            <div
              role="dialog"
              aria-label={`${pending.command.label} command preview`}
              data-testid="map-command-preview"
              aria-describedby={helpId}
            >
              <div className="map-callout-title">{pending.command.label} PREVIEW</div>
              <p>
                {pending.command.origin} → {pending.command.target}
              </p>
              <span id={helpId} className="sr-only">
                {pending.command.details.join(' ')}{' '}
                {pending.dragging
                  ? 'Release to keep the preview; then confirm.'
                  : 'Preview stays open when the pointer leaves. Escape cancels.'}
              </span>
              <details className="map-command-help">
                <summary
                  title="Command details and controls"
                  aria-label={`${pending.command.label} command details`}
                >
                  ? HELP
                </summary>
                <ul className="map-preview-details">
                  {pending.command.details.map((detail, i) => (
                    <li key={i}>{detail}</li>
                  ))}
                </ul>
                <p>
                  {pending.dragging
                    ? 'Release to keep this preview. Release does not execute.'
                    : 'Preview stays open when the pointer leaves. Escape cancels.'}
                </p>
              </details>
              <div className="map-callout-buttons">
                <button
                  type="button"
                  disabled={pending.dragging}
                  onClick={controls.confirm}
                  title={pending.command.details.join(' ')}
                  aria-describedby={helpId}
                >
                  CONFIRM {pending.command.label}
                </button>
                <button
                  type="button"
                  title="Cancel this preview without spending movement, AP or CP"
                  aria-label="CANCEL"
                  onClick={controls.cancel}
                >
                  CANCEL
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="map-callout-title">TILE {controls.targetKey}</div>
              {atSelected && selected && (
                <div className="map-callout-buttons" aria-label="Contextual unit actions">
                  {(['move', 'attack'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      disabled={!controls.targetingOptions[mode]}
                      aria-pressed={controls.targetingMode === mode}
                      title={
                        mode === 'move'
                          ? 'Choose a destination with a tap or click'
                          : 'Choose a target; indirect weapons can target empty tiles'
                      }
                      onClick={() => {
                        controls.cancel();
                        controls.setTargetingMode(mode);
                      }}
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                  {controls.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      title={action.details.join(' ')}
                      aria-label={action.label}
                      onClick={() => controls.issue(action)}
                    >
                      {action.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    title="Clear unit selection and pending preview"
                    onClick={() => controls.select(selected.id, selected.pos)}
                  >
                    DESELECT
                  </button>
                </div>
              )}
              <div className="map-callout-buttons" aria-label="Choose occupant on contextual tile">
                {controls.targetOccupants.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={selected?.id === o.id}
                    title={`Select ${o.label} on this tile`}
                    onClick={() => controls.select(o.id, controls.targetKey!)}
                  >
                    SELECT {o.label}
                  </button>
                ))}
                {controls.hoverCommand && (
                  <button type="button" onClick={() => controls.issue(controls.hoverCommand!)}>
                    {controls.hoverCommand.label}
                  </button>
                )}
                {controls.moveCommand && controls.hoverCommand?.kind !== 'move' && (
                  <button type="button" onClick={() => controls.issue(controls.moveCommand!)}>
                    MOVE
                  </button>
                )}
                {controls.attackCommand && controls.hoverCommand?.kind !== 'attack' && (
                  <button type="button" onClick={() => controls.issue(controls.attackCommand!)}>
                    ATTACK
                  </button>
                )}
              </div>
            </>
          )}
        </AnchoredCallout>
      )}
    </div>
  );
}

export function MapControlPreferences({
  controls,
  onClose,
}: {
  controls: Controls;
  onClose: () => void;
}): React.ReactElement {
  const p = controls.preferences;
  const helpId = useId();
  return (
    <div className="map-preferences" role="dialog" aria-label="Proposed map control preferences">
      <div className="map-callout-title">PROPOSED DEMO CONTROLS</div>
      <details className="map-command-help">
        <summary title="Preference help" aria-label="Control preference help">
          ? HELP
        </summary>
        <p id={helpId}>
          Browser preferences, separate from game saves. Proposed defaults: preview Move and Attack;
          drag always previews and requires confirmation. Placement tries each tile side, then
          detaches when needed. Reduced motion follows your device. Touch: tap select, tap target,
          then confirm; native context exposes tile actions.
        </p>
      </details>
      <label>
        <input
          type="checkbox"
          title="Execute legal move clicks immediately; otherwise preview and confirm"
          aria-describedby={helpId}
          checked={p.quickMove}
          onChange={(e) => controls.setPreference({ quickMove: e.target.checked })}
        />{' '}
        QuickMove
      </label>
      <label>
        <input
          type="checkbox"
          title="Execute legal attack clicks immediately; otherwise preview and confirm"
          aria-describedby={helpId}
          checked={p.quickAttack}
          onChange={(e) => controls.setPreference({ quickAttack: e.target.checked })}
        />{' '}
        QuickAttack
      </label>
      <label>
        Hover enter / exit delay: {p.dwellMs} ms
        <input
          type="range"
          min="0"
          max="1500"
          step="50"
          value={p.dwellMs}
          onChange={(e) => controls.setPreference({ dwellMs: Number(e.target.value) })}
        />
      </label>
      <label>
        Animation: {p.animationMs} ms
        <input
          type="range"
          min="0"
          max="500"
          step="20"
          value={p.animationMs}
          onChange={(e) => controls.setPreference({ animationMs: Number(e.target.value) })}
        />
      </label>
      <label>
        Animation easing
        <select
          value={p.easing}
          onChange={(e) => controls.setPreference({ easing: e.target.value as typeof p.easing })}
        >
          <option value="ease-out">Ease out (proposed default)</option>
          <option value="linear">Linear</option>
          <option value="ease-in-out">Ease in / out</option>
        </select>
      </label>
      <label>
        Tile-width overlap: {p.overlap}% · proposed placement
        <input
          type="range"
          min="0"
          max="75"
          step="5"
          value={p.overlap}
          onChange={(e) => controls.setPreference({ overlap: Number(e.target.value) })}
        />
      </label>

      <button type="button" onClick={onClose}>
        CLOSE CONTROLS
      </button>
    </div>
  );
}

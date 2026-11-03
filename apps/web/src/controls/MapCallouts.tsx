import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { SceneTileAnchor } from './types.ts';
import type { useMapControls } from './useMapControls.ts';
import { selectableAt } from './commands.ts';
import { bridgeSegments, calloutBridge, placeCallouts } from './calloutLayout.ts';
import { useGameStore } from '../stores/useGameStore.ts';

type Controls = ReturnType<typeof useMapControls>;

function AnchoredCallout({
  anchor,
  controls,
  children,
  selected = false,
}: {
  anchor?: SceneTileAnchor;
  controls: Controls;
  children: ReactNode;
  selected?: boolean;
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
      const rect = positions[selected ? 'selected' : 'target'];
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
  }, [anchor, controls.anchors, controls.preferences.overlap, selected, children]);
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
        className={`map-callout${!selected && controls.exiting ? ' map-callout-exit' : ''}`}
        data-callout-kind={selected ? 'selected' : 'target'}
        data-anchor-key={anchor?.key}
        onPointerEnter={controls.calloutEnter}
        onPointerLeave={controls.calloutLeave}
        onFocus={controls.calloutEnter}
        onBlur={controls.calloutLeave}
      >
        {children}
      </div>
    </>
  );
}

export function MapCallouts({ controls }: { controls: Controls }): React.ReactElement | null {
  if (!controls.enabled) return null;
  const anchor = (key: string | null | undefined): SceneTileAnchor | undefined =>
    controls.anchors.find((a) => a.key === key);
  const selected = controls.actor;
  const pending = controls.pending;
  const from = anchor(selected?.pos);
  const to = anchor(pending?.command.target);
  const game = useGameStore.getState().game;
  const occupants = game && selected ? selectableAt(game, selected.pos) : [];
  const showTarget =
    !!controls.targetKey &&
    controls.targetKey !== selected?.pos &&
    (!!pending ||
      !!controls.hoverCommand ||
      !!controls.moveCommand ||
      !!controls.attackCommand ||
      controls.targetOccupants.length > 0);
  const style = {
    '--map-callout-duration': `${controls.preferences.animationMs}ms`,
    '--map-callout-easing': controls.preferences.easing,
  } as CSSProperties;
  return (
    <div className="map-callouts" style={style} data-testid="map-callouts">
      {from && to && pending && (
        <svg className="map-command-connector" aria-hidden="true">
          <defs>
            <marker
              id="map-command-arrow"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
            >
              <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" />
            </marker>
          </defs>
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#map-command-arrow)" />
          <circle cx={to.x} cy={to.y} r={Math.max(8, to.radius * 0.4)} />
        </svg>
      )}
      {selected && (
        <AnchoredCallout anchor={from} controls={controls} selected>
          <div className="map-callout-title">{selected.label}</div>
          {occupants.length > 1 && (
            <div className="map-callout-buttons" aria-label="Choose occupant on selected tile">
              {occupants.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={selected.id === o.id}
                  onClick={() => controls.select(o.id, selected.pos)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <div className="map-callout-buttons" aria-label="Selected unit actions">
            <button
              type="button"
              disabled={!controls.targetingOptions.move}
              aria-pressed={controls.targetingMode === 'move'}
              title="Choose a destination with a tap or click"
              onClick={() => {
                controls.cancel();
                controls.setTargetingMode('move');
              }}
            >
              MOVE
            </button>
            <button
              type="button"
              disabled={!controls.targetingOptions.attack}
              aria-pressed={controls.targetingMode === 'attack'}
              title="Choose a target; indirect weapons can target empty tiles"
              onClick={() => {
                controls.cancel();
                controls.setTargetingMode('attack');
              }}
            >
              ATTACK
            </button>
            {controls.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                title={action.details.join(' ')}
                onClick={() => controls.issue(action)}
              >
                {action.label}
              </button>
            ))}
            <button type="button" onClick={() => controls.select(selected.id, selected.pos)}>
              DESELECT
            </button>
          </div>
          <p>
            {controls.targetingMode === 'auto'
              ? 'Tap a destination or target.'
              : `Choose a ${controls.targetingMode === 'move' ? 'destination' : 'target'} for ${controls.targetingMode.toUpperCase()}.`}{' '}
            Drag from this selection to preview; drag elsewhere to pan.
          </p>
        </AnchoredCallout>
      )}
      {showTarget && (
        <AnchoredCallout anchor={anchor(controls.targetKey)} controls={controls}>
          {pending ? (
            <div
              role="dialog"
              aria-label={`${pending.command.label} command preview`}
              data-testid="map-command-preview"
            >
              <div className="map-callout-title">{pending.command.label} PREVIEW</div>
              <p>
                {pending.command.origin} → {pending.command.target}
              </p>
              <ul className="map-preview-details">
                {pending.command.details.map((detail, i) => (
                  <li key={i}>{detail}</li>
                ))}
              </ul>
              <div className="map-callout-buttons">
                <button type="button" disabled={pending.dragging} onClick={controls.confirm}>
                  CONFIRM {pending.command.label}
                </button>
                <button type="button" onClick={controls.cancel}>
                  CANCEL
                </button>
              </div>
              <p>
                {pending.dragging
                  ? 'Release to keep this preview. Release does not execute.'
                  : 'Preview stays open when the pointer leaves. Escape cancels.'}
              </p>
            </div>
          ) : (
            <>
              <div className="map-callout-title">TILE {controls.targetKey}</div>
              <div className="map-callout-buttons">
                {controls.targetOccupants.map((o) => (
                  <button
                    key={o.id}
                    type="button"
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
  return (
    <div className="map-preferences" role="dialog" aria-label="Proposed map control preferences">
      <div className="map-callout-title">PROPOSED DEMO CONTROLS</div>
      <p>
        Browser preferences, separate from game saves. Proposed defaults: preview Move and Attack;
        drag always previews and requires confirmation.
      </p>
      <label>
        <input
          type="checkbox"
          checked={p.quickMove}
          onChange={(e) => controls.setPreference({ quickMove: e.target.checked })}
        />{' '}
        QuickMove — execute legal move clicks immediately
      </label>
      <label>
        <input
          type="checkbox"
          checked={p.quickAttack}
          onChange={(e) => controls.setPreference({ quickAttack: e.target.checked })}
        />{' '}
        QuickAttack — execute legal attack clicks immediately
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
      <p>
        Placement tries each tile side, then detaches when needed to keep unit bodies and both cards
        usable. Reduced motion follows your device. Touch: tap select, tap target, then confirm;
        native hold/context exposes actions.
      </p>
      <button type="button" onClick={onClose}>
        CLOSE CONTROLS
      </button>
    </div>
  );
}

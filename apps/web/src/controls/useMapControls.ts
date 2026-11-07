import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { GameState } from '@iron-ridge/engine';
import { worldOf } from '@iron-ridge/engine';
import { useGameStore } from '../stores/useGameStore.ts';
import type { UiState } from '../stores/useGameStore.ts';
import {
  actorActions,
  createCommandResolver,
  controlsEnabled,
  pendingValid,
  selectableAt,
  selectedActor,
  targetingOptions,
} from './commands.ts';
import type { MapCommand, PendingCommand, TargetingMode } from './commands.ts';
import { holderForClick, isFriendlyNodeCenter, nearbyHqForTile } from '../lib/holders.ts';
import { viewTeam } from '../stores/useGameStore.ts';
import {
  CONTROL_PREFERENCES_CHANGED,
  readControlPreferences,
  saveControlPreferences,
} from './preferences.ts';
import type { ControlPreferences } from './preferences.ts';
import type { SceneInteraction, SceneTileAnchor } from './types.ts';
import {
  chooseNearbyHq,
  chooseTileEntity,
  inspectTile,
  visibleTileEntities,
} from '../lib/selection.ts';

export interface MapControls {
  preferences: ControlPreferences;
  setPreference: (patch: Partial<ControlPreferences>) => void;
  pending: PendingCommand | null;
  enabled: boolean;
  actor: ReturnType<typeof selectedActor>;
  actions: MapCommand[];
  previewKey: string | null;
  previewKind: MapCommand['kind'] | null;
  previewCommand: MapCommand | null;
  selectionScope: string;
  targetKey: string | null;
  hoverCommand: MapCommand | null;
  moveCommand: MapCommand | null;
  attackCommand: MapCommand | null;
  targetOccupants: ReturnType<typeof selectableAt>;
  nearbyHq: ReturnType<typeof nearbyHqForTile>;
  selectNearbyHq: (key: string) => void;
  inspectionKey: string | null;
  inspectionSelection: string | null;
  inspectionEntities: ReturnType<typeof visibleTileEntities>;
  inspect: (key: string) => void;
  anchors: readonly SceneTileAnchor[];
  setAnchors: Dispatch<SetStateAction<readonly SceneTileAnchor[]>>;
  exiting: boolean;
  targetingMode: TargetingMode;
  setTargetingMode: Dispatch<SetStateAction<TargetingMode>>;
  targetingOptions: ReturnType<typeof targetingOptions>;
  onHover: (key: string | null) => void;
  interact: (intent: SceneInteraction) => boolean;
  issue: (command: MapCommand, forcePreview?: boolean, dragging?: boolean) => void;
  select: (id: string, key: string, requestContext?: boolean) => void;
  deselect: () => void;
  confirm: () => void;
  cancel: () => void;
  calloutEnter: () => void;
  calloutLeave: () => void;
  calloutFocus: () => void;
  calloutBlur: () => void;
}

/** Keep selection/territory inspection in step with the successful engine order. */
function dispatchMapCommand(command: MapCommand): void {
  const store = useGameStore.getState();
  if (!store.dispatch(command.action)) return;
  if (command.action.type !== 'moveCommander' && command.action.type !== 'move') return;
  const next = useGameStore.getState();
  const moved = next.game?.armies.find((army) => army.id === command.actorId);
  const destinationMain = next.game
    ? (worldOf(next.game).world.subByKey.get(command.target)?.main ?? null)
    : null;
  next.setUi({
    inspectedCell: command.target,
    selectedEntity: command.actorId,
    selectedMain: moved?.at ?? destinationMain,
    ...(command.action.type === 'moveCommander' ? { selectedArmy: moved?.id ?? null } : {}),
  });
}

export function useMapControls(game: GameState, ui: UiState, blocked: boolean): MapControls {
  const [preferences, setPreferences] = useState(readControlPreferences);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const pendingRef = useRef<PendingCommand | null>(null);
  const replacePending = useCallback((next: PendingCommand | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);
  const contextRequest = useRef<{ game: GameState; actorId: string; key: string } | null>(null);
  const [targetingMode, setTargetingMode] = useState<TargetingMode>('auto');
  const [hover, setHover] = useState<{ key: string | null; selection: string | null }>({
    key: null,
    selection: null,
  });
  const [dwelled, setDwelled] = useState<string | null>(null);
  const [contextPinned, setContextPinned] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [anchors, setAnchors] = useState<readonly SceneTileAnchor[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const overCallout = useRef(false);
  const focusWithinCallout = useRef(false);
  const revision = useRef({ game, id: 0 });
  const inspectionRevision = useRef(0);
  const inspectionEpoch = inspectionRevision.current;
  if (revision.current.game !== game) revision.current = { game, id: revision.current.id + 1 };
  const commandUi = useMemo(() => {
    const picked = game.battle?.units.find((unit) => unit.id === ui.selectedUnit);
    const visibleSelection =
      !picked?.pos ||
      visibleTileEntities(game, picked.pos).some((entity) => entity.id === picked.id);
    return {
      selectedArmy: ui.selectedArmy,
      selectedUnit: visibleSelection ? ui.selectedUnit : null,
      checkedUnits: ui.checkedUnits,
    };
  }, [game, ui.selectedArmy, ui.selectedUnit, ui.checkedUnits]);
  const resolveCommand = useMemo(() => createCommandResolver(game, commandUi), [game, commandUi]);
  const enabled = useMemo(() => !blocked && controlsEnabled(game), [blocked, game]);
  const actor = useMemo(() => selectedActor(game, commandUi), [game, commandUi]);
  const selection = actor?.id ?? null;
  const selectionScope = `${revision.current.id}:${selection ?? ''}:${inspectionEpoch}:${blocked}`;
  const validPending = useMemo(
    () => (pending && enabled && pendingValid(pending, game, commandUi) ? pending : null),
    [pending, enabled, game, commandUi],
  );
  const hoverKey = enabled && hover.selection === selection ? hover.key : null;
  const previewKey = validPending?.command.target ?? hoverKey;
  const actions = useMemo(
    () => (enabled ? actorActions(game, commandUi) : []),
    [enabled, game, commandUi],
  );
  const options = useMemo(() => targetingOptions(game, commandUi), [game, commandUi]);

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    contextRequest.current = null;
    setContextPinned(false);
    replacePending(null);
    setTargetingMode('auto');
    setHover({ key: null, selection: null });
    setDwelled(null);
    setExiting(false);
    overCallout.current = false;
    focusWithinCallout.current = false;
    useGameStore.getState().setUi({ hoverCell: null });
  }, [replacePending]);

  useEffect(() => {
    const request = contextRequest.current;
    cancel();
    if (request && enabled && request.game === game && request.actorId === selection) {
      setHover({ key: request.key, selection });
      setDwelled(request.key);
      setContextPinned(true);
    }
  }, [selection, game, blocked, enabled, cancel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer.current);
    };
  }, [cancel]);

  useEffect(() => {
    const refresh = (): void => setPreferences(readControlPreferences());
    window.addEventListener(CONTROL_PREFERENCES_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CONTROL_PREFERENCES_CHANGED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const setPreference = useCallback((patch: Partial<ControlPreferences>) => {
    const next = { ...readControlPreferences(), ...patch };
    saveControlPreferences(next);
    setPreferences(next);
  }, []);

  const onHover = useCallback(
    (key: string | null) => {
      if (!enabled || validPending || contextPinned) return;
      if (inspectionRevision.current !== inspectionEpoch) return;
      const current = useGameStore.getState();
      if (current.game !== game || (selectedActor(game, current.ui)?.id ?? null) !== selection)
        return;
      if (overCallout.current || focusWithinCallout.current) return;
      clearTimeout(timer.current);
      setExiting(false);
      // Retain the tile intent during the exit delay so crossing into its
      // overlapping callout/bridge does not remove and recreate the preview.
      if (key || !dwelled) {
        setHover({ key, selection });
        useGameStore.getState().setUi({ hoverCell: key });
      }
      timer.current = setTimeout(() => {
        if (!overCallout.current && !focusWithinCallout.current) {
          if (key) setDwelled(key);
          else {
            setExiting(true);
            timer.current = setTimeout(() => {
              setDwelled(null);
              setHover({ key: null, selection: null });
              useGameStore.getState().setUi({ hoverCell: null });
              setExiting(false);
            }, preferences.animationMs);
          }
        }
      }, preferences.dwellMs);
    },
    [
      enabled,
      validPending,
      contextPinned,
      selection,
      game,
      dwelled,
      preferences.dwellMs,
      preferences.animationMs,
      inspectionEpoch,
    ],
  );

  const select = useCallback(
    (id: string, key: string, requestContext = false) => {
      inspectionRevision.current += 1;
      cancel();
      if (requestContext) contextRequest.current = { game, actorId: id, key };
      const s = useGameStore.getState();
      chooseTileEntity(game, key, id);
      s.setUi({ hoverCell: null });
    },
    [cancel, game, ui.selectedUnit, ui.selectedArmy],
  );
  const inspect = useCallback(
    (key: string) => {
      inspectionRevision.current += 1;
      cancel();
      inspectTile(game, key);
    },
    [cancel, game],
  );
  const selectNearbyHq = useCallback(
    (key: string) => {
      inspectionRevision.current += 1;
      cancel();
      chooseNearbyHq(game, key);
    },
    [cancel, game],
  );
  const deselect = useCallback(() => {
    inspectionRevision.current += 1;
    cancel();
    useGameStore
      .getState()
      .setUi({ selectedArmy: null, selectedUnit: null, selectedEntity: null, checkedUnits: [] });
  }, [cancel]);

  const issue = useCallback(
    (command: MapCommand, forcePreview = false, dragging = false) => {
      const current = useGameStore.getState();
      if (
        current.game !== game ||
        !enabled ||
        current.handoff ||
        current.quitPrompt ||
        selectedActor(game, current.ui)?.id !== command.actorId
      )
        return;
      clearTimeout(timer.current);
      const quick = command.kind === 'move' ? preferences.quickMove : preferences.quickAttack;
      if (!forcePreview && (quick || command.kind === 'action')) {
        cancel();
        dispatchMapCommand(command);
      } else {
        replacePending({ game: current.game, command, dragging });
        current.setUi({ hoverCell: command.target });
        setDwelled(command.target);
        setExiting(false);
      }
    },
    [game, enabled, preferences.quickMove, preferences.quickAttack, cancel, replacePending],
  );

  const interact = useCallback(
    (intent: SceneInteraction): boolean => {
      const current = useGameStore.getState();
      if (
        current.game !== game ||
        current.handoff ||
        current.quitPrompt ||
        current.ui.selectedArmy !== ui.selectedArmy ||
        current.ui.selectedUnit !== ui.selectedUnit
      )
        return true;
      if (intent.source === 'context') {
        if (validPending) return true;
        if (intent.targetKey && enabled) {
          inspect(intent.targetKey);
          {
            const occupants = visibleTileEntities(game, intent.targetKey);
            if (occupants.length === 1 && actor?.id !== occupants[0]!.id)
              contextRequest.current = { game, actorId: occupants[0]!.id, key: intent.targetKey };
            else {
              clearTimeout(timer.current);
              setHover({ key: intent.targetKey, selection });
              setDwelled(intent.targetKey);
              setContextPinned(true);
              setExiting(false);
            }
          }
        }
        return true;
      }
      if (intent.button === 2) {
        cancel();
        return false;
      }
      if (!enabled) return blocked;
      if (intent.source === 'drag') {
        if (intent.stage === 'cancel') {
          cancel();
          return true;
        }
        const command = intent.targetKey ? resolveCommand(intent.targetKey, targetingMode) : null;
        if (command) issue(command, true, intent.stage !== 'end');
        else {
          replacePending(null);
          useGameStore.getState().setUi({ hoverCell: null });
        }
        return true;
      }
      if (!intent.targetKey) {
        cancel();
        return false;
      }
      if (intent.source === 'click') setContextPinned(false);
      const occupants = visibleTileEntities(game, intent.targetKey);
      if (
        occupants.length === 1 &&
        occupants[0]!.id === actor?.id &&
        actor.pos === intent.targetKey
      ) {
        inspect(intent.targetKey);
        deselect();
        return true;
      }
      if (
        occupants.some((entity) =>
          entity.kind === 'node' || entity.kind === 'building'
            ? game.infrastructure?.capture.nodes.some(
                (node) =>
                  node.id === entity.nodeId && node.owner === (game.battle?.active ?? game.active),
              )
            : entity.kind === 'holder'
              ? entity.holder.team === game.active
              : entity.unit.team === game.battle?.active,
        )
      ) {
        inspect(intent.targetKey);
        return true;
      }
      // Inspect the ring tile without selecting an off-tile HQ or issuing a move.
      const nearbyHq = nearbyHqForTile(game, viewTeam(game), intent.targetKey);
      if (nearbyHq?.team === game.active) {
        inspect(intent.targetKey);
        return true;
      }
      // Owned empty node buildings remain body-click inspection targets. Their
      // explicit floating MOVE button is a separate, engine-validated intention.
      if (
        game.phase === 'strategic' &&
        isFriendlyNodeCenter(game, viewTeam(game), intent.targetKey)
      ) {
        const holder = holderForClick(game, viewTeam(game), intent.targetKey);
        if (!holder || holder.team === game.active) {
          cancel();
          return false;
        }
      }
      const command = resolveCommand(intent.targetKey, targetingMode);
      if (command) {
        issue(command);
        return true;
      }
      // Invalid explicit targeting must never fall through to the legacy click
      // heuristic, which could execute a DIFFERENT legal command immediately.
      if (targetingMode !== 'auto' || game.phase === 'battle') {
        inspect(intent.targetKey);
        return true;
      }
      inspect(intent.targetKey);
      return true;
    },
    [
      game,
      ui,
      actor?.id,
      actor?.pos,
      selection,
      targetingMode,
      enabled,
      blocked,
      validPending,
      issue,
      select,
      inspect,
      deselect,
      cancel,
      replacePending,
      resolveCommand,
    ],
  );

  const confirm = useCallback(() => {
    const current = useGameStore.getState();
    if (!pending || pendingRef.current !== pending) return;
    if (pending?.dragging) return;
    if (
      !pending ||
      blocked ||
      current.handoff ||
      current.quitPrompt ||
      !current.game ||
      !pendingValid(pending, current.game, current.ui)
    ) {
      cancel();
      return;
    }
    const command = pending.command;
    cancel();
    dispatchMapCommand(command);
  }, [pending, blocked, cancel]);

  const scheduleCalloutExit = useCallback(() => {
    clearTimeout(timer.current);
    if (validPending || contextPinned || overCallout.current || focusWithinCallout.current) return;
    timer.current = setTimeout(() => {
      if (overCallout.current || focusWithinCallout.current) return;
      setExiting(true);
      timer.current = setTimeout(() => {
        if (overCallout.current || focusWithinCallout.current) return;
        setDwelled(null);
        setHover({ key: null, selection: null });
        useGameStore.getState().setUi({ hoverCell: null });
        setExiting(false);
      }, preferences.animationMs);
    }, preferences.dwellMs);
  }, [validPending, contextPinned, preferences.dwellMs, preferences.animationMs]);
  const retainCallout = useCallback(() => {
    clearTimeout(timer.current);
    setExiting(false);
  }, []);
  const calloutEnter = useCallback(() => {
    overCallout.current = true;
    retainCallout();
  }, [retainCallout]);
  const calloutLeave = useCallback(() => {
    overCallout.current = false;
    scheduleCalloutExit();
  }, [scheduleCalloutExit]);
  const calloutFocus = useCallback(() => {
    focusWithinCallout.current = true;
    retainCallout();
  }, [retainCallout]);
  const calloutBlur = useCallback(() => {
    focusWithinCallout.current = false;
    scheduleCalloutExit();
  }, [scheduleCalloutExit]);
  const targetKey =
    validPending?.command.target ?? (hover.selection === selection ? dwelled : null);
  const { hoverCommand, moveCommand, attackCommand, targetOccupants, previewKind, previewCommand } =
    useMemo(
      () => ({
        hoverCommand: enabled && targetKey ? resolveCommand(targetKey, targetingMode) : null,
        moveCommand: enabled && targetKey ? resolveCommand(targetKey, 'move') : null,
        attackCommand: enabled && targetKey ? resolveCommand(targetKey, 'attack') : null,
        targetOccupants: enabled && targetKey ? selectableAt(game, targetKey) : [],
        previewCommand: enabled
          ? (validPending?.command ??
            (previewKey ? resolveCommand(previewKey, targetingMode) : null))
          : null,
        previewKind:
          validPending?.command.kind ??
          (targetingMode !== 'auto'
            ? targetingMode
            : previewKey
              ? (resolveCommand(previewKey)?.kind ?? null)
              : null),
      }),
      [enabled, targetKey, resolveCommand, targetingMode, game, validPending, previewKey],
    );
  return {
    preferences,
    setPreference,
    pending: validPending,
    enabled,
    actor,
    actions,
    previewKey,
    previewKind,
    previewCommand,
    selectionScope,
    targetKey,
    hoverCommand,
    moveCommand,
    attackCommand,
    targetOccupants,
    nearbyHq: targetKey ? nearbyHqForTile(game, viewTeam(game), targetKey) : undefined,
    selectNearbyHq,
    inspectionKey: ui.inspectedCell,
    inspectionSelection: ui.selectedEntity,
    inspectionEntities: ui.inspectedCell ? visibleTileEntities(game, ui.inspectedCell) : [],
    inspect,
    anchors,
    setAnchors,
    exiting,
    targetingMode,
    setTargetingMode,
    targetingOptions: options,
    onHover,
    interact,
    issue,
    select,
    deselect,
    confirm,
    cancel,
    calloutEnter,
    calloutLeave,
    calloutFocus,
    calloutBlur,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { GameState } from '@iron-ridge/engine';
import { worldOf } from '@iron-ridge/engine';
import { useGameStore } from '../stores/useGameStore.ts';
import type { UiState } from '../stores/useGameStore.ts';
import {
  actorActions,
  commandAt,
  controlsEnabled,
  pendingValid,
  selectableAt,
  selectedActor,
  targetingOptions,
} from './commands.ts';
import type { MapCommand, PendingCommand, TargetingMode } from './commands.ts';
import { holderForClick, isFriendlyNodeCenter } from '../lib/holders.ts';
import { viewTeam } from '../stores/useGameStore.ts';
import { readControlPreferences, saveControlPreferences } from './preferences.ts';
import type { ControlPreferences } from './preferences.ts';
import type { SceneInteraction, SceneTileAnchor } from './types.ts';

export interface MapControls {
  preferences: ControlPreferences;
  setPreference: (patch: Partial<ControlPreferences>) => void;
  pending: PendingCommand | null;
  enabled: boolean;
  actor: ReturnType<typeof selectedActor>;
  actions: MapCommand[];
  previewKey: string | null;
  previewKind: MapCommand['kind'] | null;
  selectionScope: string;
  targetKey: string | null;
  hoverCommand: MapCommand | null;
  moveCommand: MapCommand | null;
  attackCommand: MapCommand | null;
  targetOccupants: ReturnType<typeof selectableAt>;
  anchors: readonly SceneTileAnchor[];
  setAnchors: Dispatch<SetStateAction<readonly SceneTileAnchor[]>>;
  exiting: boolean;
  targetingMode: TargetingMode;
  setTargetingMode: Dispatch<SetStateAction<TargetingMode>>;
  targetingOptions: ReturnType<typeof targetingOptions>;
  onHover: (key: string | null) => void;
  interact: (intent: SceneInteraction) => boolean;
  issue: (command: MapCommand, forcePreview?: boolean, dragging?: boolean) => void;
  select: (id: string, key: string) => void;
  confirm: () => void;
  cancel: () => void;
  calloutEnter: () => void;
  calloutLeave: () => void;
}

/** Keep selection/territory inspection in step with the successful engine order. */
function dispatchMapCommand(command: MapCommand): void {
  const store = useGameStore.getState();
  if (!store.dispatch(command.action) || command.action.type !== 'moveCommander') return;
  const next = useGameStore.getState();
  const moved = next.game?.armies.find((army) => army.id === command.actorId);
  const destinationMain = next.game
    ? (worldOf(next.game).world.subByKey.get(command.target)?.main ?? null)
    : null;
  next.setUi({ selectedMain: moved?.at ?? destinationMain, selectedArmy: moved?.id ?? null });
}

export function useMapControls(game: GameState, ui: UiState, blocked: boolean): MapControls {
  const [preferences, setPreferences] = useState(readControlPreferences);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const pendingRef = useRef<PendingCommand | null>(null);
  const replacePending = useCallback((next: PendingCommand | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);
  const [targetingMode, setTargetingMode] = useState<TargetingMode>('auto');
  const [hover, setHover] = useState<{ key: string | null; selection: string | null }>({
    key: null,
    selection: null,
  });
  const [dwelled, setDwelled] = useState<string | null>(null);
  const [exiting, setExiting] = useState(false);
  const [anchors, setAnchors] = useState<readonly SceneTileAnchor[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const overCallout = useRef(false);
  const revision = useRef({ game, id: 0 });
  if (revision.current.game !== game) revision.current = { game, id: revision.current.id + 1 };
  const enabled = !blocked && controlsEnabled(game);
  const actor = selectedActor(game, ui);
  const selection = actor?.id ?? null;
  const selectionScope = `${revision.current.id}:${selection ?? ''}:${blocked}`;
  const validPending = pending && enabled && pendingValid(pending, game, ui) ? pending : null;
  const hoverKey = enabled && hover.selection === selection ? hover.key : null;
  const previewKey = validPending?.command.target ?? hoverKey;
  const actions = enabled ? actorActions(game, ui) : [];

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    replacePending(null);
    setTargetingMode('auto');
    setHover({ key: null, selection: null });
    setDwelled(null);
    setExiting(false);
    overCallout.current = false;
    useGameStore.getState().setUi({ hoverCell: null });
  }, [replacePending]);

  useEffect(() => {
    cancel();
  }, [selection, game, blocked, cancel]);

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

  const setPreference = useCallback((patch: Partial<ControlPreferences>) => {
    setPreferences((previous) => {
      const next = { ...previous, ...patch };
      saveControlPreferences(next);
      return next;
    });
  }, []);

  const onHover = useCallback(
    (key: string | null) => {
      if (!enabled || validPending) return;
      const current = useGameStore.getState();
      if (current.game !== game || (selectedActor(game, current.ui)?.id ?? null) !== selection)
        return;
      if (!key && overCallout.current) return;
      clearTimeout(timer.current);
      setExiting(false);
      // Retain the tile intent during the exit delay so crossing into its
      // overlapping callout/bridge does not remove and recreate the preview.
      if (key || !dwelled) {
        setHover({ key, selection });
        useGameStore.getState().setUi({ hoverCell: key });
      }
      timer.current = setTimeout(() => {
        if (!overCallout.current) {
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
    [enabled, validPending, selection, game, dwelled, preferences.dwellMs, preferences.animationMs],
  );

  const select = useCallback(
    (id: string, key: string) => {
      cancel();
      const s = useGameStore.getState();
      if (game.phase === 'battle')
        s.setUi({ selectedUnit: id === ui.selectedUnit ? null : id, hoverCell: null });
      else
        s.setUi({
          selectedArmy: id === ui.selectedArmy ? null : id,
          selectedMain: worldOf(game).world.subByKey.get(key)?.main ?? null,
          checkedUnits: [],
          hoverCell: null,
        });
    },
    [cancel, game, ui.selectedUnit, ui.selectedArmy],
  );

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
          if (
            game.phase === 'strategic' &&
            isFriendlyNodeCenter(game, viewTeam(game), intent.targetKey) &&
            !holderForClick(game, viewTeam(game), intent.targetKey)
          ) {
            cancel();
            return false;
          }
          const command = commandAt(game, ui, intent.targetKey, targetingMode);
          if (command) issue(command, true);
          else {
            const occupants = selectableAt(game, intent.targetKey);
            if (occupants[0] && actor?.pos !== intent.targetKey)
              select(occupants[0].id, intent.targetKey);
            setDwelled(intent.targetKey);
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
        const command = intent.targetKey
          ? commandAt(game, ui, intent.targetKey, targetingMode)
          : null;
        if (command) issue(command, true, intent.stage !== 'end');
        else {
          replacePending(null);
          useGameStore.getState().setUi({ hoverCell: null });
        }
        return true;
      }
      if (!intent.targetKey) return false;
      if (
        actor &&
        (actor.pos === intent.targetKey ||
          (game.phase === 'strategic' &&
            holderForClick(game, viewTeam(game), intent.targetKey)?.id === actor.id))
      ) {
        select(actor.id, intent.targetKey);
        return true;
      }
      const occupants = selectableAt(game, intent.targetKey);
      const selectedOccupant = occupants.find((occupant) => occupant.id === actor?.id);
      if (selectedOccupant || occupants[0]) {
        select((selectedOccupant ?? occupants[0])!.id, intent.targetKey);
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
      const command = commandAt(game, ui, intent.targetKey, targetingMode);
      if (command) {
        issue(command);
        return true;
      }
      // Invalid explicit targeting must never fall through to the legacy click
      // heuristic, which could execute a DIFFERENT legal command immediately.
      if (targetingMode !== 'auto' || game.phase === 'battle') {
        replacePending(null);
        useGameStore.getState().setUi({ hoverCell: null });
        return true;
      }
      cancel();
      return false;
    },
    [
      game,
      ui,
      actor?.id,
      actor?.pos,
      targetingMode,
      enabled,
      blocked,
      validPending,
      issue,
      select,
      cancel,
      replacePending,
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

  const calloutEnter = useCallback(() => {
    overCallout.current = true;
    clearTimeout(timer.current);
    setExiting(false);
  }, []);
  const calloutLeave = useCallback(() => {
    overCallout.current = false;
    if (!validPending)
      timer.current = setTimeout(() => {
        setExiting(true);
        timer.current = setTimeout(() => {
          setDwelled(null);
          setHover({ key: null, selection: null });
          useGameStore.getState().setUi({ hoverCell: null });
          setExiting(false);
        }, preferences.animationMs);
      }, preferences.dwellMs);
  }, [validPending, preferences.dwellMs, preferences.animationMs]);
  const targetKey =
    validPending?.command.target ?? (hover.selection === selection ? dwelled : null);
  const hoverCommand = enabled && targetKey ? commandAt(game, ui, targetKey, targetingMode) : null;
  const moveCommand = enabled && targetKey ? commandAt(game, ui, targetKey, 'move') : null;
  const attackCommand = enabled && targetKey ? commandAt(game, ui, targetKey, 'attack') : null;
  const targetOccupants = enabled && targetKey ? selectableAt(game, targetKey) : [];
  const previewKind =
    validPending?.command.kind ??
    (targetingMode !== 'auto'
      ? targetingMode
      : previewKey
        ? (commandAt(game, ui, previewKey)?.kind ?? null)
        : null);
  return {
    preferences,
    setPreference,
    pending: validPending,
    enabled,
    actor,
    actions,
    previewKey,
    previewKind,
    selectionScope,
    targetKey,
    hoverCommand,
    moveCommand,
    attackCommand,
    targetOccupants,
    anchors,
    setAnchors,
    exiting,
    targetingMode,
    setTargetingMode,
    targetingOptions: targetingOptions(game, ui),
    onHover,
    interact,
    issue,
    select,
    confirm,
    cancel,
    calloutEnter,
    calloutLeave,
  };
}

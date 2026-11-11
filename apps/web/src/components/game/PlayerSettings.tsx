import { useEffect, useState } from 'react';
import {
  subscribeControlPreferences,
  readControlPreferences,
  saveControlPreferences,
} from '../../controls/preferences.ts';
import type { ControlPreferences } from '../../controls/preferences.ts';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';
import { InterfaceDialog } from '../ui/InterfaceDialog.tsx';
import { AI_PACE_KEY, readAiPace } from '../../lib/playerPreferences.ts';

export function PlayerSettings({ onClose }: { onClose: () => void }): React.ReactElement {
  const [preferences, setPreferences] = useState(readControlPreferences);
  const aiSpeed = useGameStore((state) => state.aiSpeed);
  useEffect(() => {
    useGameStore.getState().setAiSpeed(readAiPace());
    return subscribeControlPreferences(setPreferences);
  }, []);
  const update = (patch: Partial<ControlPreferences>): void => {
    const next = { ...readControlPreferences(), ...patch };
    setPreferences(next);
    saveControlPreferences(next);
  };
  return (
    <InterfaceDialog label="Player Settings" onClose={onClose}>
      <div className="flex items-center justify-between gap-2">
        <h2>SETTINGS</h2>
        <Button size="sm" onClick={onClose} autoFocus>
          CLOSE SETTINGS
        </Button>
      </div>
      <label className="flex items-center justify-between gap-2">
        AI pace
        <select
          aria-label="AI pace"
          value={aiSpeed}
          onChange={(event) => {
            const speed = Number(event.target.value);
            useGameStore.getState().setAiSpeed(speed);
            try {
              localStorage.setItem(AI_PACE_KEY, String(speed));
            } catch {
              /* Optional. */
            }
          }}
        >
          <option value={450}>Slow</option>
          <option value={220}>Normal</option>
          <option value={60}>Fast</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={preferences.quickMove}
          onChange={(event) => update({ quickMove: event.target.checked })}
        />{' '}
        Quick Move
      </label>
      <label>
        <input
          type="checkbox"
          checked={preferences.quickAttack}
          onChange={(event) => update({ quickAttack: event.target.checked })}
        />{' '}
        Quick Attack
      </label>
      <label>
        Hover enter / exit delay: {preferences.dwellMs} ms
        <input
          aria-label="Hover delay"
          type="range"
          min="0"
          max="1500"
          step="50"
          value={preferences.dwellMs}
          onChange={(event) => update({ dwellMs: Number(event.target.value) })}
        />
      </label>
      <label>
        Animation: {preferences.animationMs} ms
        <input
          aria-label="Animation duration"
          type="range"
          min="0"
          max="500"
          step="20"
          value={preferences.animationMs}
          onChange={(event) => update({ animationMs: Number(event.target.value) })}
        />
      </label>
      <label>
        Animation easing
        <select
          value={preferences.easing}
          onChange={(event) =>
            update({ easing: event.target.value as ControlPreferences['easing'] })
          }
        >
          <option value="ease-out">Ease out</option>
          <option value="linear">Linear</option>
          <option value="ease-in-out">Ease in / out</option>
        </select>
      </label>
      <label>
        Tile-width overlap: {preferences.overlap}%
        <input
          aria-label="Tile-width overlap"
          type="range"
          min="0"
          max="75"
          step="5"
          value={preferences.overlap}
          onChange={(event) => update({ overlap: Number(event.target.value) })}
        />
      </label>
      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
        Player preferences are stored in this browser. Reduced motion follows your device.
      </p>
    </InterfaceDialog>
  );
}
export default PlayerSettings;

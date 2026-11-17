export interface ControlPreferences {
  quickMove: boolean;
  quickAttack: boolean;
  dwellMs: number;
  animationMs: number;
  easing: 'linear' | 'ease-out' | 'ease-in-out';
  overlap: number;
}
export const CONTROL_PREFERENCES_KEY = 'iron-ridge:proposed-map-controls:v1';
export const CONTROL_PREFERENCES_CHANGED = 'iron-ridge:control-preferences-changed';
export const DEFAULT_CONTROL_PREFERENCES: ControlPreferences = {
  quickMove: false,
  quickAttack: false,
  dwellMs: 500,
  animationMs: 120,
  easing: 'ease-out',
  overlap: 25,
};
let sessionOnly: ControlPreferences | null = null;
let lastKnown: ControlPreferences | null = null;

function normalize(raw: unknown): ControlPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONTROL_PREFERENCES };
  const value = raw as Partial<ControlPreferences>;
  const number = (key: 'dwellMs' | 'animationMs' | 'overlap', min: number, max: number): number =>
    typeof value[key] === 'number' && Number.isFinite(value[key])
      ? Math.min(max, Math.max(min, value[key]))
      : DEFAULT_CONTROL_PREFERENCES[key];
  return {
    quickMove: value.quickMove === true,
    quickAttack: value.quickAttack === true,
    dwellMs: number('dwellMs', 0, 1500),
    animationMs: number('animationMs', 0, 500),
    easing: value.easing === 'linear' || value.easing === 'ease-in-out' ? value.easing : 'ease-out',
    overlap: number('overlap', 0, 75),
  };
}
function parse(raw: string | null): ControlPreferences {
  try {
    return normalize(JSON.parse(raw ?? 'null'));
  } catch {
    return { ...DEFAULT_CONTROL_PREFERENCES };
  }
}
export function readControlPreferences(): ControlPreferences {
  if (sessionOnly) return { ...sessionOnly };
  try {
    lastKnown = parse(localStorage.getItem(CONTROL_PREFERENCES_KEY));
    return { ...lastKnown };
  } catch {
    return { ...(lastKnown ?? DEFAULT_CONTROL_PREFERENCES) };
  }
}
export function saveControlPreferences(value: ControlPreferences): void {
  const next = normalize(value);
  lastKnown = sessionOnly = next;
  try {
    localStorage.setItem(CONTROL_PREFERENCES_KEY, JSON.stringify(next));
    sessionOnly = null;
  } catch {
    /* Browser storage is optional. */
  }
  window.dispatchEvent(
    new CustomEvent<ControlPreferences>(CONTROL_PREFERENCES_CHANGED, { detail: { ...next } }),
  );
}

/** Live snapshots are authoritative; optional storage must not undo this tab's edits. */
export function subscribeControlPreferences(
  update: (value: ControlPreferences) => void,
): () => void {
  const changed = (event: Event): void => {
    update(event instanceof CustomEvent ? normalize(event.detail) : readControlPreferences());
  };
  const stored = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== CONTROL_PREFERENCES_KEY) return;
    lastKnown = sessionOnly =
      event.key === null ? { ...DEFAULT_CONTROL_PREFERENCES } : parse(event.newValue);
    update({ ...lastKnown });
  };
  window.addEventListener(CONTROL_PREFERENCES_CHANGED, changed);
  window.addEventListener('storage', stored);
  return () => {
    window.removeEventListener(CONTROL_PREFERENCES_CHANGED, changed);
    window.removeEventListener('storage', stored);
  };
}

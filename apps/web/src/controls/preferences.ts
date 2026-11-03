export interface ControlPreferences {
  quickMove: boolean;
  quickAttack: boolean;
  dwellMs: number;
  animationMs: number;
  easing: 'linear' | 'ease-out' | 'ease-in-out';
  overlap: number;
}
export const CONTROL_PREFERENCES_KEY = 'iron-ridge:proposed-map-controls:v1';
export const DEFAULT_CONTROL_PREFERENCES: ControlPreferences = {
  quickMove: false,
  quickAttack: false,
  dwellMs: 500,
  animationMs: 120,
  easing: 'ease-out',
  overlap: 25,
};
export function readControlPreferences(): ControlPreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CONTROL_PREFERENCES_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONTROL_PREFERENCES };
    const value = raw as Partial<ControlPreferences>;
    const number = (
      key: 'dwellMs' | 'animationMs' | 'overlap',
      min: number,
      max: number,
    ): number =>
      typeof value[key] === 'number' && Number.isFinite(value[key])
        ? Math.min(max, Math.max(min, value[key]))
        : DEFAULT_CONTROL_PREFERENCES[key];
    return {
      quickMove: value.quickMove === true,
      quickAttack: value.quickAttack === true,
      dwellMs: number('dwellMs', 0, 1500),
      animationMs: number('animationMs', 0, 500),
      easing:
        value.easing === 'linear' || value.easing === 'ease-in-out' ? value.easing : 'ease-out',
      overlap: number('overlap', 0, 75),
    };
  } catch {
    return { ...DEFAULT_CONTROL_PREFERENCES };
  }
}
export function saveControlPreferences(value: ControlPreferences): void {
  try {
    localStorage.setItem(CONTROL_PREFERENCES_KEY, JSON.stringify(value));
  } catch {
    /* Browser storage is optional. */
  }
}

export const AI_PACE_KEY = 'iron-ridge:ai-pacing:v1';
export function readAiPace(): number {
  try {
    const saved = Number(localStorage.getItem(AI_PACE_KEY));
    if ([60, 220, 450].includes(saved)) return saved;
  } catch {
    /* Optional browser convenience. */
  }
  return 220;
}

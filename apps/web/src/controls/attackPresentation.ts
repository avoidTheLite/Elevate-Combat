import type { AttackPreview, Team } from '@iron-ridge/engine';

/** Rules use the full preview; a fogged player's presentation must not inspect a hidden defender. */
export function concealBlindDefender(preview: AttackPreview, view: Team | null): boolean {
  return view !== null && preview.blind;
}

export function attackDetails(preview: AttackPreview, view: Team | null): string[] {
  const range = `${preview.kind} · ${preview.band} · effective range ${preview.effectiveRange}`;
  if (concealBlindDefender(preview, view))
    return [range, 'Blind fire: no spotter. Defender statistics are unknown.'];
  return [
    range,
    `TN ${preview.tn} · direct hit ${Math.round(preview.pDirect * 100)}% · splash ${Math.round(preview.pSplash * 100)}%`,
    `Expected damage ${preview.expectedDamage.toFixed(1)} · ${preview.los?.status ?? 'melee'}`,
    ...preview.modifiers.map((m) => `${m.label}: ${m.value > 0 ? '+' : ''}${m.value}`),
    ...(preview.blind ? ['Blind fire: no spotter.'] : []),
    'Probabilities are estimates; no outcome is promised.',
  ];
}

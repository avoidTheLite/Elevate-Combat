import type { GameSettings } from '@iron-ridge/engine';
import { GRID_LIMITS, createGame, validateGameState } from '@iron-ridge/engine';

/** A new-run recipe, deliberately separate from a SaveDocument's exact GameState. */
export interface CampaignScenarioDocument {
  kind: 'iron-ridge-campaign-configuration';
  version: 1;
  name: string;
  /** Feature-branch experiments can declare code they require before settings are consumed. */
  requiredCodeCapabilities?: readonly string[];
  settings: GameSettings;
}

export function configurationDocument(settings: GameSettings): CampaignScenarioDocument {
  return {
    kind: 'iron-ridge-campaign-configuration',
    version: 1,
    name: 'Custom campaign',
    requiredCodeCapabilities: [
      'campaign-configuration-v1',
      'commander-training-cp-v1',
      ...(settings.infrastructure ? ['infrastructure-nodes-v1'] : []),
      ...(settings.infrastructure?.nodes.placement?.mode === 'advanced' ? ['seeded-nodes-v1'] : []),
    ],
    settings,
  };
}

export function parseCampaignConfiguration(text: string): GameSettings {
  if (text.length > 2_000_000) throw new Error('Configuration file is too large (maximum 2 MB)');
  const doc = JSON.parse(text) as CampaignScenarioDocument;
  if (
    doc?.kind !== 'iron-ridge-campaign-configuration' ||
    doc.version !== 1 ||
    typeof doc.name !== 'string' ||
    !doc.name.trim()
  )
    throw new Error(
      'Choose a campaign configuration (version 1). Use Resume saved game for a save file.',
    );
  const supported = new Set([
    'campaign-configuration-v1',
    'commander-training-cp-v1',
    'infrastructure-nodes-v1',
    'seeded-nodes-v1',
  ]);
  if (
    doc.requiredCodeCapabilities !== undefined &&
    (!Array.isArray(doc.requiredCodeCapabilities) ||
      doc.requiredCodeCapabilities.some(
        (capability) => typeof capability !== 'string' || !supported.has(capability),
      ))
  )
    throw new Error(
      'This configuration requires code capabilities unavailable in this build. Open it on the matching feature branch.',
    );
  const s = doc.settings;
  if (
    !s ||
    !['ww2', 'medieval'].includes(s.era) ||
    !s.grid ||
    Object.entries(GRID_LIMITS).some(([key, limit]) => {
      const value = s.grid[key as keyof typeof s.grid];
      return !Number.isInteger(value) || value < limit.min || value > limit.max;
    }) ||
    !Number.isSafeInteger(s.seed) ||
    s.seed < 0 ||
    s.seed > 0xffffffff ||
    typeof s.fog !== 'boolean' ||
    !s.controllers ||
    ![s.controllers.A, s.controllers.B].every((c) => ['human', 'ai'].includes(c)) ||
    !Number.isInteger(s.battleRounds) ||
    s.battleRounds < 1 ||
    s.battleRounds > 100 ||
    !Number.isSafeInteger(s.commanderTrainingCp) ||
    (s.commanderTrainingCp ?? 0) <= 0
  )
    throw new Error(
      'Invalid campaign settings: include a valid map, players, seed and positive commander training CP price.',
    );
  const errors = validateGameState(createGame(s));
  if (errors.length) throw new Error(errors.join('; '));
  return s;
}

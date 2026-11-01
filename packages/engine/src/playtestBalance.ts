// Editable trial values for the regular strategic-objectives playtest.
// The committed unit catalogue and older games without this explicit override
// retain their baseline. These values are a playtest proposal, not final balance.
import type { RulesOverride } from './rules.ts';

export const PLAYTEST_BALANCE_NAME = 'Strategic objectives — trial balance 1';

export const PLAYTEST_BALANCE_RULES: RulesOverride = {
  units: {
    ww2_tank: { maxRange: 8 },
    ww2_at_infantry: { maxRange: 10, profile: 'bazooka' },
    ww2_artillery: { hp: 8 },
  },
  mechanics: {
    TANK_MOVED_FIRE_ADJUSTMENT: -2,
    BAZOOKA_ACCURATE_RANGE: 5,
    BAZOOKA_CLOSE_TN: -5,
    BAZOOKA_FAR_TN: 4,
    FACING_MODS: { side: { tn: -3 } },
  },
};

// GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002; GAMES-ELEVATE-SESSION-UC-001.
import { describe, expect, it } from 'vitest';
import {
  apply,
  createGame,
  createFoundationPlaytestConfiguration,
  defaultSettings,
  deserializeSave,
  serializeSave,
} from './index.ts';

describe('approved new-campaign prices and saved configuration continuity', () => {
  it('charges the 15 CP default for a new commander split', () => {
    const state = createGame(defaultSettings());
    const source = state.armies.find(
      (holder) => holder.team === 'A' && holder.kind === 'commander',
    )!;
    const result = apply(state, {
      type: 'formCommander',
      fromId: source.id,
      unitIds: [source.units[0]!.id],
    });
    expect(result.error).toBeNull();
    expect(result.state.cp.A).toBe(state.cp.A - 15);
    expect(result.state.armies.filter((holder) => holder.kind === 'commander')).toHaveLength(3);
  });

  it('defaults only new infrastructure recipes to Capture5/Raze2 and keeps explicit saved prices', () => {
    expect(createFoundationPlaytestConfiguration().nodes.captureCosts).toEqual({
      capture: 5,
      raze: 2,
    });
    const old = createGame({
      ...defaultSettings(),
      commanderTrainingCp: 11,
      infrastructure: createFoundationPlaytestConfiguration(7, 3),
    });
    const loaded = deserializeSave(serializeSave(old));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.save.state).toEqual(old);
    expect(loaded.save.state.settings.infrastructure!.nodes.captureCosts).toEqual({
      capture: 7,
      raze: 3,
    });
    expect(loaded.save.state.settings.commanderTrainingCp).toBe(11);
  });
});

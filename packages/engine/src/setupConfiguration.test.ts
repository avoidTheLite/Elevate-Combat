// GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002; GAMES-ELEVATE-SESSION-UC-001: setup and saved rules.
import { describe, expect, it } from 'vitest';
import {
  apply,
  createGame,
  defaultSettings,
  createFoundationPlaytestConfiguration,
  serializeSave,
  deserializeSave,
  validateGameState,
  campaignNodeViews,
  aiStep,
} from './index.ts';
import type { GameSettings } from './types.ts';
import type { CampaignNodePlacement } from './foundation/campaignNodes.ts';

function configured(
  placement: CampaignNodePlacement = { mode: 'simple' },
): GameSettings & { infrastructure: NonNullable<GameSettings['infrastructure']> } {
  const infrastructure = createFoundationPlaytestConfiguration(7, 3);
  return {
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
    commanderTrainingCp: 11,
    infrastructure: { ...infrastructure, nodes: { ...infrastructure.nodes, placement } },
  };
}

describe('setup map configuration', () => {
  it('leaves Classic without nodes and makes one site per MainHex in Simple', () => {
    expect(createGame(defaultSettings()).infrastructure).toBeUndefined();
    const game = createGame(configured());
    expect(game.infrastructure!.sites).toHaveLength(
      game.settings.grid.mainCols * game.settings.grid.mainRows,
    );
    expect(campaignNodeViews(game)).toHaveLength(game.infrastructure!.sites.length);
    expect(validateGameState(game)).toEqual([]);
  });
  it('seeds an exact subset with both HQs, repeatably, without consuming gameplay RNG', () => {
    const settings = configured({ mode: 'advanced', seed: 123, additionalNodes: 7 });
    const first = createGame(settings);
    const second = createGame(settings);
    expect(first.infrastructure!.sites).toEqual(second.infrastructure!.sites);
    expect(first.infrastructure!.sites).toHaveLength(9);
    for (const team of ['A', 'B'] as const)
      expect(
        first.infrastructure!.sites.some(
          (site) => site.mainHex === first.hq[team] && site.homeTeam === team,
        ),
      ).toBe(true);
    const another = createGame(configured({ mode: 'advanced', seed: 124, additionalNodes: 7 }));
    expect(another.infrastructure!.sites).not.toEqual(first.infrastructure!.sites);
    expect(first.rng).toBe(createGame(configured()).rng);
    expect(validateGameState(first)).toEqual([]);
    expect(deserializeSave(serializeSave(first))).toMatchObject({
      ok: true,
      save: { state: first },
    });
    let advanced = first;
    for (let n = 0; n < 25 && advanced.phase !== 'over'; n++) {
      const action = aiStep(advanced);
      if (!action) break;
      const result = apply(advanced, action);
      expect(result.error).toBeNull();
      advanced = result.state;
      expect(validateGameState(advanced)).toEqual([]);
    }
  });
  it('rejects invalid placement and preserves legacy site registries on reload', () => {
    expect(() =>
      createGame(configured({ mode: 'advanced', seed: -1, additionalNodes: 2 })),
    ).toThrow();
    expect(() =>
      createGame(configured({ mode: 'advanced', seed: 1, additionalNodes: 999 })),
    ).toThrow();
    const settings = configured();
    Object.assign(settings.infrastructure, {
      nodes: createFoundationPlaytestConfiguration(7, 3).nodes,
    });
    const legacy = createGame(settings);
    expect(deserializeSave(serializeSave(legacy))).toMatchObject({
      ok: true,
      save: { state: legacy },
    });
    const changed = createGame(configured({ mode: 'advanced', seed: 1, additionalNodes: 3 }));
    Object.assign(changed.infrastructure!, { sites: legacy.infrastructure!.sites });
    expect(validateGameState(changed).length).toBeGreaterThan(0);
  });
});

describe('configured commander CP transactions', () => {
  it.each([false, true])(
    'charges exactly once after legal formation, infrastructure=%s',
    (enabled) => {
      const game = createGame(
        enabled ? configured() : { ...defaultSettings(), commanderTrainingCp: 11 },
      );
      const commander = game.armies.find(
        (holder) => holder.team === 'A' && holder.kind === 'commander',
      )!;
      const action = {
        type: 'formCommander' as const,
        fromId: commander.id,
        unitIds: [commander.units[0]!.id],
      };
      const before = structuredClone(game);
      const result = apply(game, action);
      expect(result.error).toBeNull();
      expect(game).toEqual(before);
      expect(result.state.cp.A).toBe(game.cp.A - 11);
      expect(result.state.armies).toHaveLength(game.armies.length + 1);
      expect(validateGameState(result.state)).toEqual([]);
      expect(deserializeSave(serializeSave(result.state))).toMatchObject({
        ok: true,
        save: { state: result.state },
      });
      const duplicate = apply(result.state, action);
      expect(duplicate.error).not.toBeNull();
      expect(duplicate.state).toEqual(result.state);
    },
  );
  it('does not spend CP, units or ids when unaffordable or otherwise illegal', () => {
    const game = createGame({ ...defaultSettings(), commanderTrainingCp: 11 });
    game.cp.A = 10;
    const commander = game.armies.find(
      (holder) => holder.team === 'A' && holder.kind === 'commander',
    )!;
    const before = structuredClone(game);
    for (const unitIds of [
      [commander.units[0]!.id],
      ['missing'],
      commander.units.map((unit) => unit.id),
    ]) {
      const result = apply(game, { type: 'formCommander', fromId: commander.id, unitIds });
      expect(result.error).not.toBeNull();
      expect(result.state).toEqual(before);
      expect(game).toEqual(before);
    }
  });
  it('restores old saves without charging existing commanders but requires an explicit price for new formation', () => {
    const settings = defaultSettings();
    delete settings.commanderTrainingCp;
    const game = createGame(settings);
    const commander = game.armies.find(
      (holder) => holder.team === 'A' && holder.kind === 'commander',
    )!;
    const resumed = deserializeSave(serializeSave(game));
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.save.state).toEqual(game);
    const blocked = apply(resumed.save.state, {
      type: 'formCommander',
      fromId: commander.id,
      unitIds: [commander.units[0]!.id],
    });
    expect(blocked.error).toMatch(/Configure a commander training CP price/);
    expect(blocked.state).toEqual(game);
    const configured = apply(resumed.save.state, {
      type: 'configureCommanderTraining',
      cpCost: 11,
    });
    expect(configured.error).toBeNull();
    expect(configured.state.cp).toEqual(game.cp);
    expect(configured.state.armies).toEqual(game.armies);
    const formed = apply(configured.state, {
      type: 'formCommander',
      fromId: commander.id,
      unitIds: [commander.units[0]!.id],
    });
    expect(formed.error).toBeNull();
    expect(formed.state.cp.A).toBe(game.cp.A - 11);
  });
});

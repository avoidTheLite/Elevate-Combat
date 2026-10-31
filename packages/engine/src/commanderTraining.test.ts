// GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002; GAMES-ELEVATE-SESSION-UC-001: confirmed creation cost.
import { describe, expect, it } from 'vitest';
import {
  apply,
  createGame,
  defaultSettings,
  createFoundationPlaytestConfiguration,
  serializeSave,
  deserializeSave,
  validateGameState,
  garrisonOf,
  commanderReach,
} from './index.ts';
import type { GameState } from './types.ts';

function game(infrastructure = false, price: number | undefined = 11): GameState {
  return createGame({
    ...defaultSettings(),
    commanderTrainingCp: price,
    grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
    fog: false,
    controllers: { A: 'human', B: 'human' },
    ...(infrastructure ? { infrastructure: createFoundationPlaytestConfiguration(7, 3) } : {}),
  });
}
function commander(state: GameState): GameState['armies'][number] {
  return state.armies.find((holder) => holder.team === 'A' && holder.kind === 'commander')!;
}

describe('confirmed CP cost for every new commander', () => {
  it.each([false, true])(
    'charges both garrison formation and commander splits, infrastructure=%s',
    (infrastructure) => {
      for (const fromGarrison of [false, true]) {
        let state = game(infrastructure);
        if (fromGarrison) {
          const recruited = apply(state, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
          expect(recruited.error).toBeNull();
          state = recruited.state;
        }
        const source = fromGarrison ? garrisonOf(state, 'A')! : commander(state);
        const before = structuredClone(state);
        const result = apply(state, {
          type: 'formCommander',
          fromId: source.id,
          unitIds: [source.units[0]!.id],
        });
        expect(result.error).toBeNull();
        expect(state).toEqual(before);
        expect(result.state.cp.A).toBe(before.cp.A - 11);
        expect(result.state.armies.filter((holder) => holder.kind === 'commander')).toHaveLength(3);
        const made = result.state.armies.find(
          (holder) => !before.armies.some((old) => old.id === holder.id),
        )!;
        expect(made.movesLeft).toBe(fromGarrison ? 0 : source.movesLeft);
        expect(validateGameState(result.state)).toEqual([]);
        const saved = deserializeSave(serializeSave(result.state));
        expect(saved.ok && saved.save.state).toEqual(result.state);
      }
    },
  );
  it('rejects unaffordable garrison formation and splits without spending or removing units', () => {
    for (const fromGarrison of [false, true]) {
      let state = game();
      if (fromGarrison)
        state = apply(state, { type: 'recruit', typeId: 'ww2_rifle_infantry' }).state;
      state.cp.A = 10;
      const source = fromGarrison ? garrisonOf(state, 'A')! : commander(state);
      const before = structuredClone(state);
      const result = apply(state, {
        type: 'formCommander',
        fromId: source.id,
        unitIds: [source.units[0]!.id],
      });
      expect(result.error).toBe('Training a commander costs 11 CP');
      expect(result.state).toEqual(before);
      expect(state).toEqual(before);
    }
  });
  it('does not let missing configuration act as a free commander effect', () => {
    const state = game(false, undefined);
    delete state.settings.commanderTrainingCp;
    const before = structuredClone(state);
    const holder = commander(state);
    const formed = apply(state, {
      type: 'formCommander',
      fromId: holder.id,
      unitIds: [holder.units[0]!.id],
    });
    expect(formed.error).toMatch(/Configure a commander training CP price/);
    expect(formed.state).toEqual(before);
    for (const cpCost of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const configured = apply(state, { type: 'configureCommanderTraining', cpCost });
      expect(configured.error).toBe('Commander training requires a positive whole CP price');
      expect(configured.state).toEqual(before);
    }
    const configured = apply(state, { type: 'configureCommanderTraining', cpCost: 13 });
    expect(configured.error).toBeNull();
    expect(configured.state.cp).toEqual(before.cp);
    expect(configured.state.armies).toEqual(before.armies);
    const replacement = apply(configured.state, { type: 'configureCommanderTraining', cpCost: 1 });
    expect(replacement.error).toBe('Commander training CP price is already configured');
    expect(replacement.state).toEqual(configured.state);
  });
  it('merges troops back into an existing commander without charging or refunding creation CP', () => {
    const state = game();
    const original = commander(state);
    const formed = apply(state, {
      type: 'formCommander',
      fromId: original.id,
      unitIds: [original.units[0]!.id],
    });
    expect(formed.error).toBeNull();
    const fresh = formed.state.armies.find(
      (holder) => !state.armies.some((old) => old.id === holder.id),
    )!;
    const merged = apply(formed.state, {
      type: 'transferUnits',
      fromId: fresh.id,
      toId: original.id,
      unitIds: fresh.units.map((unit) => unit.id),
    });
    expect(merged.error).toBeNull();
    expect(merged.state.cp).toEqual(formed.state.cp);
    expect(merged.state.armies.some((holder) => holder.id === fresh.id)).toBe(false);
    expect(
      merged.state.armies
        .find((holder) => holder.id === original.id)!
        .units.map((unit) => unit.id)
        .sort(),
    ).toEqual(original.units.map((unit) => unit.id).sort());
  });

  it('restores existing commanders and preserves moves/transfers without creating or charging another', () => {
    const state = game();
    const restored = deserializeSave(serializeSave(state));
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.save.state).toEqual(state);
    const holder = commander(state);
    const destination = [...commanderReach(state, holder).keys()].find(
      (cell) => cell !== holder.pos,
    )!;
    const moved = apply(restored.save.state, {
      type: 'moveCommander',
      armyId: holder.id,
      dest: destination,
    });
    expect(moved.error).toBeNull();
    expect(moved.state.cp).toEqual(state.cp);
    expect(moved.state.armies.map((army) => army.id)).toEqual(state.armies.map((army) => army.id));
    const transferred = apply(state, {
      type: 'transferUnits',
      fromId: holder.id,
      toId: garrisonOf(state, 'A')!.id,
      unitIds: [holder.units[0]!.id],
    });
    expect(transferred.error).toBeNull();
    expect(transferred.state.cp).toEqual(state.cp);
    expect(transferred.state.armies.map((army) => army.id)).toEqual(
      state.armies.map((army) => army.id),
    );
    const old = game(false, undefined);
    delete old.settings.commanderTrainingCp;
    const oldSaved = deserializeSave(serializeSave(old));
    expect(oldSaved.ok && oldSaved.save.state).toEqual(old);
  });
});

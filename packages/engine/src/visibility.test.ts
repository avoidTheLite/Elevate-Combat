import { describe, expect, it } from 'vitest';
import { refreshOccupancy } from './battleMap.ts';
import {
  canSee,
  isHexRevealed,
  isUnitRevealed,
  revealedEnemies,
  visibleCells,
  visionRange,
} from './visibility.ts';
import { flatBattle, mkUnit } from './testBattle.ts';
import { unitType } from './units.ts';

/**
 * FOW terminology (after realign):
 * - visible*  — LOS detection (visionRange, canSee, visibleCells)
 * - revealed* — player knows about a unit/hex by any means (revealedEnemies, isHexRevealed)
 * - exposed   — fire-lingering flag that keeps a unit revealed without LOS
 */
describe('FOW — visible (LOS) vs revealed (player-detected)', () => {
  it('visionRange = base vision + floor(viewerHeight / 3)', () => {
    const { ctx, battle } = flatBattle([mkUnit('rif', 'ww2_rifle_infantry', 'A', '0,0')]);
    const u = battle.units[0]!;
    const base = unitType('ww2_rifle_infantry').vision;
    expect(visionRange(ctx, u)).toBe(base + Math.floor(2 / 3));

    const tall = {
      ...ctx,
      heightOf: (k: string) => (k === '0,0' ? 6 : ctx.heightOf(k)),
    };
    expect(visionRange(tall, u)).toBe(base + Math.floor(6 / 3));
  });

  it('canSee is true for own cell, false beyond vision or through blocking terrain', () => {
    const { ctx, battle } = flatBattle([mkUnit('rif', 'ww2_rifle_infantry', 'A', '0,0')]);
    const u = battle.units[0]!;
    expect(canSee(ctx, u, '0,0')).toBe(true);
    expect(canSee(ctx, u, '20,0')).toBe(false);

    const blocked = {
      ...ctx,
      heightOf: (k: string) => {
        if (k === '0,0' || k === '4,0') return 2;
        if (k === '2,0') return 9;
        return ctx.heightOf(k);
      },
    };
    expect(canSee(blocked, u, '4,0')).toBe(false);
  });

  it('revealedEnemies includes LOS contacts and fire-exposed units outside vision', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('a', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('near', 'ww2_rifle_infantry', 'B', '2,0'),
      mkUnit('far', 'ww2_rifle_infantry', 'B', '12,0'),
    ]);
    const seen = revealedEnemies(ctx, battle, 'A').map((u) => u.id);
    expect(seen).toContain('near');
    expect(seen).not.toContain('far');

    battle.units[2]!.exposed = true;
    expect(revealedEnemies(ctx, battle, 'A').map((u) => u.id)).toContain('far');
    expect(isUnitRevealed(ctx, battle, 'A', battle.units[2]!)).toBe(true);
  });

  it('isHexRevealed when a friendly canSee the hex or an exposed enemy occupies it', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('a', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('far', 'ww2_rifle_infantry', 'B', '12,0'),
    ]);
    expect(isHexRevealed(ctx, battle, 'A', '2,0')).toBe(true);
    expect(isHexRevealed(ctx, battle, 'A', '12,0')).toBe(false);

    battle.units[1]!.exposed = true;
    expect(isHexRevealed(ctx, battle, 'A', '12,0')).toBe(true);
  });

  it('visibleCells is LOS-only; exposed enemies do not expand the visible tile set', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('a', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('far', 'ww2_rifle_infantry', 'B', '12,0'),
    ]);
    battle.units[1]!.exposed = true;
    const cells = visibleCells(ctx, battle, 'A');
    expect(cells.has('0,0')).toBe(true);
    expect(cells.has('12,0')).toBe(false);
    expect(revealedEnemies(ctx, battle, 'A').some((u) => u.id === 'far')).toBe(true);
  });

  it('high ground extends viewer vision only (one-way FOW advantage)', () => {
    const { ctx, battle } = flatBattle([
      mkUnit('high', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('low', 'ww2_rifle_infantry', 'B', '8,0'),
    ]);
    const highCtx = {
      ...ctx,
      heightOf: (k: string) => {
        if (k === '0,0') return 6;
        if (ctx.cells.has(k)) return 0;
        return undefined;
      },
    };
    refreshOccupancy(highCtx, battle);
    const base = unitType('ww2_rifle_infantry').vision;
    expect(visionRange(highCtx, battle.units[0]!)).toBe(base + 2);
    expect(visionRange(highCtx, battle.units[1]!)).toBe(base);
  });
});

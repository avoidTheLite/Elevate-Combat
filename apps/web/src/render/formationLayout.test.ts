import { describe, expect, it } from 'vitest';
import { layoutFormation, type FormationMember } from './formationLayout.ts';

const member = (
  id: string,
  facing = 0,
  role: FormationMember['role'] = 'military',
  infantry = true,
): FormationMember => ({ id, facing, role, infantry, footprint: { length: 1, width: 0.6 } });
const EPS = 1e-9;

describe('procedural facing formation', () => {
  it('uses area limits rather than shrinking linear dimensions by a percentage', () => {
    const placements = layoutFormation([member('rifle'), member('tank', 3, 'military', false)]);
    const tileArea = (3 * Math.sqrt(3)) / 2;
    expect(placements.find((p) => p.id === 'rifle')!.areaLimit).toBeCloseTo(tileArea * 0.05);
    expect(placements.find((p) => p.id === 'tank')!.areaLimit).toBeCloseTo(tileArea * 0.1);
    for (const p of placements) {
      expect(p.projectedArea).toBeLessThanOrEqual(p.areaLimit);
      expect(p.projectedArea).toBeCloseTo(0.6 * p.scale ** 2);
    }
  });

  it('places opposite-facing units back to back on opposite sides of the centroid', () => {
    const p = layoutFormation([member('east', 0), member('west', 3)]);
    const east = p.find((unit) => unit.id === 'east')!;
    const west = p.find((unit) => unit.id === 'west')!;
    expect(east.x).toBeGreaterThan(0);
    expect(west.x).toBeLessThan(0);
    expect(east.z).toBeCloseTo(0);
    expect(west.z).toBeCloseTo(0);
    expect(Math.cos(east.angle - west.angle)).toBeCloseTo(-1);
    expect(east.x).toBeCloseTo(-west.x);
  });

  it('gives three evenly spaced facings equal thirds', () => {
    for (const p of layoutFormation([member('a', 0), member('b', 2), member('c', 4)]))
      expect(p.sector.end - p.sector.start).toBeCloseTo((2 * Math.PI) / 3);
  });

  it('uses one shared fit factor when one facing also has a support marker', () => {
    const p = layoutFormation([
      member('east', 0),
      member('west', 3),
      { ...member('marker', 0, 'support', false), footprint: { length: 1.8, width: 0.8 } },
    ]);
    expect(p.find((unit) => unit.id === 'east')!.scale).toBeCloseTo(
      p.find((unit) => unit.id === 'west')!.scale,
    );
    for (const unit of p) expect(unit.projectedArea).toBeLessThanOrEqual(unit.areaLimit);
  });

  it('keeps same-facing military side by side and support directly behind', () => {
    const p = layoutFormation([
      member('rifle-a'),
      member('rifle-b'),
      member('engineer-a', 0, 'support'),
      member('engineer-b', 0, 'support'),
    ]);
    const military = p.filter((unit) => unit.role === 'military');
    const support = p.filter((unit) => unit.role === 'support');
    expect(military[0]!.x).toBeCloseTo(military[1]!.x);
    expect(support[0]!.x).toBeCloseTo(support[1]!.x);
    expect(military[0]!.z).not.toBe(military[1]!.z);
    expect(Math.min(...military.map((unit) => unit.x))).toBeGreaterThan(
      Math.max(...support.map((unit) => unit.x)),
    );
  });

  it('retains every dense roster member, fits full footprints, and is input-order independent', () => {
    const units = Array.from({ length: 360 }, (_, i) =>
      member(`unit-${String(i).padStart(3, '0')}`, i % 6, i % 3 ? 'military' : 'support'),
    );
    const p = layoutFormation(units);
    expect(p).toHaveLength(units.length);
    expect(new Set(p.map((unit) => unit.id)).size).toBe(units.length);
    expect(layoutFormation([...units].reverse())).toEqual(p);
    const apothem = Math.sqrt(3) / 2;
    for (const unit of p) {
      expect(unit.scale).toBeGreaterThan(0);
      for (let side = 0; side < 6; side++) {
        const angle = (side * Math.PI) / 3;
        expect(
          unit.x * Math.cos(angle) + unit.z * Math.sin(angle) + unit.radius,
        ).toBeLessThanOrEqual(apothem + EPS);
      }
      for (const angle of [unit.sector.start + Math.PI / 2, unit.sector.end - Math.PI / 2])
        expect(unit.x * Math.cos(angle) + unit.z * Math.sin(angle)).toBeGreaterThanOrEqual(
          unit.radius - EPS,
        );
    }
    // Complete conservative footprints remain distinct, even between facing groups.
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++)
        expect(Math.hypot(p[i]!.x - p[j]!.x, p[i]!.z - p[j]!.z) + EPS).toBeGreaterThanOrEqual(
          p[i]!.radius + p[j]!.radius,
        );
  });

  it('moving a facing changes placement and keeps the declared direction', () => {
    const old = layoutFormation([member('unit', 0)])[0]!;
    const turned = layoutFormation([member('unit', 1)])[0]!;
    expect(turned.facing).toBe(1);
    expect(turned.x).not.toBe(old.x);
    expect(turned.z).not.toBe(old.z);
    expect(Math.atan2(turned.z, turned.x)).toBeCloseTo(-Math.PI / 3);
  });

  it('rejects duplicate identities and invalid inputs instead of losing units', () => {
    expect(() => layoutFormation([member('same'), member('same')])).toThrow(/unique/);
    expect(() => layoutFormation([member('bad', 6)])).toThrow(/facing/);
    expect(() =>
      layoutFormation([{ ...member('bad'), footprint: { length: 0, width: 1 } }]),
    ).toThrow(/footprint/);
  });
});

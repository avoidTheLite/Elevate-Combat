/** Visual placement only. The engine remains the authority for tile occupancy and facing. */
export interface FormationMember {
  id: string;
  facing: number;
  role: 'military' | 'support';
  infantry: boolean;
  /** Measured full model extents, before scale, along forward X and lateral Z. */
  footprint: { length: number; width: number };
}

export interface FormationPlacement {
  id: string;
  facing: number;
  role: FormationMember['role'];
  x: number;
  z: number;
  angle: number;
  scale: number;
  /** Conservative circle encloses the complete projected model rectangle. */
  radius: number;
  projectedArea: number;
  areaLimit: number;
  sector: { start: number; end: number };
}

const TAU = Math.PI * 2;
const angleOf = (facing: number): number => ((-facing * Math.PI) / 3 + TAU) % TAU;
const dot = (x: number, z: number, a: number): number => x * Math.cos(a) + z * Math.sin(a);

/**
 * Split the tile at bisectors between facing groups. Each group forms a military
 * front row and a support rear row. One shared fit factor preserves comparable
 * model sizes across facing groups. Fit uses measured bounds, so dense
 * formations become smaller rather than losing members or gaining stack limits.
 */
export function layoutFormation(
  members: readonly FormationMember[],
  tileRadius = 1,
): FormationPlacement[] {
  if (!Number.isFinite(tileRadius) || tileRadius <= 0) throw new Error('Invalid tile radius');
  const ids = new Set<string>();
  for (const member of members) {
    if (!member.id || ids.has(member.id)) throw new Error('Formation members need unique IDs');
    ids.add(member.id);
    if (!Number.isInteger(member.facing) || member.facing < 0 || member.facing > 5)
      throw new Error('Invalid formation facing');
    if (
      !Number.isFinite(member.footprint.length) ||
      !Number.isFinite(member.footprint.width) ||
      member.footprint.length <= 0 ||
      member.footprint.width <= 0
    )
      throw new Error('Invalid model footprint');
  }
  const tileArea = ((3 * Math.sqrt(3)) / 2) * tileRadius ** 2;
  const groups = [...new Set(members.map((member) => member.facing))]
    .map((facing) => ({ facing, angle: angleOf(facing) }))
    .sort((a, b) => a.angle - b.angle);
  const out: FormationPlacement[] = [];
  const groupFits = new Map<number, number>();
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;
    const previous = groups[(gi + groups.length - 1) % groups.length]!;
    const next = groups[(gi + 1) % groups.length]!;
    const start =
      groups.length === 1
        ? group.angle - Math.PI
        : group.angle - ((group.angle - previous.angle + TAU) % TAU) / 2;
    const end =
      groups.length === 1
        ? group.angle + Math.PI
        : group.angle + ((next.angle - group.angle + TAU) % TAU) / 2;
    const units = members
      .filter((member) => member.facing === group.facing)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((member) => {
        const areaLimit = tileArea * (member.infantry ? 0.05 : 0.1);
        const scale = Math.sqrt(areaLimit / (member.footprint.length * member.footprint.width));
        return {
          member,
          areaLimit,
          scale,
          radius: (Math.hypot(member.footprint.length, member.footprint.width) * scale) / 2,
          forward: 0,
          lateral: 0,
        };
      });
    const military = units.filter((unit) => unit.member.role === 'military');
    const support = units.filter((unit) => unit.member.role === 'support');
    const gap = tileRadius * 0.04;
    for (const row of [military, support]) {
      if (!row.length) continue;
      const rowWidth = row.reduce((sum, unit) => sum + 2 * unit.radius, 0) + gap * (row.length - 1);
      let lateral = -rowWidth / 2;
      const rowRadius = Math.max(...row.map((unit) => unit.radius));
      const forward =
        military.length && support.length
          ? row === military
            ? rowRadius + gap
            : -rowRadius - gap
          : 0;
      for (const unit of row) {
        unit.forward = forward;
        unit.lateral = lateral + unit.radius;
        lateral += 2 * unit.radius + gap;
      }
    }

    const anchorX = Math.cos(group.angle) * tileRadius * 0.43;
    const anchorZ = Math.sin(group.angle) * tileRadius * 0.43;
    const apothem = (Math.sqrt(3) / 2) * tileRadius;
    let fit = 1;
    const positioned = units.map((unit) => ({
      ...unit,
      dx: unit.forward * Math.cos(group.angle) - unit.lateral * Math.sin(group.angle),
      dz: unit.forward * Math.sin(group.angle) + unit.lateral * Math.cos(group.angle),
    }));
    for (const unit of positioned) {
      // The six inset half-planes contain the complete model circle.
      for (let side = 0; side < 6; side++) {
        const normal = (side * Math.PI) / 3;
        const growth = dot(unit.dx, unit.dz, normal) + unit.radius;
        if (growth > 0) fit = Math.min(fit, (apothem - dot(anchorX, anchorZ, normal)) / growth);
      }
      if (groups.length > 1) {
        // Inward normals at both angular bisectors. Distinct facing groups
        // cannot overlap, including the opposite-facing back-to-back case.
        for (const normal of [start + Math.PI / 2, end - Math.PI / 2]) {
          const shrink = unit.radius - dot(unit.dx, unit.dz, normal);
          if (shrink > 0) fit = Math.min(fit, dot(anchorX, anchorZ, normal) / shrink);
        }
      }
    }
    fit *= 0.98; // Small deterministic boundary clearance; no minimum model scale.
    groupFits.set(group.facing, fit);
    for (const unit of positioned) {
      const scale = unit.scale * fit;
      out.push({
        id: unit.member.id,
        facing: group.facing,
        role: unit.member.role,
        x: anchorX + unit.dx * fit,
        z: anchorZ + unit.dz * fit,
        angle: group.angle,
        scale,
        radius: unit.radius * fit,
        projectedArea: unit.member.footprint.length * unit.member.footprint.width * scale ** 2,
        areaLimit: unit.areaLimit,
        sector: { start, end },
      });
    }
  }
  const sharedFit = Math.min(1, ...groupFits.values());
  for (const placement of out) {
    const ratio = sharedFit / groupFits.get(placement.facing)!;
    const anchorX = Math.cos(placement.angle) * tileRadius * 0.43;
    const anchorZ = Math.sin(placement.angle) * tileRadius * 0.43;
    placement.x = anchorX + (placement.x - anchorX) * ratio;
    placement.z = anchorZ + (placement.z - anchorZ) * ratio;
    placement.scale *= ratio;
    placement.radius *= ratio;
    placement.projectedArea *= ratio ** 2;
  }
  return out;
}

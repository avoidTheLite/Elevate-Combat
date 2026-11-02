import { unitType } from '@iron-ridge/engine';
import * as THREE from 'three';
import { layoutFormation, type FormationMember } from '../formationLayout.ts';
import type { ModelOptions } from './shared/index.ts';
import { buildUnitModel } from './units/builders.ts';

export interface RosterModelUnit {
  id: string;
  typeId: string;
  facing?: number;
}

export interface FormationModelMember {
  id: string;
  model: THREE.Group;
  facing: number;
  infantry: boolean;
  role: FormationMember['role'];
  /** Roster units keep their identity separate from the commander marker. */
  typeId?: string;
}

/** Height in the token parent's frame, excluding glows and invisible pick proxies. */
export function modelTop(model: THREE.Object3D): number {
  model.updateWorldMatrix(true, true);
  const parentInverse = model.parent
    ? model.parent.matrixWorld.clone().invert()
    : new THREE.Matrix4();
  const relative = new THREE.Matrix4();
  const bounds = new THREE.Box3();
  let top = 0;
  model.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    relative.multiplyMatrices(parentInverse, mesh.matrixWorld);
    bounds.copy(mesh.geometry.boundingBox).applyMatrix4(relative);
    top = Math.max(top, bounds.max.y);
  });
  return top;
}

/** Fit existing full models using conservative measured XZ footprints. */
export function assembleFormation(members: readonly FormationModelMember[]): THREE.Group {
  const measured = members.map((member) => {
    const bounds = new THREE.Box3().setFromObject(member.model);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    return { member, center, footprint: { length: size.x, width: size.z } };
  });
  const placements = layoutFormation(
    measured.map(({ member, footprint }) => ({
      id: member.id,
      facing: member.facing,
      role: member.role,
      infantry: member.infantry,
      footprint,
    })),
  );
  const byId = new Map(measured.map((entry) => [entry.member.id, entry]));
  const root = new THREE.Group();
  for (const placement of placements) {
    const { member, center } = byId.get(placement.id)!;
    const fitted = new THREE.Group();
    fitted.name = member.typeId ? 'roster-unit' : 'command-marker';
    fitted.userData = {
      ...placement,
      unitId: member.typeId ? member.id : undefined,
      typeId: member.typeId,
    };
    const centered = new THREE.Group();
    centered.position.set(-center.x, 0, -center.z);
    centered.add(member.model);
    fitted.add(centered);
    fitted.position.set(placement.x, 0, placement.z);
    fitted.rotation.y = -placement.angle;
    fitted.scale.setScalar(placement.scale);
    root.add(fitted);
  }
  root.userData.rosterIds = members.filter((member) => member.typeId).map((member) => member.id);
  return root;
}

export function rosterModelMember(
  unit: RosterModelUnit,
  options: ModelOptions,
): FormationModelMember {
  const definition = unitType(unit.typeId);
  return {
    id: unit.id,
    typeId: unit.typeId,
    model: buildUnitModel(unit.typeId, options),
    facing: unit.facing ?? 0,
    infantry: definition.unitClass === 'infantry',
    role:
      definition.engineer ||
      definition.unitClass === 'artillery' ||
      definition.attackType === 'indirect'
        ? 'support'
        : 'military',
  };
}

/** Also used for a single tactical occupant; visual placement does not enable stacking. */
export function buildFormationModel(
  units: readonly RosterModelUnit[],
  options: ModelOptions,
): THREE.Group {
  return assembleFormation(units.map((unit) => rosterModelMember(unit, options)));
}

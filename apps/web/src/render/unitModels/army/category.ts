import { unitType } from '@iron-ridge/engine';

export type ArmyCategory = 'infantry' | 'armor' | 'artillery' | 'cavalry';

export function armyCategory(typeId: string): ArmyCategory {
  const t = unitType(typeId);
  if (t.unitClass === 'cavalry') return 'cavalry';
  if (t.attackType === 'indirect') return 'artillery';
  if (t.unitClass === 'vehicle') return 'armor';
  return 'infantry';
}

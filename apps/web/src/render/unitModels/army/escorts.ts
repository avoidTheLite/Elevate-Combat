import { armyCategory, type ArmyCategory } from './category.ts';

export const MAX_ESCORTS = 3;

/**
 * Which unit models escort the commander: a reduced, representative sample.
 * Each category present gets one slot (its most common type), biggest category
 * first; leftover slots go to the next most common types, so a pure-infantry
 * army still shows variety (e.g. rifle + MG + bazooka) rather than clones.
 */
export function armyEscorts(typeIds: string[]): string[] {
  const count = new Map<string, number>();
  for (const id of typeIds) count.set(id, (count.get(id) ?? 0) + 1);
  // Most common first; ties broken by roster order for stability.
  const types = [...count.keys()].sort(
    (a, b) => count.get(b)! - count.get(a)! || typeIds.indexOf(a) - typeIds.indexOf(b),
  );
  const byCategory = new Map<ArmyCategory, number>();
  for (const id of typeIds)
    byCategory.set(armyCategory(id), (byCategory.get(armyCategory(id)) ?? 0) + 1);
  const categories = [...byCategory.keys()].sort((a, b) => byCategory.get(b)! - byCategory.get(a)!);

  const picks: string[] = [];
  for (const c of categories) {
    const rep = types.find((id) => armyCategory(id) === c);
    if (rep && picks.length < MAX_ESCORTS) picks.push(rep);
  }
  for (const id of types) {
    if (picks.length >= MAX_ESCORTS) break;
    if (!picks.includes(id)) picks.push(id);
  }
  return picks;
}

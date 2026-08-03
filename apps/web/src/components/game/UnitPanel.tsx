import type { UnitInstance, Team } from '@iron-ridge/types';
import { Button } from '../ui/Button.tsx';

// Minimal inline unit def names for display (avoids pulling in full server-side UNIT_DEFS)
const UNIT_NAMES: Record<string, string> = {
  ww2_rifle_infantry: 'Rifle Infantry',
  ww2_machine_gun: 'Machine Gun Team',
  ww2_at_infantry: 'AT Infantry',
  ww2_mortar: 'Mortar Team',
  ww2_tank: 'Tank',
  ww2_at_gun: 'AT Gun',
  ww2_artillery: 'Artillery',
  med_infantry: 'Infantry',
  med_archers: 'Archers',
  med_horseman: 'Horseman',
  med_spearman: 'Spearman',
  med_artillery: 'Catapult',
};

interface Props {
  unit: UnitInstance | null;
  allUnits: UnitInstance[];
  activeTeam: Team;
  onAttack: (defenderId: string) => void;
}

export function UnitPanel({ unit, allUnits, activeTeam, onAttack }: Props): React.ReactElement {
  if (!unit) {
    return (
      <div className="border border-[hsl(var(--border))] p-3 font-mono text-[hsl(var(--muted-foreground))] text-xs">
        <div className="text-[hsl(var(--muted-foreground))]">// SELECT A UNIT</div>
        <div className="mt-1">Click a unit on the map to inspect it.</div>
      </div>
    );
  }

  const name = UNIT_NAMES[unit.defId] ?? unit.defId;
  const isActive = unit.team === activeTeam;
  const clr = unit.team === 'A' ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--secondary))]';
  const enemies = allUnits.filter((u) => u.team !== unit.team && u.hp > 0);

  return (
    <div className="border border-[hsl(var(--border))] p-3 font-mono text-xs space-y-2">
      <div className={`text-sm font-bold ${clr}`}>
        [{unit.label}] {name}
      </div>
      <div className="text-[hsl(var(--muted-foreground))] grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span>Team:</span>
        <span className={clr}>{unit.team === 'A' ? 'Alpha' : 'Bravo'}</span>
        <span>Position:</span>
        <span className="text-[hsl(var(--primary))]">
          col:{unit.col} row:{unit.row}
        </span>
        <span>HP:</span>
        <span>
          <span className={unit.hp / unit.maxHp > 0.5 ? 'text-[hsl(var(--success))]' : 'text-[hsl(var(--warning))]'}>
            {unit.hp}
          </span>
          <span className="text-[hsl(var(--muted-foreground))]">/{unit.maxHp}</span>
        </span>
        <span>Moved:</span>
        <span className={unit.moved ? 'text-[hsl(var(--warning))]' : 'text-[hsl(var(--success))]'}>
          {unit.moved ? 'yes' : 'no'}
        </span>
        <span>Fired:</span>
        <span className={unit.fired ? 'text-[hsl(var(--warning))]' : 'text-[hsl(var(--success))]'}>
          {unit.fired ? 'yes' : 'no'}
        </span>
      </div>

      {isActive && !unit.fired && unit.hp > 0 && enemies.length > 0 ? (
        <div>
          <div className="text-[hsl(var(--muted-foreground))] mb-1">// FIRE AT</div>
          <div className="flex flex-wrap gap-1">
            {enemies.map((e) => (
              <Button key={e.id} variant="attack" size="sm" onClick={() => onAttack(e.id)}>
                {e.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {!isActive && <div className="text-[hsl(var(--muted-foreground))]">// NOT YOUR TURN</div>}
      {unit.fired && <div className="text-[hsl(var(--muted-foreground))]">// ALREADY FIRED THIS TURN</div>}
    </div>
  );
}

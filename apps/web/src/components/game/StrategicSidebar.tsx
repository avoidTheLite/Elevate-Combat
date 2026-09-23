import type { GameState, Team } from '@iron-ridge/engine';
import {
  ECONOMY,
  TEAM_NAME,
  armiesAt,
  armyStrength,
  attackCost,
  hexFortLevel,
  unitType,
  unitsForEra,
  visibleArmies,
  worldOf,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';

export function StrategicSidebar({
  game,
  view,
  canAct,
}: {
  game: GameState;
  view: Team | null;
  canAct: boolean;
}): React.ReactElement {
  const ui = useGameStore((s) => s.ui);
  const dispatch = useGameStore((s) => s.dispatch);
  const setUi = useGameStore((s) => s.setUi);
  const { world, terrain } = worldOf(game);
  const team = game.active;
  const main = ui.selectedMain ? world.mainByKey.get(ui.selectedMain) : null;
  const hexState = main ? game.hexes[main.key] : null;
  const seenArmies = view ? visibleArmies(game, view) : game.armies;
  const armiesHere = main ? armiesAt(game, main.key).filter((a) => seenArmies.includes(a)) : [];
  const army = ui.selectedArmy ? game.armies.find((a) => a.id === ui.selectedArmy) : null;
  const hqArmy = armiesAt(game, game.hq[team]).find((a) => a.team === team);

  return (
    <div className="flex flex-col gap-2">
      <Panel title="COMMAND">
        <Stat
          label="Command Points"
          value={`${game.cp[team]} CP`}
          tone="text-[hsl(var(--warning))] font-bold"
        />
        <Stat
          label="Income / turn"
          value={`+${ECONOMY.baseIncome + ECONOMY.perHexIncome * Object.values(game.hexes).filter((h) => h.owner === team).length}`}
        />
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => dispatch({ type: 'endTurn' })}
            disabled={!canAct}
          >
            END TURN →
          </Button>
        </div>
        <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
          Select an army, then click a green hex to move or a red hex to attack (costs{' '}
          {ECONOMY.attackBaseCost} + {ECONOMY.attackPerUnitCost}/unit CP to open a deployment).
        </div>
      </Panel>

      {main && hexState && (
        <Panel title={`HEX ${main.col},${main.row}`}>
          <Stat
            label="Owner"
            value={hexState.owner ? TEAM_NAME[hexState.owner] : 'NEUTRAL'}
            tone={
              hexState.owner === 'A'
                ? 'text-[hsl(var(--primary))]'
                : hexState.owner === 'B'
                  ? 'text-[hsl(var(--secondary))]'
                  : undefined
            }
          />
          <Stat label="Mean elevation" value={(terrain.mainHeight.get(main.key) ?? 0).toFixed(1)} />
          <Stat label="Fortification" value={`${hexFortLevel(game, world, main.key)} levels`} />
          {hexState.owner === team && (
            <Stat label="Warning clock" value={`${hexState.warning} turn(s)`} />
          )}
          {main.key === game.hq.A && (
            <Stat label="HQ" value="ALPHA HQ" tone="text-[hsl(var(--primary))]" />
          )}
          {main.key === game.hq.B && (
            <Stat label="HQ" value="BRAVO HQ" tone="text-[hsl(var(--secondary))]" />
          )}
          {hexState.owner === team && canAct && (
            <Button
              size="sm"
              onClick={() => dispatch({ type: 'fortify', hex: main.key })}
              disabled={game.cp[team] < ECONOMY.fortifyCost}
            >
              FORTIFY (−{ECONOMY.fortifyCost} CP)
            </Button>
          )}
          {armiesHere.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant={a.id === ui.selectedArmy ? 'default' : 'ghost'}
              onClick={() => setUi({ selectedArmy: a.team === team ? a.id : null })}
            >
              {TEAM_NAME[a.team]} ARMY ×{a.units.length}
            </Button>
          ))}
        </Panel>
      )}

      {army && (
        <Panel title={`${TEAM_NAME[army.team]} ARMY`} right={<span>{army.movesLeft} move(s)</span>}>
          <Stat label="Strength" value={armyStrength(army).toFixed(1)} />
          <Stat label="Attack deployment cost" value={`${attackCost(army)} CP`} />
          <ul className="text-[11px] flex flex-col gap-0.5 max-h-44 overflow-auto">
            {army.units.map((u) => {
              const t = unitType(u.typeId);
              return (
                <li key={u.id} className="flex justify-between">
                  <span>
                    {u.label} <span className="text-[hsl(var(--muted-foreground))]">{t.name}</span>
                  </span>
                  <span className={u.hp < t.hp / 2 ? 'text-[hsl(var(--destructive))]' : ''}>
                    {u.hp}/{t.hp}
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {canAct && (
        <Panel
          title="RECRUIT @ HQ"
          right={<span>{hqArmy ? `${hqArmy.units.length}/${ECONOMY.armyCap}` : 'new army'}</span>}
        >
          <div className="grid grid-cols-1 gap-1">
            {unitsForEra(game.settings.era).map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant="ghost"
                className="justify-between"
                onClick={() => dispatch({ type: 'recruit', typeId: t.id })}
                disabled={game.cp[team] < t.cost || (hqArmy?.units.length ?? 0) >= ECONOMY.armyCap}
                title={`${t.role}\n${t.armorClass} · ${t.damageType} · ${t.attackType} · ${t.placementCategory}`}
              >
                <span>{t.name}</span>
                <span className="text-[hsl(var(--warning))]">{t.cost}</span>
              </Button>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="CAMPAIGN LOG">
        <ol className="text-[10px] leading-4 max-h-48 overflow-auto">
          {game.log
            .slice(-60)
            .reverse()
            .map((l, i) => (
              <li
                key={i}
                className={
                  l.team === 'A' ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--secondary))]'
                }
              >
                T{l.turn} {l.text}
              </li>
            ))}
        </ol>
      </Panel>
    </div>
  );
}

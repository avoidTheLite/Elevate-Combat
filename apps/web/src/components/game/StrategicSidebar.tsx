import type { GameState, Team } from '@iron-ridge/engine';
import {
  COMMAND,
  ECONOMY,
  TEAM_NAME,
  garrisonOf,
  hexFortLevel,
  unitsForEra,
  worldOf,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, PanelStack, Stat } from '../ui/Panel.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import { holderName, seenHolders } from '../../lib/holders.ts';
import { ContentsPanel } from './ContentsPanel.tsx';

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
  const holdersHere = main ? seenHolders(game, view).filter((a) => a.at === main.key) : [];
  const garrison = garrisonOf(game, team);
  const garrisonFull = (garrison?.units.length ?? 0) >= COMMAND.garrisonCap;
  const n = game.settings.grid.subRadius;

  return (
    <PanelStack priority={['campaign-log', 'hex', 'recruit', 'contents', 'command']}>
      <Panel id="command" title="COMMAND">
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
          Select a commander: green cells are reachable this turn ({COMMAND.commandMove(n)} sub-hex
          steps, double when every unit is fast). Red marks an enemy within engage range (
          {COMMAND.engageRange(n)} sub-hexes) — click it to attack for {ECONOMY.attackBaseCost} +{' '}
          {ECONOMY.attackPerUnitCost}/unit CP. Your holders see enemies within{' '}
          {COMMAND.sightRange(n)} sub-hexes with clear line of sight. Click your HQ to manage its
          garrison.
        </div>
      </Panel>

      <Panel id="hex" title={main ? `HEX ${main.col},${main.row}` : 'HEX'}>
        {!main || !hexState ? (
          <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
            Click a hex to inspect it.
          </div>
        ) : (
          <>
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
            <Stat
              label="Mean elevation"
              value={(terrain.mainHeight.get(main.key) ?? 0).toFixed(1)}
            />
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
            {holdersHere.map((a) => (
              <Button
                key={a.id}
                size="sm"
                variant={a.id === ui.selectedArmy ? 'default' : 'ghost'}
                onClick={() => setUi({ selectedArmy: a.id, checkedUnits: [] })}
              >
                {TEAM_NAME[a.team]} {holderName(a)} ×{a.units.length}
              </Button>
            ))}
          </>
        )}
      </Panel>

      <ContentsPanel game={game} view={view} />

      <Panel
        id="recruit"
        title="RECRUIT → HQ GARRISON"
        right={
          <span data-testid="garrison-count">
            {garrison?.units.length ?? 0}/{COMMAND.garrisonCap}
          </span>
        }
      >
        <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
          Recruits join the HQ garrison ({garrison?.units.length ?? 0}/{COMMAND.garrisonCap}). Click
          the HQ and use NEW COMMANDER to field them.
          {garrisonFull && <span className="text-[hsl(var(--destructive))]"> Garrison full.</span>}
        </div>
        <div className="grid grid-cols-1 gap-1">
          {unitsForEra(game.settings.era).map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant="ghost"
              className="justify-between"
              onClick={() => dispatch({ type: 'recruit', typeId: t.id })}
              disabled={!canAct || game.cp[team] < t.cost || !garrison || garrisonFull}
              title={`${t.role}\n${t.armorClass} · ${t.damageType} · ${t.attackType} · ${t.placementCategory}`}
            >
              <span>{t.name}</span>
              <span className="text-[hsl(var(--warning))]">{t.cost}</span>
            </Button>
          ))}
        </div>
      </Panel>

      <Panel id="campaign-log" title="CAMPAIGN LOG" bodyClassName="h-48">
        <ol className="text-[10px] leading-4 h-full overflow-auto">
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
    </PanelStack>
  );
}

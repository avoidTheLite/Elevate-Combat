import { useMemo } from 'react';
import type { GameState, Team } from '@iron-ridge/engine';
import {
  COMMAND,
  ECONOMY,
  TEAM_NAME,
  apply,
  garrisonOf,
  hexFortLevel,
  income,
  engageTargets,
  unitsForEra,
  worldOf,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, PanelStack, Stat } from '../ui/Panel.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import { canOrder, holderName, seenHolders } from '../../lib/holders.ts';
import { ContentsPanel } from './ContentsPanel.tsx';
import { NodePanel } from './NodePanel.tsx';
import { SupplyPanel } from './SupplyPanel.tsx';
import { CampaignRecruitmentPanel } from './CampaignRecruitmentPanel.tsx';
import { RoadRepairPanel } from './RoadRepairPanel.tsx';

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
  const projectedIncome = useMemo(() => income(game, team), [game, team]);
  const selectedCommander = game.armies.find(
    (holder) => holder.id === ui.selectedArmy && holder.kind === 'commander',
  );
  const engagementTargets =
    canAct && canOrder(game, selectedCommander, view)
      ? engageTargets(game, selectedCommander!.id)
      : [];
  const mainKey = main?.key ?? null;
  const fortifyQuote = useMemo(
    () =>
      mainKey && game.phase === 'strategic' ? apply(game, { type: 'fortify', hex: mainKey }) : null,
    [game, mainKey],
  );

  return (
    <PanelStack
      priority={[
        'campaign-log',
        'hex',
        'recruit',
        'roads',
        'supply',
        'node',
        'contents',
        'command',
      ]}
    >
      <Panel id="command" title="COMMAND">
        <p className="text-[10px] leading-4 text-[hsl(var(--muted-foreground))]">
          {game.infrastructure
            ? 'Infrastructure enabled: select your HQ or a marked node, then use Node order below to build, upgrade or repair. Engineers and the building window determine availability.'
            : 'Classic campaign: recruit at HQ and fortify owned territory. Node construction and supply are available by choosing Simple or Advanced infrastructure in New Campaign setup.'}
        </p>
        <Stat
          label="Command Points"
          value={`${game.cp[team]} CP`}
          tone="text-[hsl(var(--warning))] font-bold"
        />
        <Stat label="Income / turn" value={`+${projectedIncome}`} />
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
          {COMMAND.engageRange(n)} sub-hexes) — click it to engage.
          {game.settings.engagement
            ? ` Trial attack price: ${game.settings.engagement.attackBaseCp} CP plus ${game.settings.engagement.additionalAttackerCp} per additional attacker; choose participants before spending.`
            : ` Attack price: ${ECONOMY.attackBaseCost} + ${ECONOMY.attackPerUnitCost}/unit CP.`}{' '}
          Your holders see enemies within {COMMAND.sightRange(n)} sub-hexes with clear line of
          sight. Click your HQ to manage its garrison.
        </div>
        {engagementTargets.length > 0 && (
          <ul aria-label="Eligible engagement targets" className="flex flex-col gap-1">
            {engagementTargets.map((target) => (
              <li key={target.id}>
                <Button
                  size="sm"
                  variant="attack"
                  className="w-full text-left"
                  onClick={() =>
                    dispatch({
                      type: 'engage',
                      armyId: selectedCommander!.id,
                      targetId: target.id,
                    })
                  }
                >
                  ENGAGE {TEAM_NAME[target.team]} {holderName(target)} · MainHex {target.at}
                </Button>
              </li>
            ))}
          </ul>
        )}
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
                disabled={fortifyQuote === null || fortifyQuote.error !== null}
                title={fortifyQuote?.error ?? undefined}
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
      <NodePanel game={game} mainHex={main?.key ?? null} canAct={canAct} />
      <SupplyPanel game={game} mainHex={main?.key ?? null} />
      <RoadRepairPanel game={game} mainHex={main?.key ?? null} canAct={canAct} />

      {game.infrastructure ? (
        <CampaignRecruitmentPanel game={game} mainHex={main?.key ?? null} canAct={canAct} />
      ) : (
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
            Recruits join the HQ garrison ({garrison?.units.length ?? 0}/{COMMAND.garrisonCap}).
            Click the HQ and use NEW COMMANDER to field them.
            {garrisonFull && (
              <span className="text-[hsl(var(--destructive))]"> Garrison full.</span>
            )}
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
      )}

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

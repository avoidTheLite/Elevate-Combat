import { useMemo } from 'react';
import type { GameState, Team } from '@iron-ridge/engine';
import {
  COMMAND,
  ECONOMY,
  TEAM_NAME,
  apply,
  campaignNodeViews,
  engageTargets,
  garrisonOf,
  hexFortLevel,
  hexKey,
  unitsForEra,
  worldOf,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import { canOrder, holderName, nearbyHqForTile } from '../../lib/holders.ts';
import { chooseNearbyHq, chooseTileEntity, visibleTileEntities } from '../../lib/selection.ts';
import { strategicKnowledge } from '../../lib/strategicVisibility.ts';
import { ContentsPanel } from './ContentsPanel.tsx';
import { NodePanel } from './NodePanel.tsx';
import { SupplyPanel } from './SupplyPanel.tsx';
import { CampaignRecruitmentPanel } from './CampaignRecruitmentPanel.tsx';
import { RoadRepairPanel } from './RoadRepairPanel.tsx';
import { EntityContextCard } from './EntityContextCard.tsx';
import { useNodePlacementStore } from '../../stores/useNodePlacementStore.ts';

export function StrategicSidebar({
  game,
  view,
  canAct,
}: {
  game: GameState;
  view: Team | null;
  canAct: boolean;
}): React.ReactElement | null {
  const ui = useGameStore((s) => s.ui);
  const dispatch = useGameStore((s) => s.dispatch);
  const placement = useNodePlacementStore((s) => s.plan);
  const { world, terrain } = worldOf(game);
  const team = view ?? game.active;
  const knowledge = useMemo(() => strategicKnowledge(game, view), [game, view]);
  const selectedHolder = game.armies.find((holder) => holder.id === ui.selectedArmy);
  const main = ui.selectedMain ? world.mainByKey.get(ui.selectedMain) : null;
  const key = ui.inspectedCell ?? selectedHolder?.pos ?? (main ? hexKey(main.center) : null);
  const cell = key ? world.subByKey.get(key) : undefined;
  const selectedMain = cell ? world.mainByKey.get(cell.main) : main;
  const hexState = selectedMain ? game.hexes[selectedMain.key] : null;
  const observedOwner = selectedMain ? knowledge.owners.get(selectedMain.key) : undefined;
  const currentlyObserved = !!selectedMain && knowledge.mains.has(selectedMain.key);
  const fullyObserved = !!selectedMain && selectedMain.subKeys.every((k) => knowledge.cells.has(k));
  const mayInspectActive = view === null || view === game.active;
  const mainKey = selectedMain?.key ?? null;
  const fortifyQuote = useMemo(
    () =>
      mainKey && game.phase === 'strategic' ? apply(game, { type: 'fortify', hex: mainKey }) : null,
    [game, mainKey],
  );
  if (!key || !cell || !selectedMain || !hexState) return null;
  const entities = visibleTileEntities(game, key, view);
  const nearbyHq = nearbyHqForTile(game, view, key);
  const selectedId = entities.some((e) => e.id === ui.selectedEntity) ? ui.selectedEntity : null;
  const site = game.infrastructure?.sites.find(
    (candidate) => candidate.mainHex === selectedMain.key,
  );
  const node = site
    ? campaignNodeViews(game).find((candidate) => candidate.nodeId === site.nodeId)
    : undefined;
  const tileHasBuilding =
    !!node?.buildings.some((building) => building.subHex === key) && knowledge.cells.has(key);
  const showNode =
    !!site &&
    knowledge.cells.has(key) &&
    (key === site.centerSubHex ||
      tileHasBuilding ||
      site.annexSubHexes.includes(key) ||
      (placement?.mainHex === selectedMain.key && placement.nodeId === site.nodeId));
  const garrison = garrisonOf(game, team);
  const garrisonFull = (garrison?.units.length ?? 0) >= COMMAND.garrisonCap;
  const nodeContent = (nodeId: string): React.ReactElement => {
    const nodeContext = key === site?.centerSubHex || ui.inspectedCell === null;
    const held = game.armies.find(
      (holder) =>
        nodeContext &&
        holder.kind === 'garrison' &&
        holder.at === selectedMain.key &&
        holder.building !== 'temporary',
    );
    return (
      <>
        <NodePanel
          game={game}
          mainHex={selectedMain.key}
          inspectedCell={ui.inspectedCell}
          view={view}
          canAct={canAct && mayInspectActive}
        />
        {held && <ContentsPanel game={game} view={view} holderId={held.id} canAct={canAct} />}
        {nodeContext && site?.nodeId === nodeId && node?.owner === team && (
          <>
            <SupplyPanel game={game} mainHex={selectedMain.key} view={view} />
            {mayInspectActive && (
              <CampaignRecruitmentPanel game={game} mainHex={selectedMain.key} canAct={canAct} />
            )}
          </>
        )}
      </>
    );
  };
  return (
    <div
      className="h-full overflow-y-auto overscroll-contain p-2 flex flex-col gap-2"
      data-testid="selection-context"
    >
      <Panel id="hex" title={`TILE ${key} · HEX ${selectedMain.col},${selectedMain.row}`}>
        {nearbyHq && (
          <Button
            size="sm"
            className="min-h-11"
            title={`Inspect HQ on tile ${nearbyHq.pos}`}
            onClick={() => chooseNearbyHq(game, key)}
          >
            SELECT NEARBY HQ
          </Button>
        )}
        <Stat label="Elevation" value={`H${terrain.heights[cell.index] ?? 0}`} />
        <Stat
          label="Owner"
          value={
            observedOwner === undefined
              ? 'UNKNOWN'
              : observedOwner
                ? TEAM_NAME[observedOwner]
                : 'NEUTRAL'
          }
          tone={
            observedOwner === 'A'
              ? 'text-[hsl(var(--primary))]'
              : observedOwner === 'B'
                ? 'text-[hsl(var(--secondary))]'
                : undefined
          }
        />
        {!currentlyObserved && (
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
            {observedOwner === undefined
              ? 'Ownership has not been observed.'
              : 'Last observed owner.'}{' '}
            Reveal at least one tile in this MainHex to update ownership.
          </p>
        )}
        <Stat
          label="Mean elevation"
          value={(terrain.mainHeight.get(selectedMain.key) ?? 0).toFixed(1)}
        />
        <Stat
          label="Fortification"
          value={
            fullyObserved ? `${hexFortLevel(game, world, selectedMain.key)} levels` : 'UNKNOWN'
          }
        />
        {currentlyObserved && hexState.owner === team && (
          <Stat label="Warning clock" value={`${hexState.warning} turn(s)`} />
        )}
        {currentlyObserved && selectedMain.key === game.hq.A && (
          <Stat label="HQ" value="ALPHA HQ" tone="text-[hsl(var(--primary))]" />
        )}
        {currentlyObserved && selectedMain.key === game.hq.B && (
          <Stat label="HQ" value="BRAVO HQ" tone="text-[hsl(var(--secondary))]" />
        )}
        {currentlyObserved && hexState.owner === team && canAct && mayInspectActive && (
          <Button
            size="sm"
            onClick={() => dispatch({ type: 'fortify', hex: selectedMain.key })}
            disabled={fortifyQuote === null || fortifyQuote.error !== null}
            title={fortifyQuote?.error ?? undefined}
          >
            FORTIFY (−{ECONOMY.fortifyCost} CP)
          </Button>
        )}
      </Panel>
      {entities.map((entity) => (
        <EntityContextCard
          key={entity.id}
          entity={entity}
          selectedId={selectedId}
          onChoose={() => chooseTileEntity(game, key, entity.id)}
        >
          {entity.kind === 'holder' && (
            <>
              <ContentsPanel game={game} view={view} holderId={entity.id} canAct={canAct} />
              {canAct &&
                canOrder(game, entity.holder, view) &&
                entity.holder.kind === 'commander' &&
                engageTargets(game, entity.id).map((target) => (
                  <Button
                    key={target.id}
                    size="sm"
                    variant="attack"
                    onClick={() =>
                      dispatch({ type: 'engage', armyId: entity.id, targetId: target.id })
                    }
                  >
                    ENGAGE {TEAM_NAME[target.team]} {holderName(target)} · MainHex {target.at}
                  </Button>
                ))}
              {!game.infrastructure && entity.holder.id === garrison?.id && (
                <Panel id="recruit" title="RECRUIT → HQ GARRISON">
                  <span data-testid="garrison-count">
                    {garrison.units.length}/{COMMAND.garrisonCap}
                  </span>
                  {garrisonFull && (
                    <p className="text-[10px] text-[hsl(var(--destructive))]">Garrison full.</p>
                  )}
                  {unitsForEra(game.settings.era).map((type) => (
                    <Button
                      key={type.id}
                      size="sm"
                      variant="ghost"
                      className="justify-between"
                      onClick={() => dispatch({ type: 'recruit', typeId: type.id })}
                      disabled={!canAct || game.cp[team] < type.cost || garrisonFull}
                    >
                      <span>{type.name}</span>
                      <span>{type.cost} CP</span>
                    </Button>
                  ))}
                </Panel>
              )}
            </>
          )}
          {entity.kind === 'node' && nodeContent(entity.nodeId)}
          {entity.kind === 'building' && (
            <NodePanel
              game={game}
              mainHex={selectedMain.key}
              inspectedCell={key}
              view={view}
              canAct={canAct && mayInspectActive}
            />
          )}
        </EntityContextCard>
      ))}
      {showNode &&
        !entities.some((entity) => entity.kind === 'node' || entity.kind === 'building') &&
        site &&
        nodeContent(site.nodeId)}
      {mayInspectActive && (
        <RoadRepairPanel game={game} mainHex={selectedMain.key} canAct={canAct} view={view} />
      )}
    </div>
  );
}

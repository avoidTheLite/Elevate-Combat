import { useEffect, useMemo, useState } from 'react';
import type { GameState, Team } from '@iron-ridge/engine';
import { TEAM_NAME, campaignNodeViews, worldOf } from '@iron-ridge/engine';
import { viewTeam } from '../../stores/useGameStore.ts';
import { visibleNodeActionChoices } from '../../stores/useNodePlacementStore.ts';
import { strategicKnowledge } from '../../lib/strategicVisibility.ts';
import { NodeWorkActions } from './NodeWorkActions.tsx';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';

export function NodePanel({
  game,
  mainHex,
  inspectedCell = null,
  canAct,
  view,
}: {
  game: GameState;
  mainHex: string | null;
  inspectedCell?: string | null;
  canAct: boolean;
  view?: Team | null;
}): React.ReactElement | null {
  const [buildingCatalog, setBuildingCatalog] = useState(false);
  useEffect(() => setBuildingCatalog(false), [mainHex, inspectedCell]);
  const observer = view === undefined ? viewTeam(game) : view;
  const knowledge = useMemo(() => strategicKnowledge(game, observer), [game, observer]);
  const observed = !!mainHex && knowledge.mains.has(mainHex);
  const views = useMemo(() => campaignNodeViews(game), [game]);
  const node = observed ? views.find((candidate) => candidate.mainHex === mainHex) : undefined;
  const ownWork = !!node && (observer === null || node.owner === observer);
  const centerObserved = !!node && knowledge.cells.has(node.centerSubHex);
  const fullyObserved =
    !!mainHex &&
    worldOf(game)
      .world.mainByKey.get(mainHex)
      ?.subKeys.every((key) => knowledge.cells.has(key));
  const choices = useMemo(
    () => (node ? visibleNodeActionChoices(game, node, observer) : []),
    [game, node, observer],
  );
  if (!game.infrastructure) return null;
  return (
    <Panel id="node" title={node && centerObserved ? node.name : 'INFRASTRUCTURE NODE'}>
      {mainHex && !observed ? (
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
          Node details are hidden by fog of war. Reveal a tile in this MainHex to inspect its
          current control.
        </p>
      ) : !node ? (
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
          {mainHex
            ? 'This MainHex has no node in the seeded Advanced layout. Select a marked node or your Home HQ to build.'
            : 'Select your Home HQ or a marked node to inspect buildings and choose a Node order.'}
        </p>
      ) : (
        <div role="region" aria-label="Infrastructure node" className="flex flex-col gap-2">
          <Stat label="Node owner" value={node.owner ? TEAM_NAME[node.owner] : 'UNOWNED'} />
          <Stat label="Node state" value={centerObserved ? node.status.toUpperCase() : 'UNKNOWN'} />
          {ownWork && <Stat label="Ordinary building point" value={node.work.ordinaryRemaining} />}
          {ownWork && (
            <Stat label="Building operations left" value={node.work.operationsRemaining} />
          )}
          {ownWork && node.work.buildingWindow === 'closed' && (
            <p className="text-[10px] text-[hsl(var(--warning))]">
              Captured after the building window. Building work resumes next owner turn; network
              effects can update now.
            </p>
          )}
          {ownWork && node.work.activationRepairOnly && (
            <p className="text-[10px] text-[hsl(var(--warning))]">
              Activation turn: one engineer-funded repair is available. Construction and upgrades
              wait until next turn.
            </p>
          )}
          {node.owner === game.active &&
            ownWork &&
            inspectedCell === node.centerSubHex &&
            choices.some((choice) => choice.request.kind === 'build') && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canAct}
                onClick={() => setBuildingCatalog((shown) => !shown)}
              >
                {buildingCatalog ? 'Inspect center building' : 'Build at node'}
              </Button>
            )}
          <NodeWorkActions
            key={node.nodeId}
            game={game}
            node={node}
            choices={choices}
            visibleBuildings={node.buildings.filter((building) =>
              knowledge.cells.has(building.subHex),
            )}
            inspectedCell={buildingCatalog ? null : inspectedCell}
            canAct={canAct}
            view={observer}
          />
          <details className="text-[10px] text-[hsl(var(--muted-foreground))]">
            <summary className="cursor-pointer">Node details</summary>
            <div className="mt-1 flex flex-col gap-1">
              <Stat label="Territorial claim" value={node.claim ? TEAM_NAME[node.claim] : 'NONE'} />
              <Stat
                label="Contested"
                value={fullyObserved ? (node.contested ? 'YES' : 'NO') : 'UNKNOWN'}
              />
              <Stat label="Center" value={node.centerSubHex} />
              {node.homeTeam && <Stat label="Original Home HQ" value={TEAM_NAME[node.homeTeam]} />}
            </div>
          </details>
        </div>
      )}
    </Panel>
  );
}

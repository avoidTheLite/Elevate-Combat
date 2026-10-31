import { useMemo } from 'react';
import type { GameState } from '@iron-ridge/engine';
import { campaignSupplyView } from '@iron-ridge/engine';
import { Panel, Stat } from '../ui/Panel.tsx';

function displayNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

export function SupplyPanel({
  game,
  mainHex,
}: {
  game: GameState;
  mainHex: string | null;
}): React.ReactElement | null {
  const supply = useMemo(() => campaignSupplyView(game, game.active), [game]);
  const infrastructure = game.infrastructure;
  if (!infrastructure || !supply) return null;
  const site = infrastructure.sites.find((candidate) => candidate.mainHex === mainHex);
  const node = site ? supply.nodes[site.nodeId] : null;
  const route = node?.activeRoute;
  const authorityName = (nodeId: string): string => {
    const authority = infrastructure.sites.find((candidate) => candidate.nodeId === nodeId);
    return authority?.homeTeam === game.active
      ? 'Home HQ'
      : `Regional HQ ${authority?.mainHex ?? nodeId}`;
  };
  return (
    <Panel id="supply" title="SUPPLY NETWORK">
      {!node ? (
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
          Select one of your operational nodes to inspect its supply.
        </p>
      ) : (
        <div role="region" aria-label="Node supply" className="flex flex-col gap-2">
          <Stat label="Connection" value={node.connection.toUpperCase()} />
          <Stat label="Home connected" value={node.homeConnected ? 'YES' : 'NO'} />
          {route ? (
            <>
              <Stat label="Route authority" value={authorityName(route.authorityId)} />
              <Stat
                label="Supply efficiency"
                value={`${Math.round(route.effectiveEfficiency * 100)}%`}
              />
              <Stat label="Weighted route cost" value={displayNumber(route.weightedCost)} />
              <Stat label="Hostile MainHex crossings" value={route.hostileMainHexes.length} />
              <Stat label="Supply legs" value={route.legs.length} />
              <details className="text-[10px]">
                <summary className="cursor-pointer">Show route ({route.path.length} cells)</summary>
                <p className="break-words text-[hsl(var(--muted-foreground))] mt-1">
                  {route.path.join(' → ')}
                </p>
              </details>
            </>
          ) : (
            <p className="text-[10px] text-[hsl(var(--warning))]">
              No eligible HQ route. Network building income and reinforcements are unavailable;
              local active effects remain.
            </p>
          )}
          {site &&
            Object.values(supply.benefitSelections[site.nodeId] ?? {}).map((benefit) => (
              <Stat
                key={benefit.benefitId}
                label={
                  benefit.benefitId === 'reinforcement'
                    ? 'Reinforcement capacity'
                    : benefit.benefitId === 'income-factor'
                      ? 'Income modifier'
                      : benefit.benefitId.replaceAll('-', ' ')
                }
                value={`${displayNumber(benefit.value)}${benefit.providerId ? ` · ${authorityName(benefit.providerId)}` : ''}`}
              />
            ))}
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
            Each benefit uses its best eligible HQ. Reconnecting does not replay income or restore
            spent reinforcement allowance.
          </p>
          {supply.blockedCells.length > 0 && (
            <details className="text-[10px]">
              <summary className="cursor-pointer">
                Blocked supply cells ({supply.blockedCells.length})
              </summary>
              <p className="break-words text-[hsl(var(--muted-foreground))] mt-1">
                {supply.blockedCells.join(' · ')}
              </p>
            </details>
          )}
        </div>
      )}
    </Panel>
  );
}

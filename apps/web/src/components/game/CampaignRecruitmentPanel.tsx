import { useMemo } from 'react';
import type { GameState } from '@iron-ridge/engine';
import { quoteCampaignRecruitment, unitsForEra, withRules } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';

export function CampaignRecruitmentPanel({
  game,
  mainHex,
  canAct,
}: {
  game: GameState;
  mainHex: string | null;
  canAct: boolean;
}): React.ReactElement | null {
  const dispatch = useGameStore((state) => state.dispatch);
  const site = game.infrastructure?.sites.find((candidate) =>
    mainHex ? candidate.mainHex === mainHex : candidate.homeTeam === game.active,
  );
  const roster = useMemo(
    () => withRules(game.settings.rules, () => unitsForEra(game.settings.era)),
    [game.settings.rules, game.settings.era],
  );
  const quotes = useMemo(
    () =>
      site
        ? roster.map((unit) => ({
            unit,
            quote: quoteCampaignRecruitment(game, unit.id, site.nodeId),
          }))
        : [],
    [game, roster, site],
  );
  if (!game.infrastructure) return null;
  const metrics = quotes[0]?.quote;
  const commonRefusal =
    quotes.length > 0 &&
    quotes.every(
      (candidate) => !candidate.quote.allowed && candidate.quote.reason === quotes[0].quote.reason,
    )
      ? quotes[0].quote.reason
      : null;
  return (
    <Panel id="recruit" title="RECRUIT → NODE GARRISON">
      {site && metrics ? (
        <>
          <Stat
            label="Recruitment node"
            value={site.homeTeam === game.active ? 'Home HQ' : `Node ${site.mainHex}`}
          />
          <Stat
            label="Housing"
            value={
              metrics.occupied !== null && metrics.housing !== null
                ? `${metrics.occupied}/${metrics.housing}`
                : '—'
            }
          />
          <Stat label="Node deployments remaining" value={metrics.localRemaining ?? '—'} />
          <Stat label="Shared network remaining" value={metrics.sharedRemaining ?? '—'} />
          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
            Recruits stay in this node’s garrison. Housing, local throughput, network allowance and
            CP all apply. Select another node on the map to recruit there.
          </p>
          {commonRefusal && (
            <p role="status" className="text-[10px] text-[hsl(var(--warning))]">
              {commonRefusal}
            </p>
          )}
          <div className="grid grid-cols-1 gap-1">
            {quotes.map(({ unit, quote }) => (
              <Button
                key={unit.id}
                size="sm"
                variant="ghost"
                className="justify-between"
                disabled={!canAct || !quote.allowed}
                title={quote.reason ?? `${unit.role} · recruit at ${site.mainHex}`}
                onClick={() => dispatch({ type: 'recruit', typeId: unit.id, nodeId: site.nodeId })}
              >
                <span>{unit.name}</span>
                <span className="text-[hsl(var(--warning))]">
                  {quote.cost === null ? '—' : `${quote.cost} CP`}
                </span>
              </Button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
          Select a node to inspect recruitment.
        </p>
      )}
    </Panel>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CampaignNodeActionChoice,
  CampaignNodeDefinition,
  CampaignNodeView,
  GameState,
  Team,
} from '@iron-ridge/engine';
import { campaignBuildingData, campaignNodeViews } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { currentNodeQuote, useNodePlacementStore } from '../../stores/useNodePlacementStore.ts';
import { Button } from '../ui/Button.tsx';
import { Stat } from '../ui/Panel.tsx';

function definitionFor(
  game: GameState,
  node: CampaignNodeView,
  choice: CampaignNodeActionChoice,
): CampaignNodeDefinition | undefined {
  const request = choice.request;
  const building =
    'buildingId' in request
      ? game.infrastructure?.capture.nodes
          .find((candidate) => candidate.id === node.nodeId)
          ?.buildings.find((candidate) => candidate.id === request.buildingId)
      : undefined;
  const id =
    request.kind === 'build'
      ? request.definitionId
      : request.kind === 'activate'
        ? request.centerDefinitionId
        : building
          ? campaignBuildingData(building).definitionId
          : null;
  return game.infrastructure?.profile.definitions.find((candidate) => candidate.id === id);
}

function Requirements({
  game,
  node,
  choice,
}: {
  game: GameState;
  node: CampaignNodeView;
  choice: CampaignNodeActionChoice;
}): React.ReactElement {
  const definition = definitionFor(game, node, choice);
  const allowance = choice.allowance
    ? {
        ordinary: 'Ordinary node point',
        engineer: 'Engineer action',
        activation: 'Activation',
      }[choice.allowance]
    : 'See availability above';
  return (
    <details className="text-[10px] text-[hsl(var(--muted-foreground))]">
      <summary className="cursor-pointer">Requirements</summary>
      <div className="mt-1 flex flex-col gap-1">
        <Stat label="CP available" value={`${game.cp[game.active]} CP`} />
        <Stat label="Allowance" value={allowance} />
        {choice.engineerUnitId && choice.engineerUnitId !== 'missing-engineer' && (
          <Stat label="Engineer" value={choice.engineerLabel ?? choice.engineerUnitId} />
        )}
        {choice.request.kind === 'repair-building' && <p>Requires a local engineer action.</p>}
        {definition && choice.request.kind === 'build' && (
          <>
            <p>Generic center minimum: tier {definition.minimumGenericCenterTier}.</p>
            <p>Building maximum: tier {definition.maximumTier}.</p>
            {definition.engineerRequired && <p>Requires a local engineer action.</p>}
            {definition.prerequisites.length > 0 && (
              <p>
                Prerequisites:{' '}
                {definition.prerequisites
                  .map(
                    (id) =>
                      game.infrastructure?.profile.definitions.find((item) => item.id === id)
                        ?.name ?? id,
                  )
                  .join(', ')}
                .
              </p>
            )}
          </>
        )}
        {choice.legal && <p>Current engine requirements are met.</p>}
      </div>
    </details>
  );
}

export function NodeWorkActions({
  game,
  node,
  choices,
  visibleBuildings,
  inspectedCell,
  canAct,
  view,
}: {
  game: GameState;
  node: CampaignNodeView;
  choices: readonly CampaignNodeActionChoice[];
  visibleBuildings: CampaignNodeView['buildings'];
  inspectedCell: string | null;
  canAct: boolean;
  view: Team | null;
}): React.ReactElement {
  const dispatch = useGameStore((state) => state.dispatch);
  const { plan, startPlacement, selectTile, cancelPlacement } = useNodePlacementStore();
  const scope = `${node.nodeId}:${inspectedCell ?? ''}`;
  const [managed, setManaged] = useState<{ scope: string; id: string } | null>(null);
  const [pending, updatePending] = useState<{
    game: GameState;
    scope: string;
    choice: CampaignNodeActionChoice;
  } | null>(null);
  const pendingRef = useRef(pending);
  const setPending = useCallback((next: typeof pending) => {
    pendingRef.current = next;
    updatePending(next);
  }, []);
  const liveContext = useRef({ scope, canAct, view });
  liveContext.current = { scope, canAct, view };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingRef.current = null;
    };
  }, []);
  useEffect(() => {
    setPending(null);
  }, [scope, setPending]);
  const [error, setError] = useState<string | null>(null);
  const building = inspectedCell
    ? visibleBuildings.find((candidate) => candidate.subHex === inspectedCell)
    : managed?.scope === scope
      ? visibleBuildings.find((candidate) => candidate.id === managed.id)
      : undefined;
  const placement = plan?.nodeId === node.nodeId ? plan : null;
  const quote =
    placement?.choice ??
    (pending?.game === game && pending.scope === scope ? pending.choice : null);
  const liveQuote = quote
    ? choices.find(
        (choice) =>
          JSON.stringify(choice.request) === JSON.stringify(quote.request) &&
          choice.cpCost === quote.cpCost,
      )
    : null;
  const availableTargets = placement
    ? choices.filter(
        ({ request, legal }) =>
          legal &&
          request.kind === 'build' &&
          request.definitionId === placement.definitionId &&
          request.tier === placement.tier,
      )
    : [];
  const placementChoice = placement
    ? choices.find(
        ({ request, legal }) =>
          legal &&
          request.kind === 'build' &&
          request.definitionId === placement.definitionId &&
          request.tier === placement.tier,
      )
    : null;
  const scoped = choices.filter(({ request }) => {
    if (request.kind === 'activate') return !inspectedCell || inspectedCell === node.centerSubHex;
    if (building) return 'buildingId' in request && request.buildingId === building.id;
    if (request.kind !== 'build') return false;
    return !inspectedCell || request.subHex === inspectedCell;
  });
  const grouped = new Map<string, CampaignNodeActionChoice[]>();
  for (const choice of scoped) {
    const request = choice.request;
    const key =
      request.kind === 'build'
        ? `build:${request.definitionId}:${request.tier}`
        : request.requestId;
    grouped.set(key, [...(grouped.get(key) ?? []), choice]);
  }

  const cancel = (): void => {
    cancelPlacement();
    setPending(null);
    setError(null);
  };
  const confirm = (): void => {
    const session = useGameStore.getState();
    if (
      !mounted.current ||
      !canAct ||
      !quote ||
      session.game !== game ||
      session.handoff ||
      session.quitPrompt ||
      !liveContext.current.canAct ||
      liveContext.current.scope !== scope ||
      liveContext.current.view !== view
    )
      return;
    if (
      placement
        ? useNodePlacementStore.getState().plan !== placement
        : !pending || pendingRef.current !== pending || pending.game !== game
    )
      return;
    const latest = session.game;
    const latestNode = latest
      ? campaignNodeViews(latest).find((candidate) => candidate.nodeId === node.nodeId)
      : null;
    const validated =
      latest && latestNode ? currentNodeQuote(latest, latestNode, view, quote) : null;
    if (!validated?.legal) {
      setError(validated?.reason ?? 'This order changed. Cancel and choose it again.');
      return;
    }
    if (dispatch({ type: 'nodeWork', request: quote.request })) cancel();
    else setError(useGameStore.getState().error ?? 'This order is no longer available.');
  };

  return (
    <div className="flex flex-col gap-2" aria-label="Contextual node actions">
      {placement ? (
        <div className="border border-[hsl(var(--primary))] p-2 flex flex-col gap-2">
          <p className="text-[11px]">
            Build{' '}
            {game.infrastructure?.profile.definitions.find(
              (definition) => definition.id === placement.definitionId,
            )?.name ?? placement.definitionId}{' '}
            · T{placement.tier}
          </p>
          {placement.subHex ? (
            <Stat label="Build location" value={placement.subHex} />
          ) : (
            <p className="text-[10px]" role="status">
              Choose a highlighted tile on the map ({availableTargets.length} available).
            </p>
          )}
          {!quote && placementChoice && (
            <>
              <Stat label="Order cost" value={`${placementChoice.cpCost} CP`} />
              <Requirements game={game} node={node} choice={placementChoice} />
            </>
          )}
          {!placement.subHex && availableTargets.length === 0 && (
            <p className="text-[10px] text-[hsl(var(--warning))]">
              No legal visible placements remain. Cancel and choose again.
            </p>
          )}
          {!quote && (
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel building
            </Button>
          )}
        </div>
      ) : quote ? null : (
        <>
          <p className="text-[11px]">
            {building
              ? `${building.name} · T${building.tier} · ${building.subHex} · ${building.ruined ? 'ruined' : building.active ? 'active' : 'inactive'}`
              : inspectedCell
                ? `Build on ${inspectedCell}`
                : 'Choose a building, then its location'}
          </p>
          {building && !inspectedCell && (
            <Button size="sm" variant="ghost" onClick={() => setManaged(null)}>
              Back to buildings
            </Button>
          )}
          {[...grouped].map(([key, candidates]) => {
            const choice = candidates.find((candidate) => candidate.legal) ?? candidates[0]!;
            const request = choice.request;
            const title =
              request.kind === 'build'
                ? `Build ${definitionFor(game, node, choice)?.name ?? request.definitionId} T${request.tier}`
                : choice.label;
            return (
              <div
                key={key}
                className="border border-[hsl(var(--border))] p-1.5 flex flex-col gap-1"
              >
                <Button
                  size="sm"
                  aria-label={`${title} ${choice.cpCost} CP`}
                  className="justify-between text-left tracking-normal"
                  disabled={!canAct || !choice.legal}
                  onClick={() => {
                    setError(null);
                    if (request.kind === 'build') {
                      setPending(null);
                      startPlacement({
                        nodeId: node.nodeId,
                        mainHex: node.mainHex,
                        definitionId: request.definitionId,
                        tier: request.tier,
                        view,
                      });
                      if (inspectedCell) selectTile(game, inspectedCell);
                    } else setPending({ game, scope, choice });
                  }}
                >
                  <span>{title}</span>
                  <span className="ml-2 whitespace-nowrap">{choice.cpCost} CP</span>
                </Button>
                <p
                  className={`text-[10px] ${choice.legal ? 'text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--warning))]'}`}
                >
                  {choice.legal
                    ? request.kind === 'build' && !inspectedCell
                      ? `${candidates.filter((candidate) => candidate.legal).length} legal visible tiles`
                      : 'Available'
                    : choice.reason}
                </p>
                <Requirements game={game} node={node} choice={choice} />
              </div>
            );
          })}
          {grouped.size === 0 && (
            <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
              {building
                ? 'No further building actions are available here.'
                : 'No building choices are available for this location.'}
            </p>
          )}
          {!inspectedCell && !building && visibleBuildings.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-[10px]">Existing buildings</p>
              <ul className="flex flex-col gap-1" aria-label="Node buildings">
                {visibleBuildings.map((candidate) => (
                  <li key={candidate.id}>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="justify-start text-left tracking-normal"
                      onClick={() => setManaged({ scope, id: candidate.id })}
                    >
                      Manage {candidate.name} · T{candidate.tier} · {candidate.subHex}
                      {candidate.ruined
                        ? ' · ruined'
                        : candidate.active
                          ? ' · active'
                          : ' · inactive'}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {quote && (
        <div
          className="border border-[hsl(var(--primary))] p-2 flex flex-col gap-2"
          aria-label="Confirm node work"
        >
          <p className="text-[11px]">{quote.label}</p>
          <Stat label="Order cost" value={`${quote.cpCost} CP`} />
          {quote.engineerUnitId && quote.engineerLabel && (
            <Stat label="Engineer action" value={quote.engineerLabel} />
          )}
          <Requirements game={game} node={node} choice={liveQuote ?? quote} />
          {(!liveQuote || !liveQuote.legal) && (
            <p className="text-[10px] text-[hsl(var(--warning))]" role="status">
              {liveQuote?.reason ?? 'This order changed. Cancel and choose it again.'}
            </p>
          )}
          {error && (
            <p className="text-[10px] text-[hsl(var(--warning))]" role="alert">
              {error}
            </p>
          )}
          <Button size="sm" disabled={!canAct || !liveQuote?.legal} onClick={confirm}>
            Confirm {quote.request.kind === 'build' ? 'build' : 'order'} ({quote.cpCost} CP)
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel building work
          </Button>
        </div>
      )}
    </div>
  );
}

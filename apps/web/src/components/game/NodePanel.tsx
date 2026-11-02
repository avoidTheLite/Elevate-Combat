import { useMemo, useState } from 'react';
import type { GameState } from '@iron-ridge/engine';
import { TEAM_NAME, campaignNodeActionChoices, campaignNodeViews } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';

export function NodePanel({
  game,
  mainHex,
  canAct,
}: {
  game: GameState;
  mainHex: string | null;
  canAct: boolean;
}): React.ReactElement | null {
  const dispatch = useGameStore((state) => state.dispatch);
  const [choiceId, setChoiceId] = useState('');
  const views = useMemo(() => campaignNodeViews(game), [game]);
  const node = views.find((candidate) => candidate.mainHex === mainHex);
  const choices = useMemo(
    () => (node ? campaignNodeActionChoices(game, node.nodeId) : []),
    [game, node],
  );
  if (!game.infrastructure) return null;
  const choice = choices.find((candidate) => candidate.request.requestId === choiceId) ?? null;
  const engineer = choice?.engineerUnitId
    ? game.armies
        .flatMap((holder) => holder.units)
        .find((unit) => unit.id === choice.engineerUnitId)
    : null;
  return (
    <Panel id="node" title={node ? node.name : 'INFRASTRUCTURE NODE'}>
      {!node ? (
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
          {mainHex
            ? 'This MainHex has no node in the seeded Advanced layout. Select a marked node or your Home HQ to build.'
            : 'Select your Home HQ or a marked node to inspect buildings and choose a Node order.'}
        </p>
      ) : (
        <div role="region" aria-label="Infrastructure node" className="flex flex-col gap-2">
          <Stat label="Node owner" value={node.owner ? TEAM_NAME[node.owner] : 'UNOWNED'} />
          <Stat label="Territorial claim" value={node.claim ? TEAM_NAME[node.claim] : 'NONE'} />
          <Stat label="Contested" value={node.contested ? 'YES' : 'NO'} />
          <Stat label="Node state" value={node.status.toUpperCase()} />
          <Stat label="Center" value={node.centerSubHex} />
          {node.homeTeam && <Stat label="Original Home HQ" value={TEAM_NAME[node.homeTeam]} />}
          <Stat label="Ordinary building point" value={node.work.ordinaryRemaining} />
          <Stat label="Building operations left" value={node.work.operationsRemaining} />
          {node.work.buildingWindow === 'closed' && (
            <p className="text-[10px] text-[hsl(var(--warning))]">
              Captured after the building window. Building work resumes next owner turn; network
              effects can update now.
            </p>
          )}
          {node.work.activationRepairOnly && (
            <p className="text-[10px] text-[hsl(var(--warning))]">
              Activation turn: one engineer-funded repair is available. Construction and upgrades
              wait until next turn.
            </p>
          )}
          {node.buildings.length > 0 && (
            <ul className="text-[10px] flex flex-col gap-1" aria-label="Node buildings">
              {node.buildings.map((building) => (
                <li key={building.id} className="border border-[hsl(var(--border))] p-1.5">
                  <div>
                    {building.name} · T{building.tier} · {building.subHex}
                  </div>
                  <div
                    className={
                      building.ruined
                        ? 'text-[hsl(var(--destructive))]'
                        : 'text-[hsl(var(--muted-foreground))]'
                    }
                  >
                    {building.ruined ? 'RUINED' : building.active ? 'ACTIVE' : 'INACTIVE'}
                    {building.placement === 'center' ? ' · center' : ' · side tile'}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {choices.length > 0 && (
            <>
              <label className="text-[10px] flex flex-col gap-1">
                <span>Node order</span>
                <select
                  value={choice?.request.requestId ?? ''}
                  onChange={(event) => setChoiceId(event.target.value)}
                  className="bg-[hsl(var(--panel))] border border-[hsl(var(--border-bright))] p-1 w-full"
                >
                  <option value="">Choose an order…</option>
                  {choices.map((candidate) => (
                    <option key={candidate.request.requestId} value={candidate.request.requestId}>
                      {candidate.label} · {candidate.cpCost} CP
                      {candidate.legal ? '' : ' · unavailable'}
                    </option>
                  ))}
                </select>
              </label>
              {choice && (
                <>
                  <Stat label="Order cost" value={`${choice.cpCost} CP`} />
                  {choice.engineerUnitId && (
                    <Stat
                      label="Engineer action"
                      value={choice.engineerLabel ?? engineer?.label ?? choice.engineerUnitId}
                    />
                  )}
                  {choice.allowance && (
                    <Stat
                      label="Allowance"
                      value={
                        {
                          ordinary: 'Ordinary node point',
                          engineer: 'Engineer action',
                          activation: 'Activation',
                        }[choice.allowance]
                      }
                    />
                  )}
                  {!choice.legal && choice.reason && (
                    <p className="text-[10px] text-[hsl(var(--warning))]">{choice.reason}</p>
                  )}
                  <Button
                    size="sm"
                    disabled={!canAct || !choice.legal}
                    onClick={() => {
                      if (
                        canAct &&
                        choice.legal &&
                        dispatch({ type: 'nodeWork', request: choice.request })
                      )
                        setChoiceId('');
                    }}
                  >
                    Carry out order ({choice.cpCost} CP)
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

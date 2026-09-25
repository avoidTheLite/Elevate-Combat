import { useState } from 'react';
import type { Army, GameState, Team } from '@iron-ridge/engine';
import {
  COMMAND,
  ECONOMY,
  armyStrength,
  attackCost,
  canTransfer,
  transferTargets,
  unitType,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import {
  canOrder,
  holderName,
  holderTitle,
  seenHolders,
  showsContents,
  transferRuleText,
} from '../../lib/holders.ts';

function hpTone(frac: number): string {
  return frac > 0.5 ? '#33ff88' : frac > 0.25 ? '#ffb020' : '#ff3344';
}

/**
 * Contents of the selected commander or HQ garrison: units with HP bars and
 * checkboxes, plus TRANSFER TO ▸ / NEW COMMANDER. Enemy holders seen under fog
 * show only their unit count (see `showsContents`).
 */
export function ContentsPanel({
  game,
  view,
}: {
  game: GameState;
  view: Team | null;
}): React.ReactElement {
  const ui = useGameStore((s) => s.ui);
  const dispatch = useGameStore((s) => s.dispatch);
  const setUi = useGameStore((s) => s.setUi);
  const [picking, setPicking] = useState(false);

  const holder = seenHolders(game, view).find((a) => a.id === ui.selectedArmy) ?? null;
  const cap = holder?.kind === 'garrison' ? COMMAND.garrisonCap : ECONOMY.armyCap;

  const title = holder ? holderTitle(holder) : 'CONTENTS';
  const right = holder ? (
    <span>
      {holder.units.length}/{cap}
      {holder.kind === 'commander' && ` · ${holder.movesLeft} step(s)`}
    </span>
  ) : undefined;

  if (!holder) {
    return (
      <Panel id="contents" title={title}>
        <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
          Click one of your commanders, or your HQ, to see what it holds.
        </div>
      </Panel>
    );
  }

  if (!showsContents(holder, view)) {
    return (
      <Panel id="contents" title={title} right={right}>
        <div className="text-[11px]" data-testid="contents-hidden">
          {holder.units.length} unit(s) — composition unknown.
        </div>
      </Panel>
    );
  }

  const orders = canOrder(game, holder, view);
  const checked = ui.checkedUnits.filter((id) => holder.units.some((u) => u.id === id));
  const setChecked = (ids: string[]): void => setUi({ checkedUnits: ids });
  const toggle = (id: string): void =>
    setChecked(checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id]);
  const allChecked = holder.units.length > 0 && checked.length === holder.units.length;

  const targets = orders ? transferTargets(game, holder.id) : [];
  const noTargetReason = `No holder in reach — transfers need one ${transferRuleText(game)}.`;
  const formBlocked =
    checked.length === 0
      ? 'Tick units first'
      : holder.kind === 'commander' && checked.length >= holder.units.length
        ? 'Leave at least one unit with the commander'
        : checked.length > ECONOMY.armyCap
          ? `A commander holds at most ${ECONOMY.armyCap} units`
          : null;

  const transfer = (to: Army): void => {
    if (dispatch({ type: 'transferUnits', fromId: holder.id, toId: to.id, unitIds: checked })) {
      setPicking(false);
      setUi({ checkedUnits: [] });
    }
  };
  const form = (): void => {
    const before = new Set(game.armies.map((a) => a.id));
    if (!dispatch({ type: 'formCommander', fromId: holder.id, unitIds: checked })) return;
    const next = useGameStore.getState().game!;
    const made = next.armies.find((a) => !before.has(a.id));
    // Select the new commander so it can be ordered (or inspected) right away.
    setUi({ selectedArmy: made?.id ?? holder.id, checkedUnits: [] });
    setPicking(false);
  };

  return (
    <Panel id="contents" title={title} right={right}>
      {holder.kind === 'commander' && (
        <>
          <Stat label="Strength" value={armyStrength(holder).toFixed(1)} />
          <Stat label="Attack deployment cost" value={`${attackCost(holder)} CP`} />
        </>
      )}
      {holder.units.length === 0 ? (
        <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
          Empty. Recruits arrive here.
        </div>
      ) : (
        <ul className="text-[11px] flex flex-col gap-0.5 max-h-52 overflow-auto" aria-label="units">
          {orders && (
            <li>
              <label className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => setChecked(allChecked ? [] : holder.units.map((u) => u.id))}
                  aria-label="select all units"
                />
                ALL
              </label>
            </li>
          )}
          {holder.units.map((u) => {
            const t = unitType(u.typeId);
            const frac = Math.max(0, Math.min(1, u.hp / t.hp));
            return (
              <li key={u.id} className="flex items-center gap-1.5">
                {orders && (
                  <input
                    type="checkbox"
                    checked={checked.includes(u.id)}
                    onChange={() => toggle(u.id)}
                    aria-label={`select ${u.label}`}
                  />
                )}
                <span className="flex-1 min-w-0 truncate">
                  {t.name} <span className="text-[hsl(var(--muted-foreground))]">{u.label}</span>
                </span>
                <span
                  className="w-10 h-1.5 bg-[#111a22] shrink-0"
                  title={`${u.hp}/${t.hp} HP`}
                  role="meter"
                  aria-valuenow={u.hp}
                  aria-valuemin={0}
                  aria-valuemax={t.hp}
                >
                  <span
                    className="block h-full"
                    style={{ width: `${Math.round(frac * 100)}%`, background: hpTone(frac) }}
                  />
                </span>
                <span className="w-9 text-right tabular-nums">
                  {u.hp}/{t.hp}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {orders && holder.units.length > 0 && (
        <>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              variant={picking ? 'default' : 'ghost'}
              disabled={checked.length === 0 || targets.length === 0}
              title={targets.length === 0 ? noTargetReason : undefined}
              onClick={() => setPicking((p) => !p)}
            >
              TRANSFER TO ▸
            </Button>
            <Button
              size="sm"
              className="flex-1"
              variant="ghost"
              disabled={formBlocked !== null}
              title={formBlocked ?? 'Split the ticked units into a new commander'}
              onClick={form}
            >
              NEW COMMANDER
            </Button>
          </div>
          {targets.length === 0 ? (
            <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
              {noTargetReason}
            </div>
          ) : (
            picking &&
            checked.length > 0 && (
              <div className="flex flex-col gap-1" role="list" aria-label="transfer targets">
                {targets.map((to) => {
                  const chk = canTransfer(game, holder, to, checked.length);
                  return (
                    <Button
                      key={to.id}
                      size="sm"
                      variant="ghost"
                      className="justify-between"
                      disabled={!chk.ok}
                      title={chk.ok ? undefined : chk.error}
                      onClick={() => transfer(to)}
                    >
                      <span>▸ {holderName(to)}</span>
                      <span className="text-[hsl(var(--muted-foreground))]">
                        {to.units.length}/
                        {to.kind === 'garrison' ? COMMAND.garrisonCap : ECONOMY.armyCap}
                      </span>
                    </Button>
                  );
                })}
              </div>
            )
          )}
          {checked.length > 0 && targets.length > 0 && (
            <div className="text-[10px] text-[hsl(var(--warning))]">
              {checked.length} ticked · eligible receivers are marked amber on the map.
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

import type { BattleContext, GameState, Team } from '@iron-ridge/engine';
import {
  TEAM_NAME,
  h,
  holdsCaptureZone,
  liveUnits,
  poolLabel,
  previewAttack,
  unitType,
  visionRange,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, PanelStack, Stat } from '../ui/Panel.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';

const DIR_NAMES = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

function actedTitle(acted: boolean, fallback: string): string {
  return acted ? 'Unit already acted this turn' : fallback;
}

export function TacticalSidebar({
  game,
  ctx,
  view,
  canAct,
  seenIds,
}: {
  game: GameState;
  ctx: BattleContext;
  view: Team | null;
  canAct: boolean;
  /** Units the viewer may know about (own + spotted enemies); null = all. */
  seenIds: Set<string> | null;
}): React.ReactElement {
  const battle = game.battle!;
  const ui = useGameStore((s) => s.ui);
  const dispatch = useGameStore((s) => s.dispatch);
  const setUi = useGameStore((s) => s.setUi);
  const shownId = ui.selectedUnit ?? (battle.phase === 'deploy' ? ui.deployPick : null);
  const picked = shownId ? battle.units.find((u) => u.id === shownId) : undefined;
  const unit = picked && picked.hp > 0 && (!view || picked.team === view) ? picked : undefined;
  const t = unit ? unitType(unit.typeId) : null;
  const hoverUnit = ui.hoverCell ? ctx.unitAt.get(ui.hoverCell) : undefined;
  const showHover = hoverUnit && (!seenIds || seenIds.has(hoverUnit.id));

  const preview =
    unit && ui.hoverCell && battle.phase === 'combat' && unit.team === battle.active && unit.pos
      ? previewAttack(ctx, battle, unit, ui.hoverCell)
      : null;
  const showPreview =
    preview &&
    (preview.legal || (showHover && hoverUnit.team !== unit?.team) || t?.attackType === 'indirect');

  const deploying = battle.phase === 'deploy';
  const myDeploy = deploying
    ? battle.units.filter((u) => u.team === battle.deployTeam && u.hp > 0)
    : [];

  const teamTone = (x: Team): string =>
    x === 'A' ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--secondary))]';
  const pct = (p: number): string => `${Math.round(p * 100)}%`;

  return (
    <PanelStack priority={['battle', 'battle-log', 'orders', 'unit']}>
      <Panel id="battle" title={`BATTLE FOR ${battle.contested}`}>
        <Stat
          label="Attacker"
          value={TEAM_NAME[battle.attacker]}
          tone={teamTone(battle.attacker)}
        />
        <Stat
          label="Defender"
          value={TEAM_NAME[battle.defender]}
          tone={teamTone(battle.defender)}
        />
        <Stat
          label="Round"
          value={
            battle.phase === 'combat'
              ? `${battle.round} / ${battle.maxRounds}`
              : battle.phase.toUpperCase()
          }
        />
        <Stat
          label="Warning"
          value={battle.warningTurns ? `${battle.warningTurns} turn(s)` : 'SURPRISE'}
        />
        <Stat
          label="Forces"
          value={`α ${liveUnits(battle, 'A').length} · β ${liveUnits(battle, 'B').length}`}
        />
        <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
          {battle.objective.kind === 'capture_point'
            ? `Hold capture point ${battle.objective.captureKey} (r${battle.objective.captureRadius}) clear of defenders to SECURE or EXTRACT. Round limit still favours the defender if the zone is contested.`
            : 'Attacker must hold the orange hex with the defender cleared from it by the round limit, or wipe out the defenders.'}
        </div>
      </Panel>

      {/* Fixed-size box: hovering never changes its dimensions. */}
      <Panel
        id="unit"
        title="SELECTED UNIT"
        right={unit ? <span className={teamTone(unit.team)}>{unit.label}</span> : undefined}
        bodyClassName="h-[380px] !gap-0"
      >
        <div
          className="h-[204px] overflow-y-auto flex flex-col gap-1 pr-1"
          data-testid="unit-detail"
        >
          {unit && t ? (
            <>
              <div className="text-[11px] font-bold truncate">{t.name}</div>
              <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4 line-clamp-2">
                {t.role}
              </div>
              <div className="grid grid-cols-2 gap-x-3">
                <Stat
                  label="HP"
                  value={`${unit.hp}/${unit.maxHp}`}
                  tone={unit.hp / unit.maxHp < 0.5 ? 'text-[hsl(var(--destructive))]' : undefined}
                />
                <Stat label="MP" value={`${unit.mp}/${t.move}`} />
                <Stat label="Armor" value={t.armorClass.replace('_armor', '')} />
                <Stat label="Weapon" value={t.damageType.replace('_', '-')} />
                <Stat label="Range" value={`${t.minRange}–${t.maxRange}`} />
                <Stat label="Dmg" value={poolLabel(t.direct)} />
                <Stat label="Elev" value={unit.pos ? `H${h(ctx, unit.pos)}` : '—'} />
                <Stat label="Vision" value={unit.pos ? visionRange(ctx, unit) : '—'} />
                <Stat label="Facing" value={DIR_NAMES[unit.facing]} />
                <Stat label="Type" value={t.attackType.replace('ranged_', '')} />
              </div>
              <div className="text-[10px] text-[hsl(var(--muted-foreground))] truncate">
                {t.placementCategory}
                {t.splash ? ` · splash ${poolLabel(t.splash)} r${t.splashRadius}` : ''}
              </div>
              <div className="text-[10px] truncate">
                {[
                  unit.acted ? 'ACTED' : 'READY',
                  unit.moved ? 'MOVED' : 'BRACED',
                  unit.deployed ? 'SET UP' : '',
                  unit.suppressed ? 'SUPPRESSED' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {battle.phase === 'combat' && canAct && unit.team === battle.active && (
                <div className="flex flex-wrap gap-1">
                  {t.placementCategory === 'combat_fixed' &&
                    (unit.deployed ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => dispatch({ type: 'packUp', unitId: unit.id })}
                        disabled={unit.acted}
                        title={actedTitle(unit.acted, 'Pack up to move again (spends the turn)')}
                      >
                        PACK UP
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => dispatch({ type: 'setUp', unitId: unit.id })}
                        disabled={unit.acted}
                        title={actedTitle(unit.acted, 'Set up to fire (combat_fixed)')}
                      >
                        SET UP
                      </Button>
                    ))}
                  {t.engineer && (
                    <Button
                      size="sm"
                      onClick={() => dispatch({ type: 'dig', unitId: unit.id })}
                      disabled={unit.acted}
                      title={actedTitle(unit.acted, 'Dig fortification on this cell')}
                    >
                      DIG IN
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      dispatch({ type: 'rotate', unitId: unit.id, dir: unit.facing + 1 })
                    }
                    disabled={unit.acted || unit.mp < 1}
                    title={
                      unit.acted
                        ? 'Unit already acted this turn'
                        : unit.mp < 1
                          ? 'Needs 1 MP to rotate'
                          : 'Rotate facing (1 MP)'
                    }
                  >
                    ↺ FACE
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      dispatch({ type: 'rotate', unitId: unit.id, dir: unit.facing + 5 })
                    }
                    disabled={unit.acted || unit.mp < 1}
                    title={
                      unit.acted
                        ? 'Unit already acted this turn'
                        : unit.mp < 1
                          ? 'Needs 1 MP to rotate'
                          : 'Rotate facing (1 MP)'
                    }
                  >
                    FACE ↻
                  </Button>
                </div>
              )}
              {t.specialRules.length > 0 && (
                <details className="text-[10px] text-[hsl(var(--muted-foreground))]">
                  <summary className="cursor-pointer tracking-widest">
                    SPECIAL RULES ({t.specialRules.length})
                  </summary>
                  <ul className="list-disc pl-4 leading-4 mt-1">
                    {t.specialRules.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4 m-auto text-center">
              {deploying
                ? 'Pick a unit from the roster to deploy it.'
                : 'Click one of your units to select it.'}
            </div>
          )}
        </div>

        <div
          className="flex-1 min-h-0 overflow-y-auto border-t border-[hsl(var(--border-bright))] pt-1.5 mt-1.5 flex flex-col gap-1 pr-1"
          data-testid="target-detail"
        >
          <div className="text-[10px] tracking-widest text-[hsl(var(--primary))]">
            {showPreview && preview ? '◎ FIRE CONTROL' : '◎ TARGET'}
          </div>
          {showPreview && preview ? (
            preview.legal ? (
              <>
                <Stat
                  label={`${preview.band} · eff ${preview.effectiveRange}`}
                  value={`TN ${preview.tn}`}
                  tone="font-bold"
                />
                <div className="grid grid-cols-2 gap-x-3 text-[10px] leading-4">
                  <span className="text-[hsl(var(--muted-foreground))] col-span-2 flex justify-between">
                    <span>
                      Base (
                      {preview.target
                        ? unitType(preview.target.typeId).armorClass.replace('_armor', '')
                        : 'ground'}
                      )
                    </span>
                    <span>{preview.baseTn}</span>
                  </span>
                  {preview.modifiers.map((m) => (
                    <span key={m.label} className="col-span-2 flex justify-between">
                      <span className="text-[hsl(var(--muted-foreground))] truncate">
                        {m.label}
                      </span>
                      <span>{m.value >= 0 ? `+${m.value}` : m.value}</span>
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-x-3">
                  <Stat
                    label="Hit"
                    value={pct(preview.pDirect)}
                    tone="text-[hsl(var(--success))] font-bold"
                  />
                  <Stat
                    label="Splash"
                    value={preview.splashTn !== null ? pct(preview.pSplash) : '—'}
                    tone="text-[hsl(var(--warning))]"
                  />
                  <Stat
                    label="Exp dmg"
                    value={preview.target && showHover ? preview.expectedDamage.toFixed(1) : '—'}
                  />
                  <Stat
                    label={preview.kind === 'indirect' ? 'Arc' : 'LOS'}
                    value={preview.los ? preview.los.status.toUpperCase() : '—'}
                  />
                </div>
                <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
                  {preview.blind ? 'No spotter — BLIND FIRE. ' : ''}Click to fire · F firing view
                </div>
              </>
            ) : (
              <div className="text-[11px] text-[hsl(var(--destructive))]">✖ {preview.reason}</div>
            )
          ) : null}
          {showHover &&
            hoverUnit &&
            hoverUnit.id !== unit?.id &&
            !(showPreview && preview?.legal) && (
              <div className="grid grid-cols-2 gap-x-3">
                <Stat label="Unit" value={hoverUnit.label} tone={teamTone(hoverUnit.team)} />
                <Stat label="HP" value={`${hoverUnit.hp}/${hoverUnit.maxHp}`} />
                <Stat label="Type" value={unitType(hoverUnit.typeId).short} />
                <Stat
                  label="Armor"
                  value={unitType(hoverUnit.typeId).armorClass.replace('_armor', '')}
                />
                <Stat label="Facing" value={DIR_NAMES[hoverUnit.facing]} />
              </div>
            )}
          {!showPreview && !(showHover && hoverUnit && hoverUnit.id !== unit?.id) && (
            <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
              {unit
                ? 'Hover an enemy (or any hex for indirect fire) to see the odds.'
                : 'Hover a unit to inspect it.'}
            </div>
          )}
        </div>
      </Panel>

      <Panel id="orders" title={deploying ? `DEPLOY — ${TEAM_NAME[battle.deployTeam]}` : 'ORDERS'}>
        {!canAct ? (
          <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
            Waiting for {TEAM_NAME[deploying ? battle.deployTeam : battle.active]}…
          </div>
        ) : deploying ? (
          <>
            <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
              Pick a unit, then click a green cell. combat_fixed units start packed and must SET UP
              before firing.
            </div>
            <ul className="flex flex-col gap-0.5 max-h-48 overflow-auto">
              {myDeploy.map((u) => (
                <li key={u.id}>
                  <Button
                    size="sm"
                    variant={ui.deployPick === u.id ? 'default' : 'ghost'}
                    className="w-full justify-between"
                    onClick={() => setUi({ deployPick: u.id, placingFort: false })}
                  >
                    <span>
                      {u.label} {unitType(u.typeId).name}
                    </span>
                    <span>{u.pos ? '✓' : '—'}</span>
                  </Button>
                </li>
              ))}
            </ul>
            {battle.deployTeam === battle.defender && battle.warnedPlacements > 0 && (
              <Button
                size="sm"
                variant={ui.placingFort ? 'default' : 'ghost'}
                onClick={() => setUi({ placingFort: !ui.placingFort, deployPick: null })}
              >
                PLACE SANDBAGS ({battle.warnedPlacements} left, ≤{battle.warnedRange} MP)
              </Button>
            )}
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="flex-1"
                onClick={() => dispatch({ type: 'autoDeploy' })}
              >
                AUTO-DEPLOY
              </Button>
              <Button
                size="sm"
                className="flex-1"
                onClick={() => dispatch({ type: 'finishDeploy' })}
              >
                READY ▶
              </Button>
            </div>
          </>
        ) : battle.phase === 'combat' ? (
          <>
            {canAct &&
              battle.active === battle.attacker &&
              holdsCaptureZone(ctx, battle, battle.attacker) && (
                <div className="flex gap-1 mb-1">
                  <Button
                    className="flex-1"
                    onClick={() => dispatch({ type: 'secureObjective' })}
                    title="Claim the hex and stay on the field (fortify in place)"
                  >
                    SECURE
                  </Button>
                  <Button
                    className="flex-1"
                    variant="ghost"
                    disabled={!battle.objective.extractionAtOrigin}
                    title={
                      battle.objective.extractionAtOrigin
                        ? `Free extract to deploy hex ${battle.origin} — you still capture the contested hex`
                        : 'This map has no extraction zone'
                    }
                    onClick={() => dispatch({ type: 'extract' })}
                  >
                    EXTRACT
                  </Button>
                </div>
              )}
            <div className="flex gap-1">
              <Button className="flex-1" onClick={() => dispatch({ type: 'endBattleTurn' })}>
                END TURN →
              </Button>
              <Button
                variant="destructive"
                title="Concede the field — the other side wins the hex"
                onClick={() => {
                  if (window.confirm('Withdraw from the battle? The other side wins the hex.'))
                    dispatch({ type: 'retreat' });
                }}
              >
                RETREAT
              </Button>
            </div>
            <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
              Click a unit to select · blue = reachable · red = valid target · right-click deselect.
              Illegal attacks show why in the error toast.
            </div>
          </>
        ) : (
          <div className="text-[10px] text-[hsl(var(--muted-foreground))]">Battle concluded.</div>
        )}
      </Panel>

      <Panel id="battle-log" title="COMBAT LOG" bodyClassName="h-56">
        <ol className="text-[10px] leading-4 h-full overflow-auto font-mono">
          {battle.log
            .slice(-80)
            .reverse()
            .map((l, i) => (
              <li
                key={i}
                className={
                  l.kind === 'kill'
                    ? 'text-[hsl(var(--destructive))] font-bold'
                    : l.kind === 'hit'
                      ? 'text-[hsl(var(--warning))]'
                      : l.kind === 'miss'
                        ? 'text-[hsl(var(--muted-foreground))]'
                        : l.kind === 'system'
                          ? 'text-[hsl(var(--accent))]'
                          : teamTone(l.team)
                }
              >
                {l.text}
              </li>
            ))}
        </ol>
      </Panel>
    </PanelStack>
  );
}

import type { BattleContext, BattleUnit, GameState, Team } from '@iron-ridge/engine';
import {
  TEAM_NAME,
  campaignNodeViews,
  h,
  poolLabel,
  previewAttack,
  unitType,
  visibleCells,
  visionRange,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';
import { holderName } from '../../lib/holders.ts';
import { chooseTileEntity, visibleTileEntities } from '../../lib/selection.ts';
import { RoadRepairPanel } from './RoadRepairPanel.tsx';
import { RazeTileControl } from './RazeTileControl.tsx';
import { EntityContextCard } from './EntityContextCard.tsx';
import { concealBlindDefender } from '../../controls/attackPresentation.ts';

const DIR_NAMES = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];
function actedTitle(acted: boolean, fallback: string): string {
  return acted ? 'Unit already acted this turn' : fallback;
}

function UnitContext({
  game,
  ctx,
  unit,
  canAct,
}: {
  game: GameState;
  ctx: BattleContext;
  unit: BattleUnit;
  canAct: boolean;
}): React.ReactElement {
  const dispatch = useGameStore((s) => s.dispatch);
  const battle = game.battle!;
  const t = unitType(unit.typeId);
  const canGiveOrders =
    battle.phase === 'combat' && canAct && unit.team === battle.active && !unit.stationed;
  return (
    <div className="flex flex-col gap-1" data-testid="unit-detail">
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
      {battle.phase === 'combat' && unit.stationed && (
        <p className="text-[10px] text-[hsl(var(--warning))]">
          Stationed · fire or Raze Tile in place. A commander must retrieve this unit to move it.
        </p>
      )}
      {canGiveOrders && (
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
            onClick={() => dispatch({ type: 'rotate', unitId: unit.id, dir: unit.facing + 1 })}
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
            onClick={() => dispatch({ type: 'rotate', unitId: unit.id, dir: unit.facing + 5 })}
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
      {battle.phase === 'combat' && (
        <RazeTileControl
          game={game}
          unitId={unit.id}
          canAct={canAct && unit.team === battle.active}
        />
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
    </div>
  );
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
  seenIds: Set<string> | null;
}): React.ReactElement | null {
  const battle = game.battle!;
  const ui = useGameStore((s) => s.ui);
  const dispatch = useGameStore((s) => s.dispatch);
  const setUi = useGameStore((s) => s.setUi);
  const deploying = battle.phase === 'deploy';
  const shownId = ui.selectedUnit ?? (deploying ? ui.deployPick : null);
  const picked = battle.units.find((candidate) => candidate.id === shownId && candidate.hp > 0);
  const unit = picked && (!seenIds || seenIds.has(picked.id)) ? picked : undefined;
  const key = ui.inspectedCell ?? unit?.pos ?? null;
  const entities = key
    ? visibleTileEntities(game, key, view).filter(
        (entity) => entity.kind !== 'unit' || !seenIds || seenIds.has(entity.id),
      )
    : [];
  const selectedId = entities.some((e) => e.id === ui.selectedEntity) ? ui.selectedEntity : null;
  const target = ui.hoverCell ?? (key !== unit?.pos ? key : null);
  const hoverUnit = target ? ctx.unitAt.get(target) : undefined;
  const showHover = hoverUnit && (!seenIds || seenIds.has(hoverUnit.id));
  const t = unit ? unitType(unit.typeId) : null;
  const preview =
    unit && target && battle.phase === 'combat' && unit.team === battle.active && unit.pos
      ? previewAttack(ctx, battle, unit, target)
      : null;
  const hideBlindStats = !!preview && concealBlindDefender(preview, view);
  const showPreview =
    preview &&
    (preview.legal || (showHover && hoverUnit.team !== unit?.team) || t?.attackType === 'indirect');
  const myDeploy = deploying
    ? battle.units.filter((u) => u.team === battle.deployTeam && u.hp > 0)
    : [];
  const pct = (p: number): string => `${Math.round(p * 100)}%`;
  const tileObserved = key && (!view || visibleCells(ctx, battle, view).has(key));
  const capture =
    key &&
    (battle.objective.kind === 'capture_point'
      ? key === battle.objective.captureKey
      : ctx.world.subByKey.get(key)?.main === battle.contested);
  if (!key && !deploying) return null;
  return (
    <div
      className="h-full overflow-y-auto overscroll-contain p-2 flex flex-col gap-2"
      data-testid="selection-context"
    >
      {key && (
        <Panel id="tile" title={`TILE ${key}`}>
          <Stat label="Elevation" value={`H${h(ctx, key)}`} />
          <Stat
            label="Fortification"
            value={tileObserved ? `${battle.forts[key] ?? 0} levels` : 'UNKNOWN'}
          />
          {capture && <p className="text-[10px] text-[hsl(var(--warning))]">Capture objective</p>}
        </Panel>
      )}
      {entities.map(
        (entity) =>
          entity.kind === 'unit' && (
            <EntityContextCard
              key={entity.id}
              entity={entity}
              selectedId={selectedId}
              onChoose={() => chooseTileEntity(game, key!, entity.id)}
            >
              <UnitContext game={game} ctx={ctx} unit={entity.unit} canAct={canAct} />
              {battle.phase === 'combat' && entity.unit.team === battle.active && (
                <RoadRepairPanel
                  game={game}
                  mainHex={key ? (ctx.world.subByKey.get(key)?.main ?? null) : null}
                  engineerUnitId={entity.id}
                  canAct={canAct}
                />
              )}
            </EntityContextCard>
          ),
      )}
      {entities
        .filter((entity) => entity.kind === 'building' || entity.kind === 'node')
        .map((entity) => (
          <EntityContextCard
            key={entity.id}
            entity={entity}
            selectedId={selectedId}
            onChoose={() => chooseTileEntity(game, key!, entity.id)}
          >
            {entity.kind === 'building' ? (
              <>
                <Stat label="Building" value={entity.building.name} />
                <Stat label="Tier" value={entity.building.tier} />
                <Stat
                  label="Status"
                  value={
                    entity.building.ruined
                      ? 'RUINED'
                      : entity.building.active
                        ? 'ACTIVE'
                        : 'INACTIVE'
                  }
                />
              </>
            ) : entity.kind === 'node' ? (
              <>
                <Stat label="Building" value={entity.label} />
                <Stat
                  label="Status"
                  value={
                    campaignNodeViews(game)
                      .find((node) => node.nodeId === entity.nodeId)
                      ?.status.toUpperCase() ?? 'UNKNOWN'
                  }
                />
              </>
            ) : null}
          </EntityContextCard>
        ))}
      {deploying && unit && !unit.pos && (
        <Panel title={unit.label}>
          <UnitContext game={game} ctx={ctx} unit={unit} canAct={canAct} />
        </Panel>
      )}
      {showPreview && preview && (
        <details
          data-testid="target-detail"
          className="border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-2 text-[11px]"
        >
          <summary className="cursor-pointer min-h-11 flex items-center text-[hsl(var(--primary))]">
            ATTACK BREAKDOWN · {target}
          </summary>
          {showPreview && preview ? (
            preview.legal ? (
              hideBlindStats ? (
                <div
                  data-testid="blind-fire-preview"
                  className="text-[11px] text-[hsl(var(--muted-foreground))]"
                >
                  <Stat
                    label={`${preview.band} · eff ${preview.effectiveRange}`}
                    value="BLIND FIRE"
                  />
                  No spotter. Defender statistics are unknown.
                </div>
              ) : (
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
              )
            ) : (
              <div className="text-[11px] text-[hsl(var(--destructive))]">✖ {preview.reason}</div>
            )
          ) : null}
        </details>
      )}
      {deploying && (
        <Panel id="orders" title={`DEPLOY — ${TEAM_NAME[battle.deployTeam]}`}>
          {!canAct ? (
            <p className="text-[10px]">Waiting for {TEAM_NAME[battle.deployTeam]}…</p>
          ) : (
            <>
              <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
                Pick a unit, then click a green cell.{' '}
                {battle.participants
                  ? 'Green cells belong to that unit’s commander. Additional commanders keep their strategic position and movement.'
                  : ''}{' '}
                combat_fixed units start packed and must SET UP before firing.
              </div>
              {battle.participants && unit?.holderId && (
                <p
                  data-testid="deployment-owner"
                  className="text-[10px] text-[hsl(var(--primary))]"
                >
                  {game.armies.some((holder) => holder.id === unit.holderId)
                    ? holderName(game.armies.find((holder) => holder.id === unit.holderId)!)
                    : `Force ${unit.holderId}`}{' '}
                  · zone anchor{' '}
                  {battle.participants.find((participant) => participant.armyId === unit.holderId)
                    ?.pos ?? 'fixed garrison'}
                </p>
              )}
              <ul
                aria-label="Deployment roster"
                className="flex flex-col gap-0.5 max-h-48 overflow-auto"
              >
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
                        {battle.participants && (
                          <span className="block text-[9px] text-[hsl(var(--muted-foreground))]">
                            {game.armies.some((holder) => holder.id === u.holderId)
                              ? holderName(game.armies.find((holder) => holder.id === u.holderId)!)
                              : `Force ${u.holderId ?? 'unknown'}`}
                          </span>
                        )}
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
          )}
        </Panel>
      )}
    </div>
  );
}

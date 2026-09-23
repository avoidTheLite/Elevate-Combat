import type { BattleContext, GameState, Team } from '@iron-ridge/engine';
import {
  TEAM_NAME,
  h,
  liveUnits,
  poolLabel,
  previewAttack,
  unitType,
  visionRange,
} from '@iron-ridge/engine';
import { Button } from '../ui/Button.tsx';
import { Panel, Stat } from '../ui/Panel.tsx';
import { useGameStore } from '../../stores/useGameStore.ts';

const DIR_NAMES = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

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
  const unit = ui.selectedUnit ? battle.units.find((u) => u.id === ui.selectedUnit) : undefined;
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

  return (
    <div className="flex flex-col gap-2">
      <Panel title={`BATTLE FOR ${battle.contested}`}>
        <Stat
          label="Attacker"
          value={TEAM_NAME[battle.attacker]}
          tone={
            battle.attacker === 'A' ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--secondary))]'
          }
        />
        <Stat
          label="Defender"
          value={TEAM_NAME[battle.defender]}
          tone={
            battle.defender === 'A' ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--secondary))]'
          }
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
          Attacker must hold the orange hex with the defender cleared from it by the round limit, or
          wipe out the defenders.
        </div>
      </Panel>

      {deploying && canAct && (
        <Panel title={`DEPLOY — ${TEAM_NAME[battle.deployTeam]}`}>
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
            <Button size="sm" className="flex-1" onClick={() => dispatch({ type: 'finishDeploy' })}>
              READY ▶
            </Button>
          </div>
        </Panel>
      )}

      {unit && t && unit.hp > 0 && (!view || unit.team === view) && (
        <Panel title={`${unit.label} · ${t.name}`}>
          <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">{t.role}</div>
          <Stat
            label="HP"
            value={`${unit.hp}/${unit.maxHp}`}
            tone={unit.hp / unit.maxHp < 0.5 ? 'text-[hsl(var(--destructive))]' : undefined}
          />
          <Stat
            label="MP"
            value={`${unit.mp}/${t.move}${unit.suppressed ? ' (SUPPRESSED)' : ''}`}
          />
          <Stat label="Armor · weapon" value={`${t.armorClass} · ${t.damageType}`} />
          <Stat
            label="Attack"
            value={`${t.attackType} ${t.minRange}–${t.maxRange} · ${poolLabel(t.direct)}${t.splash ? ` / splash ${poolLabel(t.splash)} r${t.splashRadius}` : ''}`}
          />
          <Stat label="Placement" value={t.placementCategory} />
          {unit.pos && (
            <Stat
              label="Elevation · vision"
              value={`H${h(ctx, unit.pos)} · ${visionRange(ctx, unit)}`}
            />
          )}
          <Stat label="Facing" value={DIR_NAMES[unit.facing]} />
          <Stat
            label="Status"
            value={[
              unit.acted ? 'ACTED' : 'READY',
              unit.moved ? 'MOVED' : 'BRACED',
              unit.deployed ? 'SET UP' : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          />
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
          {battle.phase === 'combat' && canAct && unit.team === battle.active && (
            <div className="flex flex-wrap gap-1">
              {t.placementCategory === 'combat_fixed' &&
                (unit.deployed ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => dispatch({ type: 'packUp', unitId: unit.id })}
                    disabled={unit.acted}
                  >
                    PACK UP
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => dispatch({ type: 'setUp', unitId: unit.id })}
                    disabled={unit.acted}
                  >
                    SET UP
                  </Button>
                ))}
              {t.engineer && (
                <Button
                  size="sm"
                  onClick={() => dispatch({ type: 'dig', unitId: unit.id })}
                  disabled={unit.acted}
                >
                  DIG IN
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dispatch({ type: 'rotate', unitId: unit.id, dir: unit.facing + 1 })}
                disabled={unit.acted || unit.mp < 1}
                title="Rotate facing (1 MP)"
              >
                ↺ FACE
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dispatch({ type: 'rotate', unitId: unit.id, dir: unit.facing + 5 })}
                disabled={unit.acted || unit.mp < 1}
                title="Rotate facing (1 MP)"
              >
                FACE ↻
              </Button>
            </div>
          )}
        </Panel>
      )}

      {showPreview && preview && (
        <Panel title="FIRE CONTROL">
          {preview.legal ? (
            <>
              <Stat
                label="Range"
                value={`${preview.distance} (eff ${preview.effectiveRange}) ${preview.band}`}
              />
              <Stat label="To-hit TN" value={`${preview.tn} (base ${preview.baseTn})`} />
              <ul className="text-[10px] leading-4">
                {preview.modifiers.map((m) => (
                  <li key={m.label} className="flex justify-between">
                    <span className="text-[hsl(var(--muted-foreground))]">{m.label}</span>
                    <span>{m.value >= 0 ? `+${m.value}` : m.value}</span>
                  </li>
                ))}
              </ul>
              <Stat
                label="Direct hit"
                value={`${Math.round(preview.pDirect * 100)}%`}
                tone="text-[hsl(var(--success))] font-bold"
              />
              {preview.splashTn !== null && (
                <Stat
                  label="Splash (roll ≥10)"
                  value={`${Math.round(preview.pSplash * 100)}%`}
                  tone="text-[hsl(var(--warning))]"
                />
              )}
              {preview.target && showHover && (
                <Stat label="Expected damage" value={preview.expectedDamage.toFixed(1)} />
              )}
              {preview.los && (
                <Stat
                  label={preview.kind === 'indirect' ? 'Arc' : 'LOS'}
                  value={preview.los.status.toUpperCase()}
                />
              )}
              {preview.blind && (
                <div className="text-[10px] text-[hsl(var(--warning))]">
                  No spotter — BLIND FIRE (no splash band)
                </div>
              )}
              <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
                Click to fire. F = firing view.
              </div>
            </>
          ) : (
            <div className="text-[11px] text-[hsl(var(--destructive))]">✖ {preview.reason}</div>
          )}
        </Panel>
      )}

      {showHover && hoverUnit && hoverUnit.id !== unit?.id && (
        <Panel title={`${hoverUnit.label} · ${TEAM_NAME[hoverUnit.team]}`}>
          <Stat label="Type" value={unitType(hoverUnit.typeId).name} />
          <Stat label="HP" value={`${hoverUnit.hp}/${hoverUnit.maxHp}`} />
          <Stat label="Armor" value={unitType(hoverUnit.typeId).armorClass} />
          <Stat label="Facing" value={DIR_NAMES[hoverUnit.facing]} />
        </Panel>
      )}

      {battle.phase === 'combat' && canAct && (
        <Panel title="ORDERS">
          <div className="flex gap-1">
            <Button className="flex-1" onClick={() => dispatch({ type: 'endBattleTurn' })}>
              END TURN →
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (window.confirm('Withdraw from the battle? The other side wins the hex.'))
                  dispatch({ type: 'retreat' });
              }}
            >
              RETREAT
            </Button>
          </div>
          <div className="text-[10px] text-[hsl(var(--muted-foreground))] leading-4">
            Click a unit to select · blue = reachable · red = valid target · hover a target for odds
            · right-click deselect.
          </div>
        </Panel>
      )}

      <Panel title="COMBAT LOG">
        <ol className="text-[10px] leading-4 max-h-64 overflow-auto font-mono">
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
                          : l.team === 'A'
                            ? 'text-[hsl(var(--primary))]'
                            : 'text-[hsl(var(--secondary))]'
                }
              >
                {l.text}
              </li>
            ))}
        </ol>
      </Panel>
    </div>
  );
}

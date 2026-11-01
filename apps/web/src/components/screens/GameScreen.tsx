import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GameState, Team } from '@iron-ridge/engine';
import {
  TEAM_NAME,
  actingTeam,
  attackCost,
  autoResolveOdds,
  engagementCandidates,
  engagementCosts,
  isAiTurn,
  liveUnits,
  previewAttack,
  reachable,
  unitType,
  revealedEnemies,
  foundationHasPending,
  campaignSupplyView,
} from '@iron-ridge/engine';
import { buildStrategicScene, buildTacticalScene } from '../../render/buildScene.ts';
import { useGameStore, viewTeam } from '../../stores/useGameStore.ts';
import { OverlayBar } from '../game/OverlayBar.tsx';
import { SceneView } from '../game/SceneView.tsx';
import { useViewStore } from '../../stores/useViewStore.ts';
import { holderName, seenHolders } from '../../lib/holders.ts';
import { strategicClick } from '../../lib/strategicClick.ts';
import { StrategicSidebar } from '../game/StrategicSidebar.tsx';
import { TacticalSidebar } from '../game/TacticalSidebar.tsx';
import { Button } from '../ui/Button.tsx';
import { Panel } from '../ui/Panel.tsx';
import { SaveMenu } from '../game/SaveMenu.tsx';
import { FoundationResolution } from '../game/FoundationResolution.tsx';
import { FoundationDemoGuide } from '../game/FoundationDemoGuide.tsx';

function teamClass(t: Team): string {
  return t === 'A' ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--secondary))]';
}

export function GameScreen(): React.ReactElement {
  const game = useGameStore((s) => s.game)!;
  const ui = useGameStore((s) => s.ui);
  const error = useGameStore((s) => s.error);
  const handoff = useGameStore((s) => s.handoff);
  const aiSpeed = useGameStore((s) => s.aiSpeed);
  const fx = useGameStore((s) => s.fx);
  const quitPrompt = useGameStore((s) => s.quitPrompt);
  const { setUi, aiTick, clearError, dismissHandoff, requestQuit, setAiSpeed } =
    useGameStore.getState();
  const [help, setHelp] = useState(false);

  const view = viewTeam(game);
  const acting = actingTeam(game);
  const aiTurn = isAiTurn(game);
  const humanActing = !aiTurn && acting !== null && game.settings.controllers[acting] === 'human';
  const inBattle = game.phase === 'battle' && game.battle !== null;
  const foundationPending = foundationHasPending(game);

  // AI pacing loop.
  useEffect(() => {
    if (!aiTurn || handoff) return;
    const delay =
      game.phase === 'battle'
        ? game.battle?.phase === 'deploy'
          ? 60
          : aiSpeed
        : Math.min(aiSpeed, 150);
    // Let the AI's last shot land before it acts again.
    const wait = Math.max(delay, useGameStore.getState().fxBusyUntil - Date.now());
    const id = setTimeout(() => aiTick(), wait);
    return () => clearTimeout(id);
  }, [game, aiTurn, handoff, aiSpeed, aiTick]);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => clearError(), 3500);
    return () => clearTimeout(id);
  }, [error, clearError]);

  const overlay = useViewStore((s) => s.overlay);
  const inspectedSupplyRoute = useMemo(() => {
    if (!game.infrastructure || inBattle || !ui.selectedMain) return [];
    const holder = game.armies.find((candidate) => candidate.id === ui.selectedArmy);
    if (holder?.kind === 'commander') return [];
    const site = game.infrastructure.sites.find(
      (candidate) => candidate.mainHex === ui.selectedMain,
    );
    if (!site) return [];
    return campaignSupplyView(game, game.active)?.nodes[site.nodeId]?.activeRoute?.path ?? [];
  }, [game, inBattle, ui.selectedMain, ui.selectedArmy]);
  const tactical = useMemo(
    () => (inBattle ? buildTacticalScene(game, ui, view, overlay) : null),
    [game, ui, view, inBattle, overlay],
  );
  const strategic = useMemo(
    () => (!inBattle ? buildStrategicScene(game, ui, view, overlay, inspectedSupplyRoute) : null),
    [game, ui, view, inBattle, overlay, inspectedSupplyRoute],
  );
  const spec = tactical?.spec ?? strategic!;

  const seenIds = useMemo(() => {
    if (!tactical || !view || !game.battle) return null;
    const ids = new Set(liveUnits(game.battle, view).map((u) => u.id));
    for (const e of revealedEnemies(tactical.ctx, game.battle, view)) ids.add(e.id);
    return ids;
  }, [tactical, view, game.battle]);

  const selectedKey = useMemo(() => {
    if (inBattle) {
      const u = game.battle!.units.find((x) => x.id === (ui.selectedUnit ?? ui.deployPick));
      return u?.pos ?? null;
    }
    // Strategic: ring the selected holder's sub-hex (if the viewer can see it).
    return seenHolders(game, view).find((a) => a.id === ui.selectedArmy)?.pos ?? null;
  }, [inBattle, game, view, ui.selectedUnit, ui.deployPick, ui.selectedArmy]);

  const onHover = useCallback((key: string | null) => setUi({ hoverCell: key }), [setUi]);

  const onClick = useCallback((key: string, button: number) => {
    const s = useGameStore.getState();
    const g = s.game!;
    const u = s.ui;
    if (button === 2 || !key) {
      s.setUi({
        selectedArmy: null,
        checkedUnits: [],
        selectedUnit: null,
        selectedMain: null,
        deployPick: null,
        placingFort: false,
      });
      return;
    }
    const v = viewTeam(g);
    const act = actingTeam(g);
    const human = act !== null && !isAiTurn(g) && g.settings.controllers[act] === 'human';
    if (foundationHasPending(g)) return;

    if (g.phase === 'strategic' || g.phase === 'battle-pending' || g.phase === 'over') {
      strategicClick(key);
      return;
    }

    const b = g.battle!;
    if (!human) return;
    if (b.phase === 'deploy') {
      if (u.placingFort) {
        s.dispatch({ type: 'placeFort', cell: key });
        return;
      }
      const occupant = b.units.find((x) => x.pos === key && x.team === b.deployTeam);
      if (occupant) {
        s.setUi({ deployPick: occupant.id });
        return;
      }
      if (u.deployPick && s.dispatch({ type: 'deploy', unitId: u.deployPick, cell: key })) {
        const next = s.game!.battle!.units.find(
          (x) => x.team === b.deployTeam && !x.pos && x.hp > 0,
        );
        s.setUi({ deployPick: next?.id ?? null });
      }
      return;
    }
    if (b.phase !== 'combat') return;
    const mine = b.units.find((x) => x.pos === key && x.hp > 0 && x.team === b.active);
    if (mine) {
      s.setUi({ selectedUnit: mine.id });
      return;
    }
    const sel = u.selectedUnit
      ? b.units.find((x) => x.id === u.selectedUnit && x.hp > 0)
      : undefined;
    if (!sel) return;
    const ctx = buildTacticalScene(g, u, v).ctx;
    const t = unitType(sel.typeId);
    const target = ctx.unitAt.get(key);
    const wantsAttack =
      t.attackType === 'indirect'
        ? !reachable(ctx, sel).has(key) || !!target
        : !!target && target.team !== sel.team;
    if (wantsAttack && previewAttack(ctx, b, sel, key).legal) {
      s.dispatch({ type: 'attack', unitId: sel.id, cell: key });
      return;
    }
    if (!sel.stationed && !sel.acted && !sel.deployed && reachable(ctx, sel).has(key)) {
      s.dispatch({ type: 'move', unitId: sel.id, cell: key });
      return;
    }
    if (wantsAttack) s.dispatch({ type: 'attack', unitId: sel.id, cell: key }); // surfaces the reason
  }, []);

  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-[hsl(var(--border-bright))] text-[11px] flex-wrap">
        <div className="flex items-center gap-3">
          <span className="font-bold tracking-[0.3em] text-glow">▲ IRON RIDGE</span>
          <span className="text-[hsl(var(--muted-foreground))]">
            {game.settings.era.toUpperCase()} · {game.settings.grid.mainCols}×
            {game.settings.grid.mainRows} / r{game.settings.grid.subRadius}
          </span>
          {game.settings.infrastructure && (
            <span className="text-[hsl(var(--warning))]">
              {game.settings.infrastructure.tuningStatus === 'playtest'
                ? 'INFRASTRUCTURE PLAYTEST'
                : 'INFRASTRUCTURE'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[hsl(var(--muted-foreground))]">TURN {game.turn}</span>
          {inBattle && <span className="text-[hsl(var(--warning))]">⚔ TACTICAL</span>}
          {acting && (
            <span className={`font-bold ${teamClass(acting)}`}>
              ◈ {TEAM_NAME[acting]} ACTIVE{aiTurn ? ' (AI thinking…)' : ''}
            </span>
          )}
          <span className="text-[hsl(var(--primary))]">α {game.cp.A} CP</span>
          <span className="text-[hsl(var(--secondary))]">β {game.cp.B} CP</span>
        </div>
        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))]">
            AI
            <select
              value={aiSpeed}
              onChange={(e) => setAiSpeed(Number(e.target.value))}
              className="bg-transparent border border-[hsl(var(--border-bright))] text-[hsl(var(--primary))]"
            >
              <option value={450}>slow</option>
              <option value={220}>normal</option>
              <option value={60}>fast</option>
            </select>
          </label>
          <Button size="sm" variant="ghost" onClick={() => setHelp(true)}>
            ? HELP
          </Button>
          <Button size="sm" variant="ghost" onClick={() => requestQuit()}>
            MENU
          </Button>
        </div>
      </header>
      <FoundationDemoGuide game={game} />

      {/* Map and sidebar split the viewport; only the sidebar scrolls, the map never moves. */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        <main className="relative shrink-0 h-[48dvh] md:h-auto md:flex-1 md:shrink">
          <SceneView
            spec={spec}
            fx={fx}
            selectedKey={selectedKey}
            onHover={onHover}
            onClick={onClick}
          />
          <OverlayBar battle={inBattle ? game.battle! : null} />
          {error && game.phase !== 'battle-pending' && (
            <div
              role="alert"
              className="absolute top-2 left-1/2 -translate-x-1/2 border border-[hsl(var(--destructive))] bg-[hsl(var(--panel))] text-[hsl(var(--destructive))] text-[11px] px-3 py-1"
            >
              ✖ {error}
            </div>
          )}
        </main>
        <aside className="flex-1 min-h-0 md:flex-none md:w-[320px] overflow-hidden border-t md:border-t-0 md:border-l border-[hsl(var(--border-bright))]">
          {tactical ? (
            <TacticalSidebar
              game={game}
              ctx={tactical.ctx}
              view={view}
              canAct={humanActing && !foundationPending}
              seenIds={seenIds}
            />
          ) : (
            <StrategicSidebar
              game={game}
              view={view}
              canAct={humanActing && !foundationPending && game.phase === 'strategic'}
            />
          )}
        </aside>
      </div>

      {game.phase === 'battle-pending' &&
        game.pending &&
        !aiTurn &&
        !foundationPending &&
        !handoff && <PendingBattle game={game} />}
      {inBattle && game.battle!.phase === 'over' && !aiTurn && !foundationPending && (
        <BattleOver game={game} />
      )}
      {foundationPending && <FoundationResolution game={game} />}
      {game.phase === 'over' && <GameOver game={game} />}
      {handoff && !aiTurn && (
        <Overlay>
          <div className={`text-2xl font-bold tracking-widest ${teamClass(handoff)}`}>
            ◈ {TEAM_NAME[handoff]}
          </div>
          <div className="text-[hsl(var(--muted-foreground))] text-xs">
            Pass the device. The other commander should look away.
          </div>
          <Button size="lg" onClick={() => dismissHandoff()}>
            I AM {TEAM_NAME[handoff]} — CONTINUE
          </Button>
        </Overlay>
      )}
      {help && <Help onClose={() => setHelp(false)} />}
      {quitPrompt && <QuitDialog />}
    </div>
  );
}

function QuitDialog(): React.ReactElement {
  const cancelQuit = useGameStore((s) => s.cancelQuit);
  const saveAndQuit = useGameStore((s) => s.saveAndQuit);
  const abandon = useGameStore((s) => s.abandon);
  return (
    <Overlay>
      <div className="text-lg font-bold tracking-widest">LEAVE CAMPAIGN?</div>
      <div className="text-xs text-[hsl(var(--muted-foreground))] leading-4">
        Save &amp; Quit keeps CONTINUE on the setup screen. Abandon deletes the autosave.
      </div>
      <SaveMenu />
      <div className="flex flex-wrap gap-2 justify-center">
        <Button size="lg" onClick={() => saveAndQuit()}>
          SAVE &amp; QUIT
        </Button>
        <Button size="lg" variant="destructive" onClick={() => abandon()}>
          ABANDON
        </Button>
        <Button size="lg" variant="ghost" onClick={() => cancelQuit()}>
          CANCEL
        </Button>
      </div>
    </Overlay>
  );
}

function Overlay({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-[hsl(var(--background)/0.86)] p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="border border-[hsl(var(--border-bright))] bg-[hsl(var(--panel))] p-5 max-w-[520px] max-h-[92dvh] overflow-y-auto w-full flex flex-col items-center gap-3 text-center"
      >
        {children}
      </div>
    </div>
  );
}

function PendingBattle({ game }: { game: GameState }): React.ReactElement {
  const dispatch = useGameStore((s) => s.dispatch);
  const error = useGameStore((s) => s.error);
  const p = game.pending!;
  const att = game.armies.find((a) => a.id === p.attackerArmyId)!;
  const def = game.armies.find((a) => a.id === p.defenderArmyId)!;
  const participation = p.participation;
  const selecting = participation && participation.stage !== 'ready';
  const costs = participation ? engagementCosts(game, p) : null;
  const humanInvolved = Object.values(game.settings.controllers).includes('human');
  const canAfford = costs ? costs.A <= game.cp.A && costs.B <= game.cp.B : true;

  return (
    <Overlay>
      <div className="text-lg font-bold tracking-widest text-[hsl(var(--warning))]">
        ⚔ ENGAGEMENT AT {p.target}
      </div>
      {error && (
        <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
          {error}
        </p>
      )}
      {selecting ? (
        <ParticipantChoices game={game} />
      ) : (
        <>
          <div className="text-xs">
            <span className={teamClass(att.team)}>{TEAM_NAME[att.team]}</span> assaults from{' '}
            {p.origin}.
            {costs
              ? ` Confirmed participation: ${TEAM_NAME[att.team]} ${costs[att.team]} CP; ${TEAM_NAME[def.team]} ${costs[def.team]} CP.`
              : ` Opening the deployment costs ${attackCost(att)} CP.`}
          </div>
          {participation && (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              Both sides have locked their commanders. Commit once to open deployment. Additional
              commanders keep their positions and strategic movement; units retain their commander.
            </p>
          )}
          <div className="text-xs text-[hsl(var(--muted-foreground))]">
            Auto-resolve estimate (terrain + fortification + force ratio): attacker{' '}
            {Math.round(autoResolveOdds(game, p) * 100)}%
          </div>
          {!canAfford && (
            <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
              A side no longer has enough CP for the confirmed participants.
            </p>
          )}
          {participation && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2 flex-wrap justify-center">
                {[att, def]
                  .filter((holder) => game.settings.controllers[holder.team] === 'human')
                  .map((holder) => (
                    <Button
                      key={holder.id}
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        dispatch({
                          type: 'engagementSelect',
                          team: holder.team,
                          armyIds:
                            holder.id === att.id
                              ? participation.attackerIds
                              : participation.defenderIds,
                        })
                      }
                    >
                      EDIT {TEAM_NAME[holder.team]} COMMANDERS
                    </Button>
                  ))}
              </div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                Edit your side to change participants before spending. Editing the attacker asks the
                defender to choose again.
              </p>
            </div>
          )}
          <div className="flex gap-2 flex-wrap justify-center">
            <Button
              size="lg"
              disabled={!canAfford}
              onClick={() => dispatch({ type: 'startBattle' })}
            >
              FIGHT TACTICAL BATTLE
            </Button>
            <Button
              size="lg"
              variant="ghost"
              disabled={!canAfford}
              onClick={() => dispatch({ type: 'autoResolve' })}
            >
              AUTO-RESOLVE
            </Button>
          </div>
        </>
      )}
      {humanInvolved && (participation || game.settings.controllers[att.team] === 'human') && (
        <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'cancelBattle' })}>
          {participation ? 'ABORT ENGAGEMENT — NO SPEND' : 'CANCEL'}
        </Button>
      )}
      {participation && <SaveMenu />}
    </Overlay>
  );
}

function ParticipantChoices({ game }: { game: GameState }): React.ReactElement {
  const dispatch = useGameStore((s) => s.dispatch);
  const p = game.pending!;
  const selection = p.participation!;
  const attacker = game.armies.find((army) => army.id === p.attackerArmyId)!;
  const defender = game.armies.find((army) => army.id === p.defenderArmyId)!;
  const side = selection.stage === 'defender' ? defender.team : attacker.team;
  const primary = side === attacker.team ? attacker : defender;
  const selectedIds = side === attacker.team ? selection.attackerIds : selection.defenderIds;
  const candidates = engagementCandidates(game, side).filter(
    (candidate) => candidate.armyId !== primary.id,
  );
  const costs = engagementCosts(game, p);
  const enoughCp = costs[side] <= game.cp[side];
  const additionalPrice =
    side === attacker.team
      ? game.settings.engagement!.additionalAttackerCp
      : game.settings.engagement!.additionalDefenderCp;
  const choose = (id: string): void => {
    const ids = selectedIds.includes(id)
      ? selectedIds.filter((candidate) => candidate !== id)
      : [...selectedIds, id];
    dispatch({ type: 'engagementSelect', team: side, armyIds: ids });
  };

  return (
    <section
      aria-label={`${TEAM_NAME[side]} participant selection`}
      className="flex flex-col gap-3 text-left w-full"
    >
      <h2 className={`text-sm font-bold tracking-widest ${teamClass(side)}`}>
        {TEAM_NAME[side]} — CHOOSE COMMANDERS
      </h2>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        {selection.stage === 'attacker'
          ? 'Attacker chooses first.'
          : 'The attacker has locked its choices.'}{' '}
        Only your side’s choices are shown. Additional commanders stay in place and keep their
        strategic movement. Their units use deployment zones around their own commander.
      </p>
      <p className="text-xs">
        Mandatory: {holderName(primary)} · {primary.units.length} units
      </p>
      <ul
        aria-label="Additional commanders"
        className="flex flex-col gap-2 max-h-[38dvh] overflow-y-auto"
      >
        {candidates.map((candidate) => {
          const commander = game.armies.find((army) => army.id === candidate.armyId)!;
          const included = selectedIds.includes(commander.id);
          const unaffordable = !included && costs[side] + additionalPrice > game.cp[side];
          return (
            <li key={commander.id} className="border border-[hsl(var(--border))] p-2">
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={`Include commander ${commander.id}`}
                  checked={included}
                  disabled={!!candidate.reason || unaffordable}
                  onChange={() => choose(commander.id)}
                />
                <span>
                  <span className="font-bold">{holderName(commander)}</span> ·{' '}
                  {commander.units.length} units
                  <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                    Zone anchor {commander.pos} · {commander.movesLeft} strategic steps remain
                  </span>
                  <span className="block text-[10px]">
                    {candidate.reason ??
                      (unaffordable
                        ? 'Not enough CP to add this commander'
                        : candidate.alreadyPresent
                          ? 'Already in an initial battle MainHex'
                          : `Qualifies by a legal ${candidate.steps}-step route; no travel is performed`)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {candidates.length === 0 && <p className="text-xs">No additional commanders.</p>}
      <p className="text-xs font-bold" data-testid="participation-total">
        {TEAM_NAME[side]} participation: {costs[side]} CP / {game.cp[side]} available
      </p>
      {!enoughCp && (
        <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
          Not enough CP for this selection.
        </p>
      )}
      <Button disabled={!enoughCp} onClick={() => dispatch({ type: 'engagementLock', team: side })}>
        LOCK {TEAM_NAME[side]} COMMANDERS
      </Button>
      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
        Locking spends nothing. Both sides’ costs commit together when the battle starts. Declined
        commanders remain outside this battle and still affect territorial control.
      </p>
    </section>
  );
}

function BattleOver({ game }: { game: GameState }): React.ReactElement {
  const dispatch = useGameStore((s) => s.dispatch);
  const b = game.battle!;
  const lost = (team: Team): number => b.units.filter((u) => u.team === team && u.hp <= 0).length;
  return (
    <Overlay>
      <div className={`text-xl font-bold tracking-widest ${teamClass(b.winner!)}`}>
        ◈ {TEAM_NAME[b.winner!]} VICTORIOUS
      </div>
      <div className="text-xs">{b.endReason}</div>
      <div className="text-xs text-[hsl(var(--muted-foreground))]">
        Losses — α {lost('A')} · β {lost('B')} · Fortifications on the field persist into the
        campaign.
      </div>
      <Button size="lg" onClick={() => dispatch({ type: 'concludeBattle' })}>
        RETURN TO CAMPAIGN
      </Button>
    </Overlay>
  );
}

function GameOver({ game }: { game: GameState }): React.ReactElement {
  const abandon = useGameStore((s) => s.abandon);
  const last = game.log[game.log.length - 1];
  const draw = game.winner === null;
  return (
    <Overlay>
      <div
        className={`text-2xl font-bold tracking-widest ${draw ? 'text-[hsl(var(--muted-foreground))]' : teamClass(game.winner!)}`}
      >
        {draw ? '★ DRAW' : `★ ${TEAM_NAME[game.winner!]} WINS`}
      </div>
      <div className="text-xs">{last?.text}</div>
      <Button size="lg" onClick={() => abandon()}>
        NEW CAMPAIGN
      </Button>
    </Overlay>
  );
}

function Help({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-[hsl(var(--background)/0.9)] p-4"
      onClick={onClose}
    >
      <Panel
        title="FIELD MANUAL"
        className="max-w-[640px] w-full max-h-[85vh] overflow-auto"
        right={<button onClick={onClose}>✕</button>}
      >
        <div
          className="text-[11px] leading-5 flex flex-col gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <p>
            <b className="text-[hsl(var(--primary))]">Goal:</b> capture the enemy HQ (or hold more
            territory at turn 40).
          </p>
          <p>
            <b className="text-[hsl(var(--primary))]">Campaign:</b> each large hex is a main hex
            made of sub-hexes. Commanders march on the sub-hexes: select one and click a green cell
            to move (about one main hex of steps per turn; all-fast commanders march double). Click
            a red-marked enemy within engage range to open a battle. Recruits join your HQ garrison
            — click the HQ, tick units and form a NEW COMMANDER or TRANSFER them to a nearby holder.
            You only see enemy holders your commanders and garrisons have line of sight to, or that
            stand next to your territory. CP buys units, fortifies your hexes, and pays to open
            deployments. Enemy holders next to or inside your hexes start a warning clock that
            grants the defender warned-category sandbags when attacked.
          </p>
          <p>
            <b className="text-[hsl(var(--primary))]">Battle:</b> fought on the sub-hex grid of the
            contested hex and its neighbours. Defender deploys in the orange hex, attacker in the
            hex it came from. In experimental multi-commander games, each additional commander
            supplies a zone at its current position; pick a unit to see its own green zone.
            Participation preserves additional commanders’ strategic movement. Each unit may move
            (terrain cost: 1 + climb) and then act once. Hover a target for the full to-hit
            breakdown; the arc is green (clear), amber (marginal) or red (blocked).
          </p>
          <p>
            <b className="text-[hsl(var(--primary))]">Rules:</b> d20 ≥ TN. Base TN heavy 7 / light
            10 / unarmored 15, plus range band (effective range adds 2 per uphill level), braced −2
            / moved +3, facing (front +2, side −1, rear +1) and cover. HE weapons splash on 10+.
            Damage = dice × damage-type effectiveness − armor (0/3/6) ± facing. Tanks can't depress
            below ⌊dist/3⌋. Indirect fire needs a spotter with LOS or fires blind (+6). combat_fixed
            units must SET UP to fire. Engineers DIG IN.
          </p>
          <p>
            <b className="text-[hsl(var(--primary))]">Camera:</b> WASD/arrows or drag to pan, Q/E
            rotate, wheel zoom, R reset, F firing view while aiming, 1/2/3 map overlay (basic /
            height / control).
          </p>
        </div>
      </Panel>
    </div>
  );
}

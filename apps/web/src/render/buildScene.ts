// ── GameState + UI selection → SceneSpec ─────────────────────────────────────

import type { BattleContext, BattleUnit, GameState, Team, World } from '@iron-ridge/engine';
import {
  arcClearance,
  buildContext,
  canMoveTo,
  deploymentZone,
  edgeSegment,
  generateTerrain,
  hexKey,
  lineOfSight,
  liveUnits,
  mainBoundary,
  neighbor,
  parseKey,
  pathTo,
  previewAttack,
  reachable,
  unitType,
  visibleArmies,
  visibleCells,
  visibleEnemies,
  warnedRangeCells,
  worldOf,
} from '@iron-ridge/engine';
import type { UiState } from '../stores/useGameStore.ts';
import type {
  BorderLayer,
  Segment3,
  CellSpec,
  OverlaySpec,
  SceneSpec,
  TokenKind,
  TokenSpec,
} from './spec.ts';
import { TEAM_COLOR, topY } from './spec.ts';
import type { OverlayMode } from './overlays.ts';
import { CAPTURE_COLOR, basicColors, controlColors, heightColors } from './overlays.ts';

export function tokenKind(typeId: string): TokenKind {
  const t = unitType(typeId);
  if (t.engineer) return 'engineer';
  if (t.unitClass === 'cavalry') return 'cavalry';
  if (t.unitClass === 'vehicle') return t.attackType === 'indirect' ? 'artillery' : 'vehicle';
  if (t.unitClass === 'artillery' || t.attackType === 'indirect') return 'artillery';
  return 'infantry';
}

function heightFn(world: World, heights: Int8Array): (k: string) => number {
  return (k) => {
    const s = world.subByKey.get(k);
    return s ? heights[s.index]! : 0;
  };
}

/**
 * Outline of a set of main hexes as one continuous chain of lines.
 *
 * Every main hex draws its own full outline, each edge at the top height of its
 * own (rendered) border cell — never at a neighbour's height, so there are no
 * lines floating over out-of-play terrain. Wherever consecutive edges step to a
 * different height, a vertical connector joins them at the shared corner, so the
 * outline follows the prism faces like a single wire.
 */
export function mainOutline(
  world: World,
  mains: string[],
  hOf: (k: string) => number,
  filter: (inner: string, outer: string | null) => boolean = () => true,
): Segment3[] {
  const out: Segment3[] = [];
  const corners = new Map<string, { x: number; z: number; ys: number[] }>();
  const addCorner = (x: number, z: number, y: number): void => {
    const k = `${x.toFixed(4)},${z.toFixed(4)}`;
    const c = corners.get(k);
    if (c) c.ys.push(y);
    else corners.set(k, { x, z, ys: [y] });
  };
  for (const mk of mains) {
    for (const e of mainBoundary(world, mk)) {
      if (!filter(mk, e.otherMain)) continue;
      const seg = edgeSegment(world, e);
      const y = topY(hOf(e.sub)) + OUTLINE_LIFT;
      out.push({ a: { x: seg.a.x, y, z: seg.a.z }, b: { x: seg.b.x, y, z: seg.b.z } });
      addCorner(seg.a.x, seg.a.z, y);
      addCorner(seg.b.x, seg.b.z, y);
    }
  }
  for (const c of corners.values()) {
    const lo = Math.min(...c.ys);
    const hi = Math.max(...c.ys);
    if (hi - lo > 1e-6) out.push({ a: { x: c.x, y: lo, z: c.z }, b: { x: c.x, y: hi, z: c.z } });
  }
  return out;
}

const OUTLINE_LIFT = 0.03;

export function buildStrategicScene(
  game: GameState,
  ui: UiState,
  view: Team | null,
  overlay: OverlayMode = 'basic',
): SceneSpec {
  const { world, terrain } = worldOf(game);
  const hOf = heightFn(world, terrain.heights);
  const cells: CellSpec[] = world.subs.map((s) => {
    const h = terrain.heights[s.index]!;
    const owner = game.hexes[s.main]?.owner ?? null;
    const colors =
      overlay === 'height'
        ? heightColors(h)
        : overlay === 'control'
          ? controlColors(owner ? { kind: 'team', team: owner } : { kind: 'none' })
          : basicColors;
    return { key: s.key, q: s.hex.q, r: s.hex.r, h, ...colors, fort: game.forts[s.key] ?? 0 };
  });

  const allMains = world.mains.map((m) => m.key);
  const borders: BorderLayer[] = [
    {
      segments: mainOutline(world, allMains, hOf),
      color: 0xf2fbff,
      width: 2,
      opacity: 0.7,
    },
  ];
  // Territory frontiers drawn in team colour.
  for (const team of ['A', 'B'] as Team[]) {
    const owned = allMains.filter((k) => game.hexes[k]?.owner === team);
    borders.push({
      segments: mainOutline(
        world,
        owned,
        hOf,
        (_i, outer) => outer === null || game.hexes[outer]?.owner !== team,
      ),
      color: TEAM_COLOR[team],
      width: 2.6,
      opacity: 0.9,
    });
  }

  const army = ui.selectedArmy ? game.armies.find((a) => a.id === ui.selectedArmy) : null;
  if (army) {
    const moves: string[] = [];
    const attacks: string[] = [];
    for (const m of world.mains) {
      const chk = canMoveTo(game, army, m.key);
      if (chk.ok) (chk.battle ? attacks : moves).push(m.key);
    }
    borders.push({
      segments: mainOutline(world, moves, hOf, () => true),
      color: 0x66ff99,
      width: 3,
      opacity: 0.95,
    });
    borders.push({
      segments: mainOutline(world, attacks, hOf, () => true),
      color: 0xff4455,
      width: 3.5,
      opacity: 1,
    });
  }
  if (ui.selectedMain) {
    borders.push({
      segments: mainOutline(world, [ui.selectedMain], hOf, () => true),
      color: 0xffff44,
      width: 3.4,
    });
  }

  const tokens: TokenSpec[] = [];
  const tokenScale = Math.max(1.2, game.settings.grid.subRadius * 0.55);
  for (const team of ['A', 'B'] as Team[]) {
    const hq = world.mainByKey.get(game.hq[team])!;
    if (game.hexes[hq.key]?.owner === team)
      tokens.push({
        id: `hq-${team}`,
        key: hexKey(hq.center),
        kind: 'hq',
        team,
        label: `◈ ${team === 'A' ? 'ALPHA' : 'BRAVO'} HQ`,
        scale: tokenScale,
      });
  }
  const armies = view ? visibleArmies(game, view) : game.armies;
  for (const a of armies) {
    const m = world.mainByKey.get(a.at)!;
    // Offset from the centre so the HQ beacon and army token don't overlap.
    let spotHex = m.center;
    for (let i = 0; i < Math.max(1, game.settings.grid.subRadius - 1); i++)
      spotHex = neighbor(spotHex, 4);
    const spot = hexKey(spotHex);
    const hp = a.units.reduce((s, u) => s + u.hp, 0);
    const max = a.units.reduce((s, u) => s + unitType(u.typeId).hp, 0);
    tokens.push({
      id: a.id,
      key: world.subByKey.has(spot) ? spot : hexKey(m.center),
      kind: 'army',
      team: a.team,
      label: `ARMY ×${a.units.length}`,
      sub:
        a.team === game.active && a.movesLeft > 0
          ? `${a.movesLeft} move${a.movesLeft > 1 ? 's' : ''}`
          : undefined,
      hpFrac: max ? hp / max : 1,
      selected: a.id === ui.selectedArmy,
      spent: a.team === game.active && a.movesLeft === 0,
      scale: tokenScale,
    });
  }

  return {
    terrainId: `strat:${game.settings.seed}:${world.subs.length}`,
    cells,
    overlays: [],
    borders,
    tokens,
    path: [],
    trajectory: null,
    worldRotation: world.mainAxisAngle,
    fireView: null,
  };
}

export interface TacticalView {
  spec: SceneSpec;
  ctx: BattleContext;
  visible: Set<string> | null;
}

export function buildTacticalScene(
  game: GameState,
  ui: UiState,
  view: Team | null,
  overlay: OverlayMode = 'basic',
): TacticalView {
  const battle = game.battle!;
  const ctx = buildContext(game.settings, battle);
  const { world } = ctx;
  const terrain = generateTerrain(world, game.settings.seed);
  const hOf = heightFn(world, terrain.heights);
  const visible = view ? visibleCells(ctx, battle, view) : null;
  // During deployment, a player only sees their own zone + known ground.
  const cells: CellSpec[] = [...ctx.cells].map((k) => {
    const s = world.subByKey.get(k)!;
    const h = terrain.heights[s.index]!;
    const colors =
      overlay === 'height'
        ? heightColors(h)
        : overlay === 'control'
          ? controlColors(
              s.main === battle.contested
                ? { kind: 'capture' }
                : s.main === battle.origin
                  ? { kind: 'team', team: battle.attacker }
                  : { kind: 'none' },
            )
          : basicColors;
    return {
      key: k,
      q: s.hex.q,
      r: s.hex.r,
      h,
      ...colors,
      dim: visible ? !visible.has(k) && battle.phase === 'combat' : false,
      fort: battle.forts[k] ?? 0,
    };
  });

  const borders: BorderLayer[] = [
    {
      segments: mainOutline(world, battle.mains, hOf),
      color: 0xe6f7ff,
      width: 1.8,
      opacity: 0.65,
    },
    {
      segments: mainOutline(world, [battle.contested], hOf, () => true),
      color: CAPTURE_COLOR, // capture-point outline: shown in every overlay
      width: 3,
      opacity: 0.95,
    },
  ];

  const overlays: OverlaySpec[] = [];
  let path: string[] = [];
  let trajectory: SceneSpec['trajectory'] = null;
  let fireView: SceneSpec['fireView'] = null;

  if (battle.phase === 'deploy') {
    const team = battle.deployTeam;
    if (!view || view === team) {
      for (const k of deploymentZone(ctx, battle, team))
        overlays.push({ key: k, color: 0x33ff88, opacity: 0.18 });
      if (ui.placingFort)
        for (const k of warnedRangeCells(ctx, battle))
          overlays.push({ key: k, color: 0xffb020, opacity: 0.3 });
    }
  }

  const sel = ui.selectedUnit
    ? battle.units.find((u) => u.id === ui.selectedUnit && u.hp > 0 && u.pos)
    : undefined;
  if (
    battle.phase === 'combat' &&
    sel &&
    sel.team === battle.active &&
    (!view || view === sel.team)
  ) {
    const t = unitType(sel.typeId);
    if (!sel.acted && !sel.deployed) {
      const reach = reachable(ctx, sel);
      for (const [k] of reach)
        if (k !== sel.pos) overlays.push({ key: k, color: 0x3aa0ff, opacity: 0.22 });
      if (ui.hoverCell && reach.has(ui.hoverCell) && ui.hoverCell !== sel.pos)
        path = pathTo(reach, ui.hoverCell);
    }
    if (!sel.acted) {
      const targets = t.attackType === 'indirect' ? [] : visibleEnemies(ctx, battle, sel.team);
      for (const e of targets) {
        const pv = previewAttack(ctx, battle, sel, e.pos!);
        if (pv.legal) overlays.push({ key: e.pos!, color: 0xff3344, opacity: 0.45 });
      }
    }
    if (ui.hoverCell && ui.hoverCell !== sel.pos && t.attackType !== 'melee') {
      const a = parseKey(sel.pos!);
      const b = parseKey(ui.hoverCell);
      const indirect = t.attackType === 'indirect';
      const res = indirect
        ? arcClearance(a, b, ctx.heightOf, t.eye)
        : lineOfSight(a, b, ctx.heightOf, t.eye);
      const enemyThere = ctx.unitAt.get(ui.hoverCell);
      if (indirect || (enemyThere && enemyThere.team !== sel.team)) {
        trajectory = { from: sel.pos!, to: ui.hoverCell, status: res.status, indirect, eye: t.eye };
        fireView = { from: sel.pos!, to: ui.hoverCell };
      }
    }
  }

  const tokens: TokenSpec[] = [];
  const enemiesSeen = view ? new Set(visibleEnemies(ctx, battle, view).map((u) => u.id)) : null;
  for (const u of liveUnits(battle)) {
    if (view && u.team !== view) {
      if (battle.phase === 'deploy' || !enemiesSeen?.has(u.id)) continue;
    }
    tokens.push(unitToken(u, battle.active, ui.selectedUnit, battle.phase === 'combat'));
  }

  return {
    ctx,
    visible,
    spec: {
      terrainId: `battle:${battle.id}`,
      cells,
      overlays,
      borders,
      tokens,
      path,
      trajectory,
      worldRotation: world.mainAxisAngle,
      fireView,
    },
  };
}

function unitToken(
  u: BattleUnit,
  active: Team,
  selected: string | null,
  combat: boolean,
): TokenSpec {
  const t = unitType(u.typeId);
  const flags: string[] = [];
  if (u.suppressed) flags.push('SUP');
  if (u.deployed) flags.push('SET');
  return {
    id: u.id,
    key: u.pos!,
    kind: tokenKind(u.typeId),
    team: u.team,
    label: u.id === selected ? u.label : t.short,
    badge: flags.join(' ') || undefined,
    hpFrac: u.hp / u.maxHp,
    facing: u.facing,
    selected: u.id === selected,
    spent: combat && u.team === active && u.acted,
  };
}

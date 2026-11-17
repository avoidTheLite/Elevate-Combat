// Test/browser initial state for a real legal blind-fire command, not a fabricated outcome.
import type { GameState, Battle, BattleUnit } from '@iron-ridge/engine';
import type { UiState } from '../stores/useGameStore.ts';
import {
  apply,
  commitCampaignStationing,
  constructCampaignNodeRequest,
  createBattle,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  prepareCampaignStationing,
  setHolderPos,
  toggleCampaignStationing,
  worldOf,
  buildContext,
  previewAttack,
  unitType,
  validateGameState,
} from '@iron-ridge/engine';
import { createMovementDemo, movementDemoFocus } from './demoScenario.ts';
import { useGameStore } from '../stores/useGameStore.ts';

export function blindFireFixture(): {
  game: GameState;
  battle: Battle;
  shooter: BattleUnit;
  target: string;
  ui: UiState;
} {
  const game = createMovementDemo();
  game.settings.fog = true;
  const battle = game.battle!;
  const shooter = battle.units.find((u) => u.id === movementDemoFocus(game).selectedUnit)!;
  const source = game.armies
    .find((a) => a.id === shooter.holderId)!
    .units.find((u) => u.id === shooter.id)!;
  shooter.typeId = source.typeId = 'ww2_artillery';
  shooter.hp = source.hp = shooter.maxHp = unitType(shooter.typeId).hp;
  shooter.deployed = true;
  const ctx = buildContext(game.settings, battle);
  const target = [...ctx.cells].find((key) => {
    const p = previewAttack(ctx, battle, shooter, key);
    return key !== shooter.pos && !ctx.unitAt.has(key) && p.legal && p.blind;
  });
  if (!target) throw new Error('Blind-fire fixture needs an unspotted legal empty target');
  const errors = validateGameState(game);
  if (errors.length) throw new Error(errors.join('; '));
  const ui = {
    ...useGameStore.getState().ui,
    ...movementDemoFocus(game),
    selectedUnit: shooter.id,
  };
  return { game, battle, shooter, target, ui };
}

/** Prepared victory + real stationing adapters; final snapshot must pass save validation. */
export function garrisonContextFixture(
  kind: 'hq' | 'node',
  temporary = false,
): {
  game: GameState;
  center: string;
  permanentId: string;
  temporaryId: string | null;
} {
  let game = createGame({
    ...defaultSettings(),
    seed: 1,
    fog: false,
    grid: { mainCols: 3, mainRows: 3, subRadius: 3 },
    controllers: { A: 'human', B: 'human' },
    infrastructure: createFoundationPlaytestConfiguration(5, 2),
  });
  let actor = game.armies.find((a) => a.team === 'A' && a.kind === 'commander')!;
  let permanent = game.armies.find((a) => a.team === 'A' && a.building === 'hq')!;
  if (kind === 'node') {
    const site = game.infrastructure!.sites.find((s) => !s.homeTeam)!;
    setHolderPos(worldOf(game).world, actor, site.annexSubHexes[0]!);
    const request = constructCampaignNodeRequest(game, {
      kind: 'activate',
      nodeId: site.nodeId,
      commanderId: actor.id,
      centerDefinitionId: 'generic',
    });
    const result = apply(game, { type: 'nodeWork', request });
    if (result.error) throw Error(result.error);
    game = result.state;
    actor = game.armies.find((a) => a.id === actor.id)!;
    // An empty permanent roster is a valid saved state after its recruits leave.
    permanent = {
      id: `context-node-${game.nextId++}`,
      kind: 'garrison',
      building: 'node',
      nodeId: site.nodeId,
      team: 'A',
      pos: site.centerSubHex,
      at: site.mainHex,
      movesLeft: 0,
      units: [],
    };
    game.armies.push(permanent);
  }
  if (!permanent || permanent.units.length) throw Error('Fixture needs an empty permanent roster');
  let temporaryId: string | null = null;
  if (temporary) {
    const enemy = game.armies.find((a) => a.team === 'B' && a.kind === 'commander')!;
    const battle = createBattle(game, actor, enemy, actor.at, enemy.at, worldOf(game).world);
    const survivor = battle.units.find((u) => u.holderId === actor.id)!;
    survivor.pos = permanent.pos;
    battle.phase = 'over';
    battle.winner = 'A';
    battle.forts[permanent.pos] = 1;
    game.forts[permanent.pos] = 1;
    game.battle = battle;
    game.phase = 'battle';
    const prepared = prepareCampaignStationing(game, battle, []);
    if (!prepared.ok) throw Error(prepared.error);
    const selected = toggleCampaignStationing(game, survivor.id, 0);
    if (!selected.ok) throw Error(selected.error);
    const committed = commitCampaignStationing(game, 1);
    if (!committed.ok) throw Error(committed.error);
    temporaryId = game.armies.find(
      (a) => a.building === 'temporary' && a.pos === permanent.pos,
    )!.id;
    // Prepared post-resolution fixture, not a claim to exercise a complete battle.
    game.battle = null;
    game.phase = 'strategic';
  }
  const errors = validateGameState(game);
  if (errors.length) throw Error(errors.join('; '));
  return { game, center: permanent.pos, permanentId: permanent.id, temporaryId };
}

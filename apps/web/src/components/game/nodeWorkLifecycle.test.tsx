import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  campaignNodeActionChoices,
  campaignNodeViews,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  deserializeSave,
  makeUnit,
  validateGameState,
} from '@iron-ridge/engine';
import type { CampaignNodeActionChoice, GameState, Team } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { useNodePlacementStore } from '../../stores/useNodePlacementStore.ts';
import { readSlot } from '../../stores/saveSlots.ts';
import { NodePanel } from './NodePanel.tsx';

const store = (): ReturnType<typeof useGameStore.getState> => useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  act(() => {
    store().quit();
    useNodePlacementStore.getState().cancelPlacement();
  });
});

function configuredGame(engineer = false): GameState {
  const game = createGame({
    ...defaultSettings(),
    controllers: { A: 'human', B: 'human' },
    fog: false,
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
  if (engineer) {
    game.armies
      .find((army) => army.team === 'A' && army.kind === 'commander')!
      .units.push(makeUnit(game, 'A', 'ww2_engineer'));
  }
  expect(validateGameState(game)).toEqual([]);
  return game;
}

function home(game: GameState): ReturnType<typeof campaignNodeViews>[number] {
  return campaignNodeViews(game).find((node) => node.mainHex === game.hq.A)!;
}

function workshopChoices(game: GameState): CampaignNodeActionChoice[] {
  return campaignNodeActionChoices(game, home(game).nodeId).filter(
    (choice) =>
      choice.legal &&
      choice.request.kind === 'build' &&
      choice.request.definitionId === 'workshop' &&
      choice.request.tier === 1,
  );
}

function NodeHarness({
  center = false,
  canAct = true,
  view,
  inspectedCell,
}: {
  center?: boolean;
  canAct?: boolean;
  view?: Team | null;
  inspectedCell?: string | null;
}): React.ReactElement {
  const game = useGameStore((state) => state.game)!;
  return (
    <NodePanel
      game={game}
      mainHex={game.hq.A}
      inspectedCell={
        inspectedCell === undefined ? (center ? home(game).centerSubHex : null) : inspectedCell
      }
      canAct={canAct}
      view={view}
    />
  );
}

function mountNode(engineer = false): GameState {
  const game = configuredGame(engineer);
  act(() => useGameStore.setState({ game, handoff: null }));
  expect(store().saveToSlot('autosave')).toBe(true);
  render(<NodeHarness center={engineer} />);
  return game;
}

/**
 * Retain the production React handler to test a lifecycle boundary explicitly.
 * This does not claim that a removed button remains clickable in the browser.
 */
function retainConfirmation(button: HTMLElement): () => void {
  const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps$'));
  if (!propsKey) throw new Error('Expected a React button');
  const props = (button as unknown as Record<string, { onClick?: () => void }>)[propsKey];
  if (typeof props?.onClick !== 'function') throw new Error('Expected a confirmation handler');
  return props.onClick;
}

function stageBuild(game: GameState): {
  choice: CampaignNodeActionChoice;
  confirm: () => void;
} {
  const choice = workshopChoices(game)[0]!;
  if (choice.request.kind !== 'build') throw new Error('Expected a Workshop build');
  fireEvent.click(screen.getByRole('button', { name: `Build Workshop T1 ${choice.cpCost} CP` }));
  const tile = choice.request.subHex;
  act(() => expect(useNodePlacementStore.getState().selectTile(game, tile)).toBe(true));
  return {
    choice,
    confirm: retainConfirmation(
      screen.getByRole('button', { name: `Confirm build (${choice.cpCost} CP)` }),
    ),
  };
}

function stageUpgrade(game: GameState): {
  choice: CampaignNodeActionChoice;
  confirm: () => void;
} {
  const choice = campaignNodeActionChoices(game, home(game).nodeId).find(
    (candidate) => candidate.legal && candidate.request.kind === 'upgrade',
  )!;
  expect(choice).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: `${choice.label} ${choice.cpCost} CP` }));
  return {
    choice,
    confirm: retainConfirmation(
      screen.getByRole('button', { name: `Confirm order (${choice.cpCost} CP)` }),
    ),
  };
}

function expectUnchanged(game: GameState, autosave: string | null): void {
  expect(store().game!.cp).toEqual(game.cp);
  expect(store().game).toBe(game);
  expect(readSlot('autosave')).toBe(autosave);
}

function expectExactSave(game: GameState): void {
  const restored = deserializeSave(store().exportSave()!.text);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error(restored.error);
  expect(restored.save.state).toEqual(game);
  expect(validateGameState(game)).toEqual([]);
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: retained node confirmation lifecycle boundaries', () => {
  it('ignores a retained build confirmation after cancellation removes the visible order', () => {
    const game = mountNode();
    const { choice, confirm } = stageBuild(game);
    const autosave = readSlot('autosave');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel building work' }));
    expect(useNodePlacementStore.getState().plan).toBeNull();
    expect(
      screen.queryByRole('button', { name: `Confirm build (${choice.cpCost} CP)` }),
    ).toBeNull();
    expectUnchanged(game, autosave);
    act(() => confirm());
    expectUnchanged(game, autosave);
  });

  it('ignores the old location callback and preserves a replacement placement', () => {
    const game = mountNode();
    const { choice, confirm } = stageBuild(game);
    const replacementChoice = workshopChoices(game).find(
      (candidate) => JSON.stringify(candidate.request) !== JSON.stringify(choice.request),
    )!;
    if (replacementChoice.request.kind !== 'build') throw new Error('Expected another build');
    const tile = replacementChoice.request.subHex;
    act(() => expect(useNodePlacementStore.getState().selectTile(game, tile)).toBe(true));
    const replacement = useNodePlacementStore.getState().plan;
    const autosave = readSlot('autosave');
    act(() => confirm());
    expectUnchanged(game, autosave);
    expect(useNodePlacementStore.getState().plan).toBe(replacement);
  });

  it('ignores an old callback after an identical save reload even when the quote matches', () => {
    const game = mountNode();
    const { choice, confirm } = stageBuild(game);
    act(() => expect(store().importSave(store().exportSave()!.text)).toBe(true));
    const loaded = store().game!;
    expect(loaded).toEqual(game);
    expect(loaded).not.toBe(game);
    expect(workshopChoices(loaded)).toContainEqual(choice);
    // GameScreen clears transient placement on a game revision. Keep that clear
    // explicit here so this test isolates the retained confirmation boundary.
    act(() => useNodePlacementStore.getState().cancelPlacement());
    const autosave = readSlot('autosave');
    act(() => confirm());
    expectUnchanged(loaded, autosave);
  });

  it.each(['quit', 'handoff'] as const)(
    'reads a newly opened %s gate before the next render',
    (gate) => {
      const game = mountNode();
      const { confirm } = stageBuild(game);
      const autosave = readSlot('autosave');
      act(() => {
        if (gate === 'quit') store().requestQuit();
        else useGameStore.setState({ handoff: 'B' });
        confirm();
      });
      expectUnchanged(game, autosave);
    },
  );

  it('ignores a retained local upgrade confirmation after cancellation', () => {
    const game = mountNode(true);
    const { choice, confirm } = stageUpgrade(game);
    const autosave = readSlot('autosave');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel building work' }));
    expect(
      screen.queryByRole('button', { name: `Confirm order (${choice.cpCost} CP)` }),
    ).toBeNull();
    act(() => confirm());
    expectUnchanged(game, autosave);
  });

  it('ignores retained build and local upgrade confirmations after unmount', () => {
    for (const local of [false, true]) {
      const game = configuredGame(local);
      act(() => useGameStore.setState({ game, handoff: null }));
      expect(store().saveToSlot('autosave')).toBe(true);
      const mounted = render(<NodeHarness center={local} />);
      const { confirm } = local ? stageUpgrade(game) : stageBuild(game);
      const plan = useNodePlacementStore.getState().plan;
      const autosave = readSlot('autosave');

      mounted.unmount();
      act(() => confirm());

      expectUnchanged(game, autosave);
      expect(useNodePlacementStore.getState().plan).toBe(plan);
      act(() => useNodePlacementStore.getState().cancelPlacement());
    }
  });

  it('rejects a retained local confirmation when current action permission or observer changes', () => {
    const game = configuredGame(true);
    act(() => useGameStore.setState({ game, handoff: null }));
    expect(store().saveToSlot('autosave')).toBe(true);
    const mounted = render(<NodeHarness center />);
    const { confirm } = stageUpgrade(game);
    const autosave = readSlot('autosave');

    mounted.rerender(<NodeHarness center canAct={false} />);
    act(() => confirm());
    expectUnchanged(game, autosave);

    mounted.rerender(<NodeHarness center view="A" />);
    act(() => confirm());
    expectUnchanged(game, autosave);
  });

  it('does not revive a retained local quote after leaving and returning to its tile scope', () => {
    const game = configuredGame(true);
    act(() => useGameStore.setState({ game, handoff: null }));
    expect(store().saveToSlot('autosave')).toBe(true);
    const mounted = render(<NodeHarness center />);
    const { choice, confirm } = stageUpgrade(game);
    const autosave = readSlot('autosave');

    mounted.rerender(<NodeHarness inspectedCell={null} />);
    mounted.rerender(<NodeHarness center />);
    expect(
      screen.queryByRole('button', { name: `Confirm order (${choice.cpCost} CP)` }),
    ).toBeNull();
    act(() => confirm());
    expectUnchanged(game, autosave);
  });

  it('commits a current build once with its quoted CP and ordinary work, then saves exactly', () => {
    const game = mountNode();
    const { choice, confirm } = stageBuild(game);
    expect(store().game).toBe(game);
    fireEvent.click(screen.getByRole('button', { name: `Confirm build (${choice.cpCost} CP)` }));
    const next = store().game!;
    expect(next.cp).toEqual({ ...game.cp, A: game.cp.A - choice.cpCost });
    expect(home(next).buildings).toHaveLength(home(game).buildings.length + 1);
    expect(next.infrastructure!.workRequests).toEqual([choice.request]);
    const work = next.infrastructure!.capture.work;
    expect(work.nodeSpending).toEqual([
      expect.objectContaining({
        nodeId: home(game).nodeId,
        ordinarySpent: true,
        operationCount: 1,
      }),
    ]);
    expect(work.engineerSpending).toEqual(game.infrastructure!.capture.work.engineerSpending);
    expect(work.receipts).toHaveLength(1);
    expect(work.receipts[0]).toMatchObject({ allowance: 'ordinary', cpSpent: choice.cpCost });
    expect(useNodePlacementStore.getState().plan).toBeNull();
    const autosave = readSlot('autosave');
    act(() => {
      confirm();
      confirm();
    });
    expectUnchanged(next, autosave);
    expectExactSave(next);
  });

  it('commits a current upgrade once with its quoted CP and engineer action, then saves exactly', () => {
    const game = mountNode(true);
    const { choice, confirm } = stageUpgrade(game);
    if (choice.request.kind !== 'upgrade') throw new Error('Expected an upgrade');
    const { buildingId, tier, engineerUnitId } = choice.request;
    expect(store().game).toBe(game);
    fireEvent.click(screen.getByRole('button', { name: `Confirm order (${choice.cpCost} CP)` }));
    const next = store().game!;
    expect(next.cp).toEqual({ ...game.cp, A: game.cp.A - choice.cpCost });
    expect(home(next).buildings.find((building) => building.id === buildingId)?.tier).toBe(tier);
    expect(home(next).buildings).toHaveLength(home(game).buildings.length);
    expect(next.infrastructure!.workRequests).toEqual([choice.request]);
    const work = next.infrastructure!.capture.work;
    expect(work.nodeSpending).toEqual([
      expect.objectContaining({ ordinarySpent: false, operationCount: 1 }),
    ]);
    expect(work.engineerSpending).toEqual([
      expect.objectContaining({ unitId: engineerUnitId, receiptId: choice.request.requestId }),
    ]);
    expect(work.receipts).toHaveLength(1);
    expect(work.receipts[0]).toMatchObject({ allowance: 'engineer', cpSpent: choice.cpCost });
    expect(useNodePlacementStore.getState().plan).toBeNull();
    const autosave = readSlot('autosave');
    act(() => {
      confirm();
      confirm();
    });
    expectUnchanged(next, autosave);
    expectExactSave(next);
  });
});

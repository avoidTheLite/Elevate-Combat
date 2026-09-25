import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from '@iron-ridge/engine';
import { COMMAND, apply, commanderReach, unitType } from '@iron-ridge/engine';
import { useGameStore, viewTeam } from '../../stores/useGameStore.ts';
import { ContentsPanel } from './ContentsPanel.tsx';
import { StrategicSidebar } from './StrategicSidebar.tsx';
import {
  alphaGarrison,
  bravoInRange,
  commanderOf,
  strategicGame,
  withRecruits,
} from '../../lib/testGames.ts';

function load(game: GameState, selectedArmy: string | null = null): void {
  act(() => {
    useGameStore.getState().quit();
    useGameStore.setState({ game });
    useGameStore.getState().setUi({ selectedArmy });
  });
}

function Harness(): React.ReactElement {
  const game = useGameStore((s) => s.game)!;
  return <ContentsPanel game={game} view={viewTeam(game)} />;
}

const game = (): GameState => useGameStore.getState().game!;

beforeEach(() => localStorage.clear());

describe('ContentsPanel', () => {
  it('lists a commander’s units with type, label and HP bar', () => {
    const s = strategicGame(true);
    const a = commanderOf(s, 'A');
    load(s, a.id);
    render(<Harness />);
    expect(screen.getByText(/ALPHA COMMANDER/)).toBeInTheDocument();
    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(a.units.length);
    for (const u of a.units) {
      expect(screen.getByText(u.label)).toBeInTheDocument();
      expect(screen.getByLabelText(`select ${u.label}`)).toBeInTheDocument();
    }
    expect(screen.getAllByText(unitType(a.units[0]!.typeId).name, { exact: false }).length).toBe(
      a.units.filter((u) => u.typeId === a.units[0]!.typeId).length,
    );
  });

  it('transfers ticked garrison units to the commander', () => {
    const s = withRecruits(strategicGame(true), 2);
    const g = alphaGarrison(s);
    const a = commanderOf(s, 'A');
    load(s, g.id);
    render(<Harness />);
    const moving = g.units[0]!;
    fireEvent.click(screen.getByLabelText(`select ${moving.label}`));
    expect(useGameStore.getState().ui.checkedUnits).toEqual([moving.id]);
    fireEvent.click(screen.getByRole('button', { name: /transfer to/i }));
    const list = screen.getByRole('list', { name: /transfer targets/i });
    fireEvent.click(within(list).getByRole('button', { name: new RegExp(a.id) }));
    expect(alphaGarrison(game()).units.map((u) => u.id)).not.toContain(moving.id);
    expect(commanderOf(game(), 'A').units.map((u) => u.id)).toContain(moving.id);
    expect(useGameStore.getState().ui.checkedUnits).toEqual([]);
  });

  it('forms a new commander from the garrison and selects it', () => {
    const s = withRecruits(strategicGame(true), 3);
    const g = alphaGarrison(s);
    load(s, g.id);
    render(<Harness />);
    const newCmd = screen.getByRole('button', { name: /new commander/i });
    expect(newCmd).toBeDisabled(); // nothing ticked yet
    fireEvent.click(screen.getByLabelText(`select ${g.units[0]!.label}`));
    fireEvent.click(screen.getByLabelText(`select ${g.units[1]!.label}`));
    fireEvent.click(newCmd);
    const commanders = game().armies.filter((x) => x.team === 'A' && x.kind === 'commander');
    expect(commanders).toHaveLength(2);
    const made = commanders.find((x) => x.id !== commanderOf(s, 'A').id)!;
    expect(made.units.map((u) => u.id)).toEqual([g.units[0]!.id, g.units[1]!.id]);
    expect(made.at).toBe(g.at);
    expect(alphaGarrison(game()).units).toHaveLength(1);
    expect(useGameStore.getState().ui.selectedArmy).toBe(made.id);
  });

  it('explains the transfer rule when no holder is in reach', () => {
    let s = withRecruits(strategicGame(true), 1);
    const a = commanderOf(s, 'A');
    // March the commander out of the HQ's main hex.
    const away = [...commanderReach(s, a).entries()]
      .filter(([k]) => s.armies.every((x) => x.pos !== k))
      .sort((x, y) => y[1] - x[1])
      .find(([k]) => {
        const r = apply(s, { type: 'moveCommander', armyId: a.id, dest: k });
        return !r.error && commanderOf(r.state, 'A').at !== s.hq.A;
      })![0];
    s = apply(s, { type: 'moveCommander', armyId: a.id, dest: away }).state;
    load(s, alphaGarrison(s).id);
    render(<Harness />);
    const n = s.settings.grid.subRadius;
    expect(
      screen.getByText(new RegExp(`within ${n} sub-hexes and in the same main hex`)),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /transfer to/i })).toBeDisabled();
  });

  it('an enemy holder under fog shows only its unit count', () => {
    // Bravo's commander stands next to Alpha's territory, so Alpha sees it.
    const s = bravoInRange(strategicGame(true));
    const b = commanderOf(s, 'B');
    load(s, b.id);
    const { unmount } = render(<Harness />);
    expect(screen.getByTestId('contents-hidden')).toHaveTextContent(
      `${b.units.length} unit(s) — composition unknown`,
    );
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    unmount();
    // Fog off (omniscient view): the full list, but no checkboxes for the enemy.
    load({ ...s, settings: { ...s.settings, fog: false } }, b.id);
    render(<Harness />);
    expect(screen.getAllByRole('meter')).toHaveLength(b.units.length);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('Recruit panel', () => {
  it('says recruits join the HQ garrison, shows count/cap and disables at cap', () => {
    const s = withRecruits(strategicGame(true), COMMAND.garrisonCap - 1);
    load(s);
    function Sidebar(): React.ReactElement {
      const g = useGameStore((st) => st.game)!;
      return <StrategicSidebar game={g} view="A" canAct />;
    }
    render(<Sidebar />);
    expect(screen.getByText(/recruits join the hq garrison/i)).toBeInTheDocument();
    expect(screen.getByTestId('garrison-count')).toHaveTextContent(
      `${COMMAND.garrisonCap - 1}/${COMMAND.garrisonCap}`,
    );
    const rifle = screen.getByRole('button', { name: /rifle infantry/i });
    expect(rifle).toBeEnabled();
    fireEvent.click(rifle);
    expect(alphaGarrison(game()).units).toHaveLength(COMMAND.garrisonCap);
    expect(screen.getByTestId('garrison-count')).toHaveTextContent(
      `${COMMAND.garrisonCap}/${COMMAND.garrisonCap}`,
    );
    expect(screen.getByText(/garrison full/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rifle infantry/i })).toBeDisabled();
  });

  it('recruit costs reflect the running game’s rule overrides', () => {
    const s = strategicGame(true);
    s.settings.rules = { units: { ww2_rifle_infantry: { cost: 1 } } };
    load(s);
    function Sidebar(): React.ReactElement {
      const g = useGameStore((st) => st.game)!;
      return <StrategicSidebar game={g} view="A" canAct />;
    }
    const { unmount } = render(<Sidebar />);
    expect(screen.getByRole('button', { name: /rifle infantry/i })).toHaveTextContent('1');
    const cp = game().cp.A;
    fireEvent.click(screen.getByRole('button', { name: /rifle infantry/i }));
    expect(game().cp.A).toBe(cp - 1);
    unmount();
    act(() => useGameStore.getState().quit());
    // Leaving the game drops back to baseline rules for everything else.
    expect(unitType('ww2_rifle_infantry').cost).toBe(3);
  });
});

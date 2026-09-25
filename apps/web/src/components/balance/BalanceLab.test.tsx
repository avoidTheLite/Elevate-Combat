import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseUnitType, defaultSettings } from '@iron-ridge/engine';
import App from '../../App.tsx';
import { BALANCE_KEY, useBalanceStore } from '../../balance/store.ts';
import { unitThumbnail } from '../../balance/thumbnails.ts';
import { useGameStore } from '../../stores/useGameStore.ts';

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useGameStore.getState().quit();
    useBalanceStore.setState({
      view: 'setup',
      active: undefined,
      draft: {},
      dirtyCards: {},
      setup: defaultSettings(),
    });
    useBalanceStore.getState().openLab(defaultSettings());
  });
});

const tankCard = (): ReturnType<typeof within> => within(screen.getByTestId('unit-card-ww2_tank'));

describe('BalanceLab', () => {
  it('shows a card per unit with a text badge when WebGL is unavailable', async () => {
    render(<App />);
    expect(screen.getByTestId('era-grid-ww2').children.length).toBeGreaterThanOrEqual(9);
    expect(unitThumbnail('ww2_tank', 0x00f0ff)).toBeNull();
    await waitFor(() => expect(tankCard().getByTestId('thumb-fallback')).toHaveTextContent('TNK'));
  });

  it('per-card Save commits a valid override into the draft; Revert discards', () => {
    render(<App />);
    const hp = baseUnitType('ww2_tank').hp;
    const card = tankCard();
    const input = card.getByLabelText('Tank HP');
    fireEvent.change(input, { target: { value: String(hp + 4) } });
    expect(card.getByText(/unsaved edits/i)).toBeInTheDocument();
    expect(screen.getByTestId('unsaved-warning')).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'SAVE' }));
    expect(useBalanceStore.getState().draft).toEqual({ units: { ww2_tank: { hp: hp + 4 } } });
    expect(card.getByText(/modified vs baseline/i)).toBeInTheDocument();
    expect(screen.getByTestId('draft-badge')).toHaveTextContent('1 CHANGE(S) · NOT APPLIED');

    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.click(card.getByRole('button', { name: 'REVERT' }));
    expect((input as HTMLInputElement).value).toBe(String(hp + 4));
  });

  it('shows validation errors inline and does not save', () => {
    render(<App />);
    const card = tankCard();
    fireEvent.change(card.getByLabelText('Tank MIN RNG'), { target: { value: '30' } });
    fireEvent.change(card.getByLabelText('Tank MAX RNG'), { target: { value: '2' } });
    fireEvent.click(card.getByRole('button', { name: 'SAVE' }));
    expect(card.getByRole('alert')).toHaveTextContent(/minRange 30 > maxRange 2/);
    expect(useBalanceStore.getState().draft).toEqual({});

    fireEvent.change(card.getByLabelText('Tank HP'), { target: { value: '' } });
    fireEvent.click(card.getByRole('button', { name: 'SAVE' }));
    expect(card.getByRole('alert')).toHaveTextContent(/hp: must be a number/);
  });

  it('Apply all persists; Apply & new game starts a game with settings.rules', async () => {
    render(<App />);
    const card = tankCard();
    fireEvent.click(card.getByLabelText('Tank SUPPRESSES'));
    fireEvent.click(card.getByRole('button', { name: 'SAVE' }));
    fireEvent.click(screen.getByRole('button', { name: 'APPLY ALL' }));
    const want = { units: { ww2_tank: { suppresses: !baseUnitType('ww2_tank').suppresses } } };
    expect(JSON.parse(localStorage.getItem(BALANCE_KEY)!)).toEqual(want);
    expect(screen.getByTestId('applied-badge')).toHaveTextContent('1 CHANGE(S)');

    fireEvent.click(screen.getByRole('button', { name: /apply & new game/i }));
    await screen.findByRole('button', { name: /end turn/i });
    expect(useGameStore.getState().game!.settings.rules).toEqual(want);
    expect(useBalanceStore.getState().view).toBe('setup');
  });

  it('mechanics card saves scalar knobs into the draft', () => {
    render(<App />);
    const mech = within(screen.getByTestId('mechanics-card'));
    fireEvent.change(mech.getByLabelText('mechanics BLIND_FIRE_TN'), { target: { value: '3' } });
    fireEvent.change(mech.getByLabelText('mechanics BASE_TN.heavy_armor'), {
      target: { value: '8' },
    });
    fireEvent.click(mech.getByRole('button', { name: 'SAVE MECHANICS' }));
    expect(useBalanceStore.getState().draft.mechanics).toEqual({
      BLIND_FIRE_TN: 3,
      BASE_TN: { heavy_armor: 8 },
    });
  });

  it('TEST runs the selected scenarios headless and charts old vs new', async () => {
    act(() => {
      useBalanceStore.getState().saveUnit('ww2_tank', { hp: 60 });
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /all \/ none/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /ww2-tank-vs-at-gun/ }));
    fireEvent.change(screen.getByLabelText('Runs per scenario'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    const row = await screen.findByTestId('cmp-ww2-tank-vs-at-gun', {}, { timeout: 20000 });
    expect(within(row).getByTestId('target-band')).toBeInTheDocument();
    expect(within(row).getByText(/5 runs/)).toBeInTheDocument();
    expect(screen.getByTestId('pass-summary')).toHaveTextContent(/PASSES \d\/1 → \d\/1/);
  }, 30000);
});

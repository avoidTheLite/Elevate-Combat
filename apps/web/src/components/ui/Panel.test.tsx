import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Panel, PanelStack } from './Panel.tsx';
import { usePanelStore } from '../../stores/usePanelStore.ts';

// jsdom has no layout: fake it. Every open panel body is 200px tall, headers 30px,
// and the stack viewport is `viewport` px high.
const BODY = 200;
const HEADER = 30;
let viewport = 700;
const originals: Record<string, PropertyDescriptor | undefined> = {};

function fakeLayout(): void {
  for (const prop of ['offsetHeight', 'scrollHeight', 'clientHeight'] as const) {
    originals[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-panel-body') ? BODY : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset.testid !== 'panel-stack') return 0;
      const panels = this.querySelectorAll('[data-panel-id]').length;
      const bodies = this.querySelectorAll('[data-panel-body]').length;
      return panels * HEADER + bodies * BODY;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'panel-stack' ? viewport : 0;
    },
  });
}

function Stack(): React.ReactElement {
  return (
    <PanelStack priority={['battle', 'battle-log', 'orders', 'unit']}>
      <Panel id="battle" title="BATTLE">
        <p>battle body</p>
      </Panel>
      <Panel id="unit" title="UNIT">
        <p>unit body</p>
      </Panel>
      <Panel id="orders" title="ORDERS">
        <p>orders body</p>
      </Panel>
      <Panel id="battle-log" title="LOG">
        <p>log body</p>
      </Panel>
    </PanelStack>
  );
}

const collapsed = (): Record<string, boolean> => usePanelStore.getState().collapsed;

beforeEach(() => {
  localStorage.clear();
  usePanelStore.setState({ collapsed: {}, autoCollapse: true });
  fakeLayout();
});

afterEach(() => {
  for (const [prop, desc] of Object.entries(originals)) {
    if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
  }
});

describe('PanelStack', () => {
  it('collapse button hides and shows a panel body', () => {
    render(<Stack />);
    fireEvent.click(screen.getByRole('button', { name: /collapse unit/i }));
    expect(screen.queryByText('unit body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /expand unit/i }));
    expect(screen.getByText('unit body')).toBeInTheDocument();
  });

  it('expanding a panel that overflows folds battle info first', () => {
    // Log already folded. Reopening the unit panel gives 4×30 + 3×200 = 720 px > 700 px.
    viewport = 700;
    act(() => usePanelStore.setState({ collapsed: { unit: true, 'battle-log': true } }));
    render(<Stack />);
    fireEvent.click(screen.getByRole('button', { name: /expand unit/i }));
    // Folding 'battle' (first in priority) frees 200 px, which is enough — orders stays open.
    expect(collapsed().battle).toBe(true);
    expect(collapsed().orders).toBeFalsy();
    expect(collapsed().unit).toBe(false);
  });

  it('folds in priority order battle → log → orders, never the one just opened', () => {
    viewport = 300; // room for headers + one body only
    act(() =>
      usePanelStore.setState({
        collapsed: { battle: false, 'battle-log': false, orders: false, unit: true },
      }),
    );
    render(<Stack />);
    fireEvent.click(screen.getByRole('button', { name: /expand unit/i }));
    expect(collapsed()).toMatchObject({
      battle: true,
      'battle-log': true,
      orders: true,
      unit: false,
    });
  });

  it('with AUTO-FOLD off, expanding never folds other panels (stack scrolls instead)', () => {
    viewport = 300;
    act(() => usePanelStore.setState({ collapsed: { unit: true }, autoCollapse: false }));
    render(<Stack />);
    fireEvent.click(screen.getByRole('button', { name: /expand unit/i }));
    expect(collapsed()).toMatchObject({ unit: false });
    expect(collapsed().battle).toBeFalsy();
    expect(screen.getByTestId('panel-stack').className).toMatch(/overflow-y-auto/);
  });
});

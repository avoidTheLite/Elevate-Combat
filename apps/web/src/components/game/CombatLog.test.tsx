import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CombatLog } from './CombatLog.tsx';

describe('CombatLog', () => {
  it('shows empty state when no log entries', () => {
    render(<CombatLog log={[]} />);
    expect(screen.getByText('No engagements yet.')).toBeInTheDocument();
  });

  it('renders log entries', () => {
    const log = ['--- Turn: 1 | TK-1 → TK-1 ---', 'DIRECT HIT', 'After armor (6): 2 damage'];
    render(<CombatLog log={log} />);
    expect(screen.getByText('DIRECT HIT')).toBeInTheDocument();
    expect(screen.getByText('After armor (6): 2 damage')).toBeInTheDocument();
  });
});

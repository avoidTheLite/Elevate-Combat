import { BalanceLab } from './components/balance/BalanceLab.tsx';
import { GameScreen } from './components/screens/GameScreen.tsx';
import { SetupScreen } from './components/screens/SetupScreen.tsx';
import { useBalanceStore } from './balance/store.ts';
import { useGameStore } from './stores/useGameStore.ts';

export default function App(): React.ReactElement {
  const hasGame = useGameStore((s) => s.game !== null);
  const view = useBalanceStore((s) => s.view);
  if (hasGame) return <GameScreen />;
  return view === 'lab' ? <BalanceLab /> : <SetupScreen />;
}

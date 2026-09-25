import { GameScreen } from './components/screens/GameScreen.tsx';
import { SetupScreen } from './components/screens/SetupScreen.tsx';
import { useGameStore } from './stores/useGameStore.ts';

export default function App(): React.ReactElement {
  const hasGame = useGameStore((s) => s.game !== null);
  return hasGame ? <GameScreen /> : <SetupScreen />;
}

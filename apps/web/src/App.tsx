import { useEffect, useState } from 'react';
import { BalanceLab } from './components/balance/BalanceLab.tsx';
import PlayerSettings from './components/game/PlayerSettings.tsx';
import { GameScreen } from './components/screens/GameScreen.tsx';
import { HomeScreen } from './components/screens/HomeScreen.tsx';
import type { HomeDestination } from './components/screens/HomeScreen.tsx';
import { ScenarioScreen } from './components/screens/ScenarioScreen.tsx';
import { SetupScreen } from './components/screens/SetupScreen.tsx';
import { LoadList } from './components/screens/LoadList.tsx';
import { Button } from './components/ui/Button.tsx';
import { useBalanceStore } from './balance/store.ts';
import { useGameStore } from './stores/useGameStore.ts';

export default function App(): React.ReactElement {
  const hasGame = useGameStore((s) => s.game !== null);
  useGameStore((s) => s.saveRev);
  const view = useBalanceStore((s) => s.view);
  const [destination, setDestination] = useState<HomeDestination | 'home'>('home');
  useEffect(() => {
    if (hasGame) setDestination('home');
  }, [hasGame]);
  if (hasGame) return <GameScreen />;
  if (view === 'lab') return <BalanceLab />;
  if (destination === 'create') return <SetupScreen onHome={() => setDestination('home')} />;
  if (destination === 'scenario') return <ScenarioScreen onHome={() => setDestination('home')} />;
  if (destination === 'settings') return <PlayerSettings onClose={() => setDestination('home')} />;
  if (destination === 'resume')
    return (
      <div className="min-h-screen flex flex-col items-center gap-5 p-4 py-8 scanlines">
        <header className="w-full max-w-[560px] flex justify-between items-center gap-3">
          <h1 className="text-xl tracking-widest text-glow">RESUME GAME</h1>
          <Button variant="ghost" onClick={() => setDestination('home')}>
            ← HOME
          </Button>
        </header>
        {useGameStore.getState().hasSave() && (
          <Button onClick={() => useGameStore.getState().loadSaved()}>CONTINUE</Button>
        )}
        <LoadList />
      </div>
    );
  return <HomeScreen onNavigate={setDestination} />;
}

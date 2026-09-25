import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as engine from '@iron-ridge/engine';
import './index.css';
import App from './App.tsx';
import { useGameStore } from './stores/useGameStore.ts';

// Dev-only hook for automated smoke tests and console debugging.
if (import.meta.env.DEV) {
  (window as unknown as { __ironRidge: unknown }).__ironRidge = { store: useGameStore, engine };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

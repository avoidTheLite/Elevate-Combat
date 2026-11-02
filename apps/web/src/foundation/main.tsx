import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { FoundationPreview } from './FoundationPreview.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FoundationPreview />
  </StrictMode>,
);

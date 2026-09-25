// Starts a headless comparison in a Web Worker (main thread fallback when
// Workers are unavailable, e.g. jsdom). Returns a cancel handle.

import type { CompareMessage, CompareRequest } from './compare.ts';
import { runComparison } from './compare.ts';

export interface ComparisonJob {
  cancel: () => void;
}

export function startComparison(
  req: CompareRequest,
  onMessage: (m: CompareMessage) => void,
): ComparisonJob {
  if (typeof Worker !== 'undefined') {
    const worker = new Worker(new URL('./balance.worker.ts', import.meta.url), { type: 'module' });
    let finished = false;
    worker.onmessage = (e: MessageEvent<CompareMessage>) => {
      if (e.data.id !== req.id) return;
      if (e.data.type === 'done' || e.data.type === 'error') {
        finished = true;
        worker.terminate();
      }
      onMessage(e.data);
    };
    worker.onerror = (e) => {
      if (finished) return;
      finished = true;
      worker.terminate();
      onMessage({ type: 'error', id: req.id, message: e.message || 'Worker failed' });
    };
    worker.postMessage(req);
    return {
      cancel: () => {
        finished = true;
        worker.terminate();
      },
    };
  }
  // Fallback: run on the main thread after the current frame.
  let cancelled = false;
  const t = setTimeout(() => {
    try {
      runComparison(req, (m) => {
        if (!cancelled) onMessage(m);
      });
    } catch (err) {
      if (!cancelled)
        onMessage({
          type: 'error',
          id: req.id,
          message: err instanceof Error ? err.message : String(err),
        });
    }
  }, 0);
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(t);
    },
  };
}

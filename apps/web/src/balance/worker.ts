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
    let worker: Worker | null = null;
    let finished = false;
    const stop = (): void => {
      finished = true;
      worker?.terminate();
    };
    try {
      worker = new Worker(new URL('./balance.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<CompareMessage>) => {
        if (finished || e.data.id !== req.id) return;
        if (e.data.type === 'done' || e.data.type === 'error') stop();
        onMessage(e.data);
      };
      worker.onerror = (e) => {
        e.preventDefault();
        if (finished) return;
        stop();
        onMessage({ type: 'error', id: req.id, message: e.message || 'Worker failed' });
      };
      worker.onmessageerror = () => {
        if (finished) return;
        stop();
        onMessage({ type: 'error', id: req.id, message: 'Worker response could not be read' });
      };
      worker.postMessage(req);
    } catch (error) {
      stop();
      onMessage({
        type: 'error',
        id: req.id,
        message: error instanceof Error ? error.message : 'Worker could not start',
      });
    }
    return {
      cancel: () => {
        if (!finished) stop();
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

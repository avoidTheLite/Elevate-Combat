// Balance-lab Web Worker: runs micro battles headless (no rendering) so the UI
// stays responsive. Protocol: see CompareRequest / CompareMessage in compare.ts.

import type { CompareMessage, CompareRequest } from './compare.ts';
import { runComparison } from './compare.ts';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<CompareRequest>) => void) | null;
  postMessage: (m: CompareMessage) => void;
};

ctx.onmessage = (e) => {
  const req = e.data;
  if (req?.type !== 'run') return;
  try {
    runComparison(req, (m) => ctx.postMessage(m));
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

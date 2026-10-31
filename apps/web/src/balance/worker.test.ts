import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompareMessage, CompareRequest } from './compare.ts';
import { startComparison } from './worker.ts';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<CompareMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
}
const request: CompareRequest = { type: 'run', id: 7, scenarios: ['ww2-tank-vs-at-gun'], runs: 5 };
afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe('comparison worker lifecycle', () => {
  it('cancels without forwarding queued messages or errors and terminates once', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const messages: CompareMessage[] = [];
    const job = startComparison(request, (message) => messages.push(message));
    const worker = FakeWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledWith(request);
    worker.onmessage?.(
      new MessageEvent<CompareMessage>('message', {
        data: { type: 'start', id: 7, total: 1, current: 'ww2-tank-vs-at-gun' },
      }),
    );
    job.cancel();
    job.cancel();
    worker.onmessage?.(
      new MessageEvent<CompareMessage>('message', {
        data: { type: 'done', id: 7, results: [], ms: 1 },
      }),
    );
    worker.onerror?.(new ErrorEvent('error', { message: 'late failure', cancelable: true }));
    expect(messages.map((message) => message.type)).toEqual(['start']);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('ignores foreign job ids and surfaces a real worker error once', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const messages: CompareMessage[] = [];
    startComparison(request, (message) => messages.push(message));
    const worker = FakeWorker.instances[0]!;
    worker.onmessage?.(
      new MessageEvent<CompareMessage>('message', {
        data: { type: 'done', id: 8, results: [], ms: 1 },
      }),
    );
    const error = new ErrorEvent('error', { message: 'loading failed', cancelable: true });
    worker.onerror?.(error);
    expect(error.defaultPrevented).toBe(true);
    worker.onmessage?.(
      new MessageEvent<CompareMessage>('message', {
        data: { type: 'done', id: 7, results: [], ms: 1 },
      }),
    );
    expect(messages).toEqual([{ type: 'error', id: 7, message: 'loading failed' }]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('turns constructor failures and unreadable messages into explicit errors', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('construction failed');
        }
      },
    );
    const messages: CompareMessage[] = [];
    startComparison(request, (message) => messages.push(message));
    expect(messages).toEqual([{ type: 'error', id: 7, message: 'construction failed' }]);
    vi.stubGlobal('Worker', FakeWorker);
    messages.length = 0;
    startComparison(request, (message) => messages.push(message));
    FakeWorker.instances[0]!.onmessageerror?.();
    expect(messages).toEqual([
      { type: 'error', id: 7, message: 'Worker response could not be read' },
    ]);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });
});

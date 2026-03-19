import { describe, it, expect } from 'vitest';
import { DAGExecutor } from '../src/executor.js';
import { MockProvider } from '../src/providers/base.js';
import type { Workflow, ExecutionEvent } from '../src/types.js';

describe('Streaming', () => {
  it('emits node:stream events for agent nodes', async () => {
    const mockProvider = new MockProvider(() => 'Hello beautiful world');
    const providers = new Map([['openai', mockProvider as any]]);

    const workflow: Workflow = {
      id: 'stream-test',
      name: 'Stream Test',
      nodes: [
        { id: 'in', type: 'input', position: { x: 0, y: 0 }, config: { name: 'In' } },
        { id: 'agent', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'Worker', model: 'gpt-5.4' } },
        { id: 'out', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Out' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'agent' },
        { id: 'e2', source: 'agent', target: 'out' },
      ],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const events: ExecutionEvent[] = [];
    const executor = new DAGExecutor({
      providers,
      streaming: true, // Enable streaming
      onEvent: (e) => events.push(e),
    });

    const run = await executor.execute(workflow, 'test input');

    expect(run.status).toBe('completed');

    // Should have stream events (MockProvider.chatStream yields word-by-word)
    const streamEvents = events.filter(e => e.type === 'node:stream');
    expect(streamEvents.length).toBeGreaterThan(0);

    // Last stream event should have done: true
    const lastStream = streamEvents[streamEvents.length - 1];
    expect((lastStream.data as any).done).toBe(true);

    // All stream events should have the agent nodeId
    expect(streamEvents.every(e => e.nodeId === 'agent')).toBe(true);

    // The final output should be the full content
    expect(run.nodeStates['agent'].output).toBe('Hello beautiful world');
  });

  it('skips streaming when executor streaming is disabled', async () => {
    const mockProvider = new MockProvider(() => 'No stream');
    const providers = new Map([['openai', mockProvider as any]]);

    const workflow: Workflow = {
      id: 'no-stream',
      name: 'No Stream',
      nodes: [
        { id: 'in', type: 'input', position: { x: 0, y: 0 }, config: { name: 'In' } },
        { id: 'agent', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'Worker', model: 'gpt-5.4' } },
        { id: 'out', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Out' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'agent' },
        { id: 'e2', source: 'agent', target: 'out' },
      ],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const events: ExecutionEvent[] = [];
    const executor = new DAGExecutor({
      providers,
      streaming: false, // Streaming disabled at executor level
      onEvent: (e) => events.push(e),
    });

    const run = await executor.execute(workflow, 'test');

    expect(run.status).toBe('completed');

    // Should NOT have stream events since streaming is disabled
    const streamEvents = events.filter(e => e.type === 'node:stream');
    expect(streamEvents.length).toBe(0);
  });
});

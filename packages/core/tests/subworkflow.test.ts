import { describe, it, expect } from 'vitest';
import { DAGExecutor } from '../src/executor.js';
import { MockProvider } from '../src/providers/base.js';
import type { Workflow, ExecutionEvent } from '../src/types.js';

describe('Subworkflow Node', () => {
  const mockProvider = new MockProvider((req) => {
    const msg = req.messages.at(-1)?.content ?? '';
    return `Processed: ${msg.slice(0, 50)}`;
  });

  const providers = new Map([['openai', mockProvider], ['mock', mockProvider]]);

  it('executes a nested workflow and returns output node result', async () => {
    const innerWorkflow: Workflow = {
      id: 'inner-1',
      name: 'Inner Pipeline',
      nodes: [
        { id: 'in', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'agent', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'Worker', model: 'gpt-5.4', systemPrompt: 'Process this.' } },
        { id: 'out', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'agent' },
        { id: 'e2', source: 'agent', target: 'out' },
      ],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const outerWorkflow: Workflow = {
      id: 'outer-1',
      name: 'Outer Pipeline',
      nodes: [
        { id: 'input-1', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'sub-1', type: 'subworkflow', position: { x: 200, y: 0 }, config: { name: 'Sub Task', subWorkflow: innerWorkflow } },
        { id: 'output-1', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input-1', target: 'sub-1' },
        { id: 'e2', source: 'sub-1', target: 'output-1' },
      ],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const executor = new DAGExecutor({ providers });
    const run = await executor.execute(outerWorkflow, 'hello world');

    expect(run.status).toBe('completed');
    expect(run.nodeStates['sub-1'].status).toBe('completed');

    // Subworkflow output should contain the processed result
    const output = run.nodeStates['sub-1'].output as string;
    expect(output).toContain('Processed');

    // Token usage should be aggregated from child
    expect(run.nodeStates['sub-1'].tokenUsage).toBeDefined();
  });

  it('emits prefixed events for child nodes', async () => {
    const innerWorkflow: Workflow = {
      id: 'inner-2',
      name: 'Inner',
      nodes: [
        { id: 'in', type: 'input', position: { x: 0, y: 0 }, config: { name: 'In' } },
        { id: 'out', type: 'output', position: { x: 200, y: 0 }, config: { name: 'Out' } },
      ],
      edges: [{ id: 'e1', source: 'in', target: 'out' }],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const outerWorkflow: Workflow = {
      id: 'outer-2',
      name: 'Outer',
      nodes: [
        { id: 'input-1', type: 'input', position: { x: 0, y: 0 }, config: { name: 'In' } },
        { id: 'sub-1', type: 'subworkflow', position: { x: 200, y: 0 }, config: { name: 'Sub', subWorkflow: innerWorkflow } },
        { id: 'output-1', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Out' } },
      ],
      edges: [
        { id: 'e1', source: 'input-1', target: 'sub-1' },
        { id: 'e2', source: 'sub-1', target: 'output-1' },
      ],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const events: ExecutionEvent[] = [];
    const executor = new DAGExecutor({
      providers,
      onEvent: (e) => events.push(e),
    });

    await executor.execute(outerWorkflow, 'test');

    // Should have child events with prefixed nodeIds like "sub-1/in"
    const childEvents = events.filter(e => e.nodeId?.startsWith('sub-1/'));
    expect(childEvents.length).toBeGreaterThan(0);
  });

  it('propagates failure from child workflow', async () => {
    const failProvider = new MockProvider(() => { throw new Error('API fail'); });

    const innerWorkflow: Workflow = {
      id: 'inner-fail',
      name: 'Failing Inner',
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

    const outerWorkflow: Workflow = {
      id: 'outer-fail',
      name: 'Outer',
      nodes: [
        { id: 'input-1', type: 'input', position: { x: 0, y: 0 }, config: { name: 'In' } },
        { id: 'sub-1', type: 'subworkflow', position: { x: 200, y: 0 }, config: { name: 'Sub', subWorkflow: innerWorkflow } },
        { id: 'output-1', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Out' } },
      ],
      edges: [
        { id: 'e1', source: 'input-1', target: 'sub-1' },
        { id: 'e2', source: 'sub-1', target: 'output-1' },
      ],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const executor = new DAGExecutor({ providers: new Map([['openai', failProvider]]) });
    const run = await executor.execute(outerWorkflow, 'test');

    expect(run.status).toBe('failed');
    expect(run.nodeStates['sub-1'].status).toBe('failed');
    expect(run.nodeStates['sub-1'].error).toContain('Subworkflow failed');
  });
});

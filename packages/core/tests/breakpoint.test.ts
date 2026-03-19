import { describe, it, expect } from 'vitest';
import { DAGExecutor, BreakpointPauseError, summarizeRun } from '../src/executor.js';
import { MockProvider } from '../src/providers/base.js';
import type { Workflow, ExecutionEvent } from '../src/types.js';

describe('Breakpoint Debugging', () => {
  const mockProvider = new MockProvider((req) => {
    const msg = req.messages.at(-1)?.content ?? '';
    return `Processed: ${msg.slice(0, 30)}`;
  });
  const providers = new Map([['openai', mockProvider], ['mock', mockProvider]]);

  const workflow: Workflow = {
    id: 'bp-test',
    name: 'Breakpoint Test',
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, config: { name: 'In' } },
      { id: 'agent1', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'Agent 1', model: 'gpt-5.4' } },
      { id: 'agent2', type: 'agent', position: { x: 400, y: 0 }, config: { name: 'Agent 2', model: 'gpt-5.4' } },
      { id: 'out', type: 'output', position: { x: 600, y: 0 }, config: { name: 'Out' } },
    ],
    edges: [
      { id: 'e1', source: 'in', target: 'agent1' },
      { id: 'e2', source: 'agent1', target: 'agent2' },
      { id: 'e3', source: 'agent2', target: 'out' },
    ],
    metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
  };

  it('pauses at a breakpoint and emits node:breakpoint event', async () => {
    const events: ExecutionEvent[] = [];
    const executor = new DAGExecutor({
      providers,
      breakpoints: new Set(['agent2']),
      onEvent: (e) => events.push(e),
    });

    const run = await executor.execute(workflow, 'hello');

    expect(run.status).toBe('paused');
    expect(run.nodeStates['agent1'].status).toBe('completed');
    expect(run.nodeStates['agent2'].status).toBe('breakpoint');
    expect(run.nodeStates['agent2'].breakpointData).toBeDefined();
    expect(run.nodeStates['agent2'].breakpointData!.input).toContain('Processed');
    expect(run.breakpoints).toContain('agent2');

    // Should have emitted a breakpoint event
    const bpEvents = events.filter(e => e.type === 'node:breakpoint');
    expect(bpEvents.length).toBe(1);
    expect(bpEvents[0].nodeId).toBe('agent2');
  });

  it('resumes from breakpoint and completes execution', async () => {
    const executor = new DAGExecutor({
      providers,
      breakpoints: new Set(['agent2']),
    });

    const run = await executor.execute(workflow, 'hello');
    expect(run.status).toBe('paused');

    // Resume
    const resumed = await executor.resumeBreakpoint(workflow, run, 'agent2');
    expect(resumed.status).toBe('completed');
    expect(resumed.nodeStates['agent2'].status).toBe('completed');
    expect(resumed.nodeStates['out'].status).toBe('completed');
  });

  it('resumes from breakpoint with modified input', async () => {
    const executor = new DAGExecutor({
      providers,
      breakpoints: new Set(['agent2']),
    });

    const run = await executor.execute(workflow, 'hello');
    expect(run.status).toBe('paused');

    // Resume with modified input
    const resumed = await executor.resumeBreakpoint(workflow, run, 'agent2', 'INJECTED DATA');
    expect(resumed.status).toBe('completed');
    expect(resumed.nodeStates['agent2'].output).toContain('INJECTED DATA');
  });

  it('addBreakpoint/removeBreakpoint work dynamically', () => {
    const executor = new DAGExecutor({ providers });
    expect(executor.getBreakpoints()).toEqual([]);

    executor.addBreakpoint('node1');
    executor.addBreakpoint('node2');
    expect(executor.getBreakpoints()).toEqual(['node1', 'node2']);

    executor.removeBreakpoint('node1');
    expect(executor.getBreakpoints()).toEqual(['node2']);
  });
});

describe('Run Summary', () => {
  it('summarizes a run correctly', async () => {
    const mockProvider = new MockProvider(() => 'done');
    const providers = new Map([['openai', mockProvider]]);

    const workflow: Workflow = {
      id: 'sum-test',
      name: 'Summary Test Workflow',
      nodes: [
        { id: 'in', type: 'input', position: { x: 0, y: 0 }, config: { name: 'In' } },
        { id: 'a1', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'A1', model: 'gpt-5.4' } },
        { id: 'out', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Out' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'a1' },
        { id: 'e2', source: 'a1', target: 'out' },
      ],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const executor = new DAGExecutor({ providers });
    const run = await executor.execute(workflow, 'test');

    const summary = summarizeRun(run, 'Summary Test Workflow');
    expect(summary.workflowName).toBe('Summary Test Workflow');
    expect(summary.status).toBe('completed');
    expect(summary.nodeCount).toBe(3);
    expect(summary.nodeSummary.completed).toBe(3);
    expect(summary.nodeSummary.failed).toBe(0);
    expect(summary.totalTokenUsage).toBeDefined();
    expect(summary.cost).toBeDefined();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { DAGExecutor, HumanPauseError } from '../src/executor.js';
import type { Workflow, ExecutionEvent, HumanApproval } from '../src/types.js';
import { MockProvider } from '../src/providers/base.js';

describe('Human-in-the-loop', () => {
  const mockProvider = new MockProvider();

  it('should pause execution at human node', async () => {
    const workflow: Workflow = {
      id: 'test-human',
      name: 'Human Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'human', type: 'human', position: { x: 1, y: 0 }, config: { name: 'Review', systemPrompt: 'Please review this' } },
        { id: 'output', type: 'output', position: { x: 2, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'human' },
        { id: 'e2', source: 'human', target: 'output' },
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const events: ExecutionEvent[] = [];
    const executor = new DAGExecutor({
      providers: new Map([['openai', mockProvider]]),
      onEvent: (e) => events.push(e),
    });

    const run = await executor.execute(workflow, { data: 'test' });

    expect(run.status).toBe('paused');
    expect(run.pausedNodes).toContain('human');
    expect(run.nodeStates['human'].status).toBe('paused');
    expect(run.nodeStates['human'].approval?.status).toBe('pending');
    expect(run.nodeStates['input'].status).toBe('completed');
    expect(run.nodeStates['output'].status).toBe('waiting');

    // Check paused event was emitted
    const pausedEvent = events.find(e => e.type === 'node:paused' as any);
    expect(pausedEvent).toBeDefined();
    expect(pausedEvent?.nodeId).toBe('human');
  });

  it('should resume after approval', async () => {
    const workflow: Workflow = {
      id: 'test-resume',
      name: 'Resume Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'human', type: 'human', position: { x: 1, y: 0 }, config: { name: 'Review' } },
        { id: 'output', type: 'output', position: { x: 2, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'human' },
        { id: 'e2', source: 'human', target: 'output' },
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const executor = new DAGExecutor({
      providers: new Map([['openai', mockProvider]]),
    });

    // First execution pauses
    const pausedRun = await executor.execute(workflow, { data: 'test' });
    expect(pausedRun.status).toBe('paused');

    // Resume with approval
    const approval: HumanApproval = {
      status: 'approved',
      data: { approved: true, note: 'LGTM' },
      approvedBy: 'user@example.com',
      approvedAt: new Date().toISOString(),
    };

    const resumedRun = await executor.resume(workflow, pausedRun, 'human', approval);

    expect(resumedRun.status).toBe('completed');
    expect(resumedRun.nodeStates['human'].status).toBe('completed');
    expect(resumedRun.nodeStates['human'].approval?.status).toBe('approved');
    expect(resumedRun.nodeStates['output'].status).toBe('completed');
  });

  it('should fail downstream when rejected', async () => {
    const workflow: Workflow = {
      id: 'test-reject',
      name: 'Reject Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'human', type: 'human', position: { x: 1, y: 0 }, config: { name: 'Review' } },
        { id: 'output', type: 'output', position: { x: 2, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'human' },
        { id: 'e2', source: 'human', target: 'output' },
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const executor = new DAGExecutor({
      providers: new Map([['openai', mockProvider]]),
    });

    const pausedRun = await executor.execute(workflow, { data: 'test' });

    const rejection: HumanApproval = {
      status: 'rejected',
      comment: 'Not good enough',
      approvedAt: new Date().toISOString(),
    };

    const rejectedRun = await executor.resume(workflow, pausedRun, 'human', rejection);

    expect(rejectedRun.nodeStates['human'].status).toBe('failed');
    expect(rejectedRun.nodeStates['human'].error).toContain('Rejected');
    // Output should be skipped since human failed
    expect(rejectedRun.nodeStates['output'].status).toBe('waiting'); // or skipped
  });

  it('should handle multiple sequential human nodes', async () => {
    const workflow: Workflow = {
      id: 'test-multi-human',
      name: 'Multi Human Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'human1', type: 'human', position: { x: 1, y: 0 }, config: { name: 'Review 1' } },
        { id: 'human2', type: 'human', position: { x: 2, y: 0 }, config: { name: 'Review 2' } },
        { id: 'output', type: 'output', position: { x: 3, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'human1' },
        { id: 'e2', source: 'human1', target: 'human2' },
        { id: 'e3', source: 'human2', target: 'output' },
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const executor = new DAGExecutor({
      providers: new Map([['openai', mockProvider]]),
    });

    // First pause at human1
    let run = await executor.execute(workflow, { data: 'test' });
    expect(run.status).toBe('paused');
    expect(run.pausedNodes).toContain('human1');

    // Approve human1 -> pauses at human2
    run = await executor.resume(workflow, run, 'human1', {
      status: 'approved',
      approvedAt: new Date().toISOString(),
    });
    expect(run.status).toBe('paused');
    expect(run.pausedNodes).toContain('human2');

    // Approve human2 -> completes
    run = await executor.resume(workflow, run, 'human2', {
      status: 'approved',
      approvedAt: new Date().toISOString(),
    });
    expect(run.status).toBe('completed');
  });
});

describe('Loop node', () => {
  const mockProvider = new MockProvider();

  it('should iterate up to maxIterations', async () => {
    const workflow: Workflow = {
      id: 'test-loop',
      name: 'Loop Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'loop', type: 'loop', position: { x: 1, y: 0 }, config: { name: 'Loop', maxIterations: 3 } },
        { id: 'output', type: 'output', position: { x: 2, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'loop' },
        { id: 'e2', source: 'loop', target: 'output' },
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const events: ExecutionEvent[] = [];
    const executor = new DAGExecutor({
      providers: new Map([['openai', mockProvider]]),
      onEvent: (e) => events.push(e),
    });

    const run = await executor.execute(workflow, { count: 0 });

    expect(run.status).toBe('completed');
    expect(run.nodeStates['loop'].status).toBe('completed');
    
    // Check iteration events
    const iterEvents = events.filter(e => e.type === 'node:iteration' as any && e.nodeId === 'loop');
    expect(iterEvents.length).toBe(3);
  });

  it('should emit iteration events', async () => {
    const workflow: Workflow = {
      id: 'test-loop-events',
      name: 'Loop Events Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'loop', type: 'loop', position: { x: 1, y: 0 }, config: { name: 'Loop', maxIterations: 2 } },
        { id: 'output', type: 'output', position: { x: 2, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'loop' },
        { id: 'e2', source: 'loop', target: 'output' },
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const events: ExecutionEvent[] = [];
    const executor = new DAGExecutor({
      providers: new Map([['openai', mockProvider]]),
      onEvent: (e) => events.push(e),
    });

    await executor.execute(workflow, {});

    const iterEvents = events.filter(e => e.type === 'node:iteration' as any);
    expect(iterEvents.length).toBe(2);
    expect((iterEvents[0].data as any).iteration).toBe(0);
    expect((iterEvents[1].data as any).iteration).toBe(1);
  });
});

describe('Variables', () => {
  it('should support global variables in templates', async () => {
    const workflow: Workflow = {
      id: 'test-vars',
      name: 'Variables Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'agent', type: 'agent', position: { x: 1, y: 0 }, config: { 
          name: 'Agent',
          model: 'gpt-5.4',
          inputTemplate: 'Process this with setting: {{$setting}}'
        } },
        { id: 'output', type: 'output', position: { x: 2, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'agent' },
        { id: 'e2', source: 'agent', target: 'output' },
      ],
      variables: { setting: 'strict' },
      metadata: { created: '', updated: '', version: '1' },
    };

    const mockProvider = new MockProvider();
    const executor = new DAGExecutor({
      providers: new Map([['openai', mockProvider]]),
    });

    const run = await executor.execute(workflow, { data: 'test' });

    expect(run.status).toBe('completed');
    expect(run.variables).toEqual({ setting: 'strict' });
  });
});

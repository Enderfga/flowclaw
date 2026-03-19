import { describe, it, expect } from 'vitest';
import { DAGExecutor } from '../src/executor.js';
import type { Workflow, DAGNode, DAGEdge, AgentProvider, ExecutionEvent } from '../src/types.js';

function makeNode(id: string, type: DAGNode['type'] = 'agent', config: Partial<DAGNode['config']> = {}): DAGNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    config: { name: id, ...config },
  };
}

function makeEdge(source: string, target: string): DAGEdge {
  return { id: `${source}->${target}`, source, target };
}

function makeWorkflow(nodes: DAGNode[], edges: DAGEdge[]): Workflow {
  return {
    id: 'test-wf',
    name: 'Test',
    nodes,
    edges,
    metadata: { created: '', updated: '', version: '1' },
  };
}

const mockProvider: AgentProvider = {
  name: 'mock',
  async chat(req) {
    return {
      content: `[mock response to: ${req.messages[req.messages.length - 1].content.slice(0, 50)}]`,
      tokenUsage: { prompt: 10, completion: 20 },
      model: req.model,
    };
  },
};

describe('DAGExecutor', () => {
  it('executes a simple linear workflow (input → output)', async () => {
    const wf = makeWorkflow(
      [makeNode('in', 'input'), makeNode('out', 'output')],
      [makeEdge('in', 'out')]
    );
    const executor = new DAGExecutor();
    const run = await executor.execute(wf, 'hello world');

    expect(run.status).toBe('completed');
    expect(run.nodeStates['in'].status).toBe('completed');
    expect(run.nodeStates['in'].output).toBe('hello world');
    expect(run.nodeStates['out'].status).toBe('completed');
    expect(run.nodeStates['out'].output).toBe('hello world');
  });

  it('executes a workflow with an agent node', async () => {
    const wf = makeWorkflow(
      [
        makeNode('in', 'input'),
        makeNode('agent1', 'agent', { model: 'gpt-5.4', systemPrompt: 'You are helpful' }),
        makeNode('out', 'output'),
      ],
      [makeEdge('in', 'agent1'), makeEdge('agent1', 'out')]
    );

    const providers = new Map([['openai', mockProvider]]);
    const executor = new DAGExecutor({ providers });
    const run = await executor.execute(wf, 'test input');

    expect(run.status).toBe('completed');
    expect(run.nodeStates['agent1'].status).toBe('completed');
    expect(run.nodeStates['agent1'].output).toContain('[mock response');
    expect(run.totalTokenUsage!.prompt).toBeGreaterThan(0);
  });

  it('executes parallel branches', async () => {
    const wf = makeWorkflow(
      [
        makeNode('in', 'input'),
        makeNode('a', 'agent', { model: 'gpt-5.4', systemPrompt: 'Agent A' }),
        makeNode('b', 'agent', { model: 'gpt-5.4', systemPrompt: 'Agent B' }),
        makeNode('merge', 'merge'),
        makeNode('out', 'output'),
      ],
      [
        makeEdge('in', 'a'),
        makeEdge('in', 'b'),
        makeEdge('a', 'merge'),
        makeEdge('b', 'merge'),
        makeEdge('merge', 'out'),
      ]
    );

    const providers = new Map([['openai', mockProvider]]);
    const events: ExecutionEvent[] = [];
    const executor = new DAGExecutor({
      providers,
      onEvent: (e) => events.push(e),
    });

    const run = await executor.execute(wf, 'parallel test');

    expect(run.status).toBe('completed');
    expect(run.nodeStates['a'].status).toBe('completed');
    expect(run.nodeStates['b'].status).toBe('completed');
    expect(run.nodeStates['merge'].status).toBe('completed');
    // Verify events were emitted
    expect(events.some((e) => e.type === 'run:start')).toBe(true);
    expect(events.some((e) => e.type === 'run:complete')).toBe(true);
  });

  it('rejects workflows with cycles', async () => {
    const wf = makeWorkflow(
      [makeNode('a'), makeNode('b')],
      [makeEdge('a', 'b'), makeEdge('b', 'a')]
    );
    const executor = new DAGExecutor();
    await expect(executor.execute(wf, 'test')).rejects.toThrow('Invalid workflow');
  });

  it('routes conditionally based on edge conditions', async () => {
    // condition → true branch (deploy) + false branch (fix)
    // condition evaluates "status === 'ok'" against input {status: "ok"}
    const wf = makeWorkflow(
      [
        makeNode('in', 'input'),
        makeNode('cond', 'condition', { conditionExpr: "status === 'ok'" }),
        makeNode('deploy', 'agent', { model: 'gpt-5.4', systemPrompt: 'Deploy it' }),
        makeNode('fix', 'agent', { model: 'gpt-5.4', systemPrompt: 'Fix it' }),
        makeNode('out', 'output'),
      ],
      [
        makeEdge('in', 'cond'),
        { id: 'cond->deploy', source: 'cond', target: 'deploy', condition: 'true' },
        { id: 'cond->fix', source: 'cond', target: 'fix', condition: 'false' },
        makeEdge('deploy', 'out'),
        makeEdge('fix', 'out'),
      ]
    );

    const providers = new Map([['openai', mockProvider]]);
    const executor = new DAGExecutor({ providers });

    // Input where status === 'ok' → true branch
    const run = await executor.execute(wf, { status: 'ok' });
    expect(run.status).toBe('completed');
    expect(run.nodeStates['deploy'].status).toBe('completed');
    expect(run.nodeStates['fix'].status).toBe('skipped');
  });

  it('routes to false branch when condition fails', async () => {
    const wf = makeWorkflow(
      [
        makeNode('in', 'input'),
        makeNode('cond', 'condition', { conditionExpr: "status === 'ok'" }),
        makeNode('deploy', 'agent', { model: 'gpt-5.4', systemPrompt: 'Deploy' }),
        makeNode('fix', 'agent', { model: 'gpt-5.4', systemPrompt: 'Fix' }),
        makeNode('out', 'output'),
      ],
      [
        makeEdge('in', 'cond'),
        { id: 'cond->deploy', source: 'cond', target: 'deploy', condition: 'true' },
        { id: 'cond->fix', source: 'cond', target: 'fix', condition: 'false' },
        makeEdge('deploy', 'out'),
        makeEdge('fix', 'out'),
      ]
    );

    const providers = new Map([['openai', mockProvider]]);
    const executor = new DAGExecutor({ providers });

    // Input where status !== 'ok' → false branch
    const run = await executor.execute(wf, { status: 'error' });
    expect(run.status).toBe('completed');
    expect(run.nodeStates['fix'].status).toBe('completed');
    expect(run.nodeStates['deploy'].status).toBe('skipped');
  });

  it('executes a loop node with max iterations', async () => {
    const wf = makeWorkflow(
      [
        makeNode('in', 'input'),
        makeNode('loop1', 'loop', {
          model: 'gpt-5.4',
          systemPrompt: 'Refine iteration {{iteration}}/{{maxIterations}}',
          maxIterations: 3,
        }),
        makeNode('out', 'output'),
      ],
      [makeEdge('in', 'loop1'), makeEdge('loop1', 'out')]
    );

    const iterations: number[] = [];
    const providers = new Map([['openai', mockProvider]]);
    const executor = new DAGExecutor({
      providers,
      onEvent: (e) => {
        if ((e as any).type === 'node:iteration') {
          iterations.push((e.data as any).iteration);
        }
      },
    });

    const run = await executor.execute(wf, 'initial draft');
    expect(run.status).toBe('completed');
    expect(run.nodeStates['loop1'].status).toBe('completed');
    expect(iterations).toEqual([0, 1, 2]); // 3 iterations
    expect(run.nodeStates['loop1'].output).toContain('[mock response');
    // Token usage should be accumulated across iterations
    expect(run.nodeStates['loop1'].tokenUsage!.prompt).toBe(30); // 10 * 3
  });

  it('executes a loop node that exits early via exitCondition', async () => {
    // Custom handler to simulate __done after 1 iteration
    let callCount = 0;
    const earlyExitProvider: AgentProvider = {
      name: 'mock',
      async chat(req) {
        callCount++;
        // Return __done on second call
        const content = callCount >= 2
          ? JSON.stringify({ __done: true, result: 'final' })
          : 'still working';
        return { content, tokenUsage: { prompt: 5, completion: 10 }, model: req.model };
      },
    };

    const wf = makeWorkflow(
      [
        makeNode('in', 'input'),
        makeNode('loop1', 'loop', {
          model: 'gpt-5.4',
          systemPrompt: 'Iterate',
          maxIterations: 10,
          exitCondition: '__done',
        }),
        makeNode('out', 'output'),
      ],
      [makeEdge('in', 'loop1'), makeEdge('loop1', 'out')]
    );

    const providers = new Map([['openai', earlyExitProvider]]);
    const executor = new DAGExecutor({ providers });
    const run = await executor.execute(wf, 'start');

    expect(run.status).toBe('completed');
    // Should have exited early — not all 10 iterations
    expect(callCount).toBeLessThanOrEqual(3);
  });

  it('supports input templates', async () => {
    const wf = makeWorkflow(
      [
        makeNode('in', 'input'),
        makeNode('agent1', 'agent', {
          model: 'gpt-5.4',
          systemPrompt: 'test',
          inputTemplate: 'Process: {{in.output}}',
        }),
        makeNode('out', 'output'),
      ],
      [makeEdge('in', 'agent1'), makeEdge('agent1', 'out')]
    );

    const providers = new Map([['openai', mockProvider]]);
    const executor = new DAGExecutor({ providers });
    const run = await executor.execute(wf, 'raw data');

    expect(run.status).toBe('completed');
    // The agent should have received the templated input
    expect(run.nodeStates['agent1'].output).toContain('[mock response');
  });
});

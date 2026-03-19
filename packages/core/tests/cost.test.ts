import { describe, it, expect } from 'vitest';
import { DAGExecutor, estimateCost } from '../src/executor.js';
import { MockProvider } from '../src/providers/base.js';
import type { Workflow } from '../src/types.js';

describe('Cost Tracking', () => {
  const mockProvider = new MockProvider(() => 'response text here');
  const providers = new Map([
    ['openai', mockProvider],
    ['claude', mockProvider],
    ['mock', mockProvider],
  ]);

  it('calculates cost for a completed run', async () => {
    const workflow: Workflow = {
      id: 'cost-test',
      name: 'Cost Test',
      nodes: [
        { id: 'in', type: 'input', position: { x: 0, y: 0 }, config: { name: 'In' } },
        { id: 'a1', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'GPT', model: 'gpt-5.4' } },
        { id: 'a2', type: 'agent', position: { x: 200, y: 200 }, config: { name: 'Claude', model: 'claude-sonnet-4-6' } },
        { id: 'merge', type: 'merge', position: { x: 400, y: 100 }, config: { name: 'Merge' } },
        { id: 'out', type: 'output', position: { x: 600, y: 100 }, config: { name: 'Out' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'a1' },
        { id: 'e2', source: 'in', target: 'a2' },
        { id: 'e3', source: 'a1', target: 'merge' },
        { id: 'e4', source: 'a2', target: 'merge' },
        { id: 'e5', source: 'merge', target: 'out' },
      ],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const executor = new DAGExecutor({ providers });
    const run = await executor.execute(workflow, 'analyze this code');

    expect(run.status).toBe('completed');
    expect(run.cost).toBeDefined();
    expect(run.cost!.totalUsd).toBeGreaterThan(0);

    // Should have per-node costs for agent nodes
    expect(run.cost!.perNode['a1']).toBeDefined();
    expect(run.cost!.perNode['a1'].model).toBe('gpt-5.4');
    expect(run.cost!.perNode['a1'].costUsd).toBeGreaterThan(0);

    expect(run.cost!.perNode['a2']).toBeDefined();
    expect(run.cost!.perNode['a2'].model).toBe('claude-sonnet-4-6');

    // Non-agent nodes shouldn't have cost entries
    expect(run.cost!.perNode['in']).toBeUndefined();
    expect(run.cost!.perNode['merge']).toBeUndefined();
  });

  it('estimateCost works standalone', () => {
    const workflow: Workflow = {
      id: 'w1',
      name: 'Test',
      nodes: [
        { id: 'a1', type: 'agent', position: { x: 0, y: 0 }, config: { name: 'Agent', model: 'gpt-5.4' } },
      ],
      edges: [],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const mockRun = {
      id: 'r1',
      workflowId: 'w1',
      status: 'completed' as const,
      input: {},
      nodeStates: {
        'a1': {
          status: 'completed' as const,
          tokenUsage: { prompt: 1000, completion: 500 },
        },
      },
      startedAt: '2026-01-01',
    };

    const cost = estimateCost(mockRun, workflow);

    // gpt-5.4: 1000/1M * 2.5 + 500/1M * 10 = 0.0025 + 0.005 = 0.0075
    expect(cost.totalUsd).toBeCloseTo(0.0075, 4);
    expect(cost.perNode['a1'].costUsd).toBeCloseTo(0.0075, 4);
  });

  it('handles unknown models with default pricing', () => {
    const workflow: Workflow = {
      id: 'w2',
      name: 'Test',
      nodes: [
        { id: 'a1', type: 'agent', position: { x: 0, y: 0 }, config: { name: 'Agent', model: 'future-model-x' } },
      ],
      edges: [],
      metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1.0' },
    };

    const mockRun = {
      id: 'r2',
      workflowId: 'w2',
      status: 'completed' as const,
      input: {},
      nodeStates: {
        'a1': { status: 'completed' as const, tokenUsage: { prompt: 1000, completion: 500 } },
      },
      startedAt: '2026-01-01',
    };

    const cost = estimateCost(mockRun, workflow);
    // Should still calculate with default pricing
    expect(cost.totalUsd).toBeGreaterThan(0);
  });
});

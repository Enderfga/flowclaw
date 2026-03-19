import { describe, it, expect } from 'vitest';
import {
  topologicalSort,
  validateWorkflow,
  getReadyNodes,
} from '../src/dag.js';
import type { DAGNode, DAGEdge, Workflow } from '../src/types.js';

function makeNode(id: string, type: DAGNode['type'] = 'agent', name?: string): DAGNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    config: { name: name ?? id, model: type === 'agent' ? 'gpt-5.4' : undefined, systemPrompt: type === 'agent' ? 'test' : undefined },
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

describe('topologicalSort', () => {
  it('sorts a simple linear DAG', () => {
    const nodes = [makeNode('a', 'input'), makeNode('b'), makeNode('c', 'output')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    const result = topologicalSort(nodes, edges);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('sorts a diamond DAG', () => {
    const nodes = [
      makeNode('a', 'input'),
      makeNode('b'),
      makeNode('c'),
      makeNode('d', 'output'),
    ];
    const edges = [
      makeEdge('a', 'b'),
      makeEdge('a', 'c'),
      makeEdge('b', 'd'),
      makeEdge('c', 'd'),
    ];
    const result = topologicalSort(nodes, edges);
    expect(result).not.toBeNull();
    expect(result!.indexOf('a')).toBeLessThan(result!.indexOf('b'));
    expect(result!.indexOf('a')).toBeLessThan(result!.indexOf('c'));
    expect(result!.indexOf('b')).toBeLessThan(result!.indexOf('d'));
    expect(result!.indexOf('c')).toBeLessThan(result!.indexOf('d'));
  });

  it('returns null for a cycle', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a')];
    expect(topologicalSort(nodes, edges)).toBeNull();
  });

  it('handles single node', () => {
    const nodes = [makeNode('a', 'input')];
    expect(topologicalSort(nodes, [])).toEqual(['a']);
  });
});

describe('validateWorkflow', () => {
  it('valid simple workflow', () => {
    const wf = makeWorkflow(
      [makeNode('in', 'input'), makeNode('agent1'), makeNode('out', 'output')],
      [makeEdge('in', 'agent1'), makeEdge('agent1', 'out')]
    );
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects cycles', () => {
    const wf = makeWorkflow(
      [makeNode('a'), makeNode('b')],
      [makeEdge('a', 'b'), makeEdge('b', 'a')]
    );
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'CYCLE_DETECTED')).toBe(true);
  });

  it('detects invalid edge references', () => {
    const wf = makeWorkflow(
      [makeNode('a')],
      [makeEdge('a', 'nonexistent')]
    );
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_EDGE_TARGET')).toBe(true);
  });

  it('detects duplicate node IDs', () => {
    const wf = makeWorkflow(
      [makeNode('a'), makeNode('a')],
      []
    );
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NODE_ID')).toBe(true);
  });

  it('warns on orphan nodes', () => {
    const wf = makeWorkflow(
      [makeNode('a', 'input'), makeNode('orphan'), makeNode('c', 'output')],
      [makeEdge('a', 'c')]
    );
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === 'ORPHAN_NODE')).toBe(true);
  });

  it('warns on missing input/output nodes', () => {
    const wf = makeWorkflow([makeNode('a'), makeNode('b')], [makeEdge('a', 'b')]);
    const result = validateWorkflow(wf);
    expect(result.warnings.some((w) => w.code === 'NO_INPUT_NODE')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'NO_OUTPUT_NODE')).toBe(true);
  });
});

describe('getReadyNodes', () => {
  it('returns nodes with all predecessors completed', () => {
    const nodes = [makeNode('a', 'input'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'b'), makeEdge('a', 'c')];
    const ready = getReadyNodes(nodes, edges, new Set(['a']), new Set());
    expect(ready.sort()).toEqual(['b', 'c']);
  });

  it('excludes running and completed nodes', () => {
    const nodes = [makeNode('a', 'input'), makeNode('b')];
    const edges = [makeEdge('a', 'b')];
    const ready = getReadyNodes(nodes, edges, new Set(['a']), new Set(['b']));
    expect(ready).toEqual([]);
  });

  it('waits for all predecessors', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'c'), makeEdge('b', 'c')];
    // Only 'a' is complete, 'c' needs both a+b
    const ready = getReadyNodes(nodes, edges, new Set(['a']), new Set());
    expect(ready).toContain('b');
    expect(ready).not.toContain('c');
  });
});

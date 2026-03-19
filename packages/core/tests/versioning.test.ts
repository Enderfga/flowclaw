import { describe, it, expect, beforeEach } from 'vitest';
import { diffWorkflows, VersionStore } from '../src/versioning.js';
import type { Workflow, DAGNode, DAGEdge } from '../src/types.js';

function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    nodes: [
      { id: 'n1', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
      { id: 'n2', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'Agent', model: 'gpt-5.4', systemPrompt: 'Do stuff' } },
      { id: 'n3', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Output' } },
    ] as DAGNode[],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ] as DAGEdge[],
    metadata: { created: '2026-01-01', updated: '2026-01-01', version: '1' },
    ...overrides,
  };
}

describe('diffWorkflows', () => {
  it('detects no changes for identical workflows', () => {
    const wf = makeWorkflow();
    const diff = diffWorkflows(wf, wf);
    expect(diff.nodes).toHaveLength(0);
    expect(diff.edges).toHaveLength(0);
    expect(diff.summary).toBe('no changes');
  });

  it('detects added nodes', () => {
    const from = makeWorkflow();
    const to = makeWorkflow({
      nodes: [
        ...from.nodes,
        { id: 'n4', type: 'tool', position: { x: 300, y: 100 }, config: { name: 'Linter' } } as DAGNode,
      ],
    });
    const diff = diffWorkflows(from, to);
    expect(diff.nodes).toHaveLength(1);
    expect(diff.nodes[0].type).toBe('added');
    expect(diff.nodes[0].nodeId).toBe('n4');
    expect(diff.summary).toContain('+1 node');
  });

  it('detects removed nodes', () => {
    const from = makeWorkflow();
    const to = makeWorkflow({ nodes: from.nodes.slice(0, 2) });
    const diff = diffWorkflows(from, to);
    expect(diff.nodes).toHaveLength(1);
    expect(diff.nodes[0].type).toBe('removed');
    expect(diff.nodes[0].nodeId).toBe('n3');
    expect(diff.summary).toContain('-1 node');
  });

  it('detects modified node config', () => {
    const from = makeWorkflow();
    const to = makeWorkflow();
    (to.nodes[1].config as Record<string, unknown>).systemPrompt = 'Do different stuff';
    (to.nodes[1].config as Record<string, unknown>).model = 'claude-sonnet-4-6';
    const diff = diffWorkflows(from, to);
    const modified = diff.nodes.find((n) => n.type === 'modified');
    expect(modified).toBeDefined();
    expect(modified!.nodeId).toBe('n2');
    expect(modified!.changes).toBeDefined();
    expect(modified!.changes!.length).toBeGreaterThanOrEqual(2);
    expect(diff.summary).toContain('~1 node');
  });

  it('detects modified node position', () => {
    const from = makeWorkflow();
    const to = makeWorkflow();
    to.nodes[0].position = { x: 50, y: 50 };
    const diff = diffWorkflows(from, to);
    const modified = diff.nodes.find((n) => n.type === 'modified');
    expect(modified).toBeDefined();
    expect(modified!.changes!.some((c) => c.path === 'position')).toBe(true);
  });

  it('detects added and removed edges', () => {
    const from = makeWorkflow();
    const to = makeWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' } as DAGEdge,
        // e2 removed
        { id: 'e3', source: 'n1', target: 'n3' } as DAGEdge, // new
      ],
    });
    const diff = diffWorkflows(from, to);
    expect(diff.edges.find((e) => e.type === 'removed')?.edgeId).toBe('e2');
    expect(diff.edges.find((e) => e.type === 'added')?.edgeId).toBe('e3');
    expect(diff.summary).toContain('+1 edge');
    expect(diff.summary).toContain('-1 edge');
  });

  it('detects metadata changes', () => {
    const from = makeWorkflow();
    const to = makeWorkflow({ name: 'Renamed Workflow' });
    const diff = diffWorkflows(from, to);
    expect(diff.metadata.some((m) => m.path === 'name')).toBe(true);
    expect(diff.summary).toContain('metadata change');
  });

  it('detects variable changes', () => {
    const from = makeWorkflow({ variables: { lang: 'en' } });
    const to = makeWorkflow({ variables: { lang: 'zh', debug: true } });
    const diff = diffWorkflows(from, to);
    expect(diff.metadata.some((m) => m.path === 'variables')).toBe(true);
  });
});

describe('VersionStore', () => {
  let store: VersionStore;

  beforeEach(() => {
    store = new VersionStore();
  });

  it('commits and retrieves versions', () => {
    const wf = makeWorkflow();
    const v = store.commit('wf-1', wf, 'Initial commit');
    expect(v).toBe(1);

    const versions = store.listVersions('wf-1');
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].message).toBe('Initial commit');
  });

  it('increments version numbers', () => {
    const wf = makeWorkflow();
    store.commit('wf-1', wf, 'v1');
    store.commit('wf-1', wf, 'v2');
    store.commit('wf-1', wf, 'v3');

    expect(store.latestVersion('wf-1')).toBe(3);
    const versions = store.listVersions('wf-1');
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('stores independent snapshots (no mutation leakage)', () => {
    const wf = makeWorkflow();
    store.commit('wf-1', wf, 'v1');

    // Mutate the original
    wf.name = 'Mutated';
    store.commit('wf-1', wf, 'v2');

    const v1 = store.getVersion('wf-1', 1);
    const v2 = store.getVersion('wf-1', 2);
    expect(v1!.snapshot.name).toBe('Test Workflow');
    expect(v2!.snapshot.name).toBe('Mutated');
  });

  it('computes diff between versions', () => {
    const wf1 = makeWorkflow();
    store.commit('wf-1', wf1, 'v1');

    const wf2 = makeWorkflow({
      nodes: [
        ...wf1.nodes,
        { id: 'n4', type: 'tool', position: { x: 300, y: 0 }, config: { name: 'New Tool' } } as DAGNode,
      ],
    });
    store.commit('wf-1', wf2, 'v2 - added tool');

    const diff = store.diff('wf-1', 1, 2);
    expect(diff).toBeDefined();
    expect(diff!.nodes).toHaveLength(1);
    expect(diff!.nodes[0].type).toBe('added');
    expect(diff!.nodes[0].nodeId).toBe('n4');
  });

  it('restores a previous version', () => {
    const wf1 = makeWorkflow();
    store.commit('wf-1', wf1, 'original');

    const wf2 = makeWorkflow({ name: 'Changed' });
    store.commit('wf-1', wf2, 'changed');

    const restored = store.restore('wf-1', 1);
    expect(restored).toBeDefined();
    expect(restored!.name).toBe('Test Workflow');
  });

  it('returns undefined for invalid versions', () => {
    expect(store.getVersion('wf-1', 999)).toBeUndefined();
    expect(store.diff('wf-1', 1, 2)).toBeUndefined();
    expect(store.restore('wf-1', 5)).toBeUndefined();
  });

  it('clears version history', () => {
    store.commit('wf-1', makeWorkflow(), 'v1');
    store.clear('wf-1');
    expect(store.latestVersion('wf-1')).toBe(0);
    expect(store.listVersions('wf-1')).toHaveLength(0);
  });

  it('tracks author metadata', () => {
    store.commit('wf-1', makeWorkflow(), 'v1', 'claude');
    const versions = store.listVersions('wf-1');
    expect(versions[0].author).toBe('claude');
  });
});

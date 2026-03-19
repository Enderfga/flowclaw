// ============================================================
// T5A — SQLite Storage Tests
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import type { Workflow, Run } from '@council/core';

// Force in-memory database for tests
process.env.COUNCIL_DB = ':memory:';

import { storage } from '../src/storage.js';

function makeWorkflow(id: string, name = 'Test WF'): Workflow {
  return {
    id,
    name,
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
      { id: 'out', type: 'output', position: { x: 200, y: 0 }, config: { name: 'Output' } },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'out' }],
    variables: { model: 'gpt-5.4' },
    metadata: {
      created: '2026-03-19T00:00:00Z',
      updated: '2026-03-19T00:00:00Z',
      version: '1',
    },
  };
}

function makeRun(id: string, workflowId: string): Run {
  return {
    id,
    workflowId,
    status: 'pending',
    input: { task: 'hello' },
    nodeStates: {
      in: { status: 'waiting' },
      out: { status: 'waiting' },
    },
    startedAt: '2026-03-19T00:00:00Z',
  };
}

describe('SQLite Storage', () => {
  beforeEach(() => {
    storage._reset();
  });

  // ---------- Workflow CRUD ----------

  describe('Workflows', () => {
    it('saves and retrieves a workflow', () => {
      const wf = makeWorkflow('wf-1');
      storage.saveWorkflow(wf);
      const loaded = storage.getWorkflow('wf-1');
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe('wf-1');
      expect(loaded!.name).toBe('Test WF');
      expect(loaded!.nodes).toHaveLength(2);
      expect(loaded!.edges).toHaveLength(1);
      expect(loaded!.variables).toEqual({ model: 'gpt-5.4' });
    });

    it('returns undefined for non-existent workflow', () => {
      expect(storage.getWorkflow('nonexistent')).toBeUndefined();
    });

    it('lists all workflows', () => {
      storage.saveWorkflow(makeWorkflow('wf-1', 'First'));
      storage.saveWorkflow(makeWorkflow('wf-2', 'Second'));
      const list = storage.listWorkflows();
      expect(list).toHaveLength(2);
    });

    it('updates an existing workflow (upsert)', () => {
      const wf = makeWorkflow('wf-1');
      storage.saveWorkflow(wf);

      const updated = { ...wf, name: 'Updated Name' };
      storage.saveWorkflow(updated);

      const loaded = storage.getWorkflow('wf-1');
      expect(loaded!.name).toBe('Updated Name');
      expect(storage.listWorkflows()).toHaveLength(1);
    });

    it('deletes a workflow', () => {
      storage.saveWorkflow(makeWorkflow('wf-1'));
      expect(storage.deleteWorkflow('wf-1')).toBe(true);
      expect(storage.getWorkflow('wf-1')).toBeUndefined();
      expect(storage.deleteWorkflow('wf-1')).toBe(false);
    });

    it('returns fresh objects (no reference sharing)', () => {
      storage.saveWorkflow(makeWorkflow('wf-1'));
      const a = storage.getWorkflow('wf-1')!;
      const b = storage.getWorkflow('wf-1')!;
      expect(a).toEqual(b);
      expect(a).not.toBe(b); // Different object references
    });
  });

  // ---------- Run CRUD ----------

  describe('Runs', () => {
    it('saves and retrieves a run', () => {
      storage.saveWorkflow(makeWorkflow('wf-1'));
      const run = makeRun('run-1', 'wf-1');
      storage.saveRun(run);
      const loaded = storage.getRun('run-1');
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe('run-1');
      expect(loaded!.workflowId).toBe('wf-1');
      expect(loaded!.status).toBe('pending');
      expect(loaded!.input).toEqual({ task: 'hello' });
    });

    it('returns undefined for non-existent run', () => {
      expect(storage.getRun('nonexistent')).toBeUndefined();
    });

    it('lists runs filtered by workflowId', () => {
      storage.saveWorkflow(makeWorkflow('wf-1'));
      storage.saveWorkflow(makeWorkflow('wf-2', 'Second WF'));
      storage.saveRun(makeRun('run-1', 'wf-1'));
      storage.saveRun(makeRun('run-2', 'wf-1'));
      storage.saveRun(makeRun('run-3', 'wf-2'));

      const all = storage.listRuns();
      expect(all).toHaveLength(3);

      const filtered = storage.listRuns('wf-1');
      expect(filtered).toHaveLength(2);
      expect(filtered.every((r) => r.workflowId === 'wf-1')).toBe(true);
    });

    it('updates run status (upsert)', () => {
      storage.saveWorkflow(makeWorkflow('wf-1'));
      const run = makeRun('run-1', 'wf-1');
      storage.saveRun(run);

      const completed: Run = {
        ...run,
        status: 'completed',
        completedAt: '2026-03-19T00:01:00Z',
        nodeStates: {
          in: { status: 'completed', output: 'hello' },
          out: { status: 'completed', output: 'world' },
        },
        totalTokenUsage: { prompt: 100, completion: 50 },
        cost: { totalUsd: 0.001, perNode: {} },
      };
      storage.saveRun(completed);

      const loaded = storage.getRun('run-1')!;
      expect(loaded.status).toBe('completed');
      expect(loaded.completedAt).toBe('2026-03-19T00:01:00Z');
      expect(loaded.totalTokenUsage).toEqual({ prompt: 100, completion: 50 });
      expect(loaded.cost).toEqual({ totalUsd: 0.001, perNode: {} });
    });
  });

  // ---------- Version persistence ----------

  describe('Versions', () => {
    it('commits and lists versions', () => {
      const wf = makeWorkflow('wf-1');
      storage.saveWorkflow(wf);
      storage.commitVersion('wf-1', 1, wf, 'First version', 'claude');
      storage.commitVersion('wf-1', 2, { ...wf, name: 'Updated' }, 'Second version');

      const versions = storage.listVersions('wf-1');
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(1);
      expect(versions[0].message).toBe('First version');
      expect(versions[0].author).toBe('claude');
      expect(versions[1].version).toBe(2);
    });

    it('retrieves a specific version with snapshot', () => {
      const wf = makeWorkflow('wf-1');
      storage.saveWorkflow(wf);
      storage.commitVersion('wf-1', 1, wf, 'Init');

      const ver = storage.getVersion('wf-1', 1);
      expect(ver).toBeDefined();
      expect(ver!.snapshot.name).toBe('Test WF');
      expect(ver!.snapshot.nodes).toHaveLength(2);
    });

    it('returns undefined for non-existent version', () => {
      expect(storage.getVersion('wf-1', 99)).toBeUndefined();
    });

    it('tracks latest version number', () => {
      expect(storage.latestVersion('wf-1')).toBe(0);

      const wf = makeWorkflow('wf-1');
      storage.saveWorkflow(wf);
      storage.commitVersion('wf-1', 1, wf, 'v1');
      expect(storage.latestVersion('wf-1')).toBe(1);

      storage.commitVersion('wf-1', 2, wf, 'v2');
      expect(storage.latestVersion('wf-1')).toBe(2);
    });

    it('deletes all versions for a workflow', () => {
      const wf = makeWorkflow('wf-1');
      storage.saveWorkflow(wf);
      storage.commitVersion('wf-1', 1, wf, 'v1');
      storage.commitVersion('wf-1', 2, wf, 'v2');
      storage.deleteVersions('wf-1');
      expect(storage.listVersions('wf-1')).toHaveLength(0);
    });
  });
});

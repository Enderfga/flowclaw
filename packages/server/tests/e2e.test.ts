// ============================================================
// T3.5 — End-to-End Integration Test
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { workflowRoutes } from '../src/api/workflows.js';
import { runRoutes } from '../src/api/runs.js';
import { plannerRoutes } from '../src/api/planner.js';
import { wsHandler } from '../src/ws/handler.js';
import type { Workflow, Run } from '@council/core';

describe('E2E: Server Integration', () => {
  let app: ReturnType<typeof Fastify>;
  let baseUrl: string;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    await app.register(websocket);
    await app.register(workflowRoutes, { prefix: '/api/workflows' });
    await app.register(runRoutes, { prefix: '/api/runs' });
    await app.register(plannerRoutes, { prefix: '/api/planner' });
    app.register(async (fastify) => {
      fastify.get('/ws', { websocket: true }, wsHandler);
    });
    app.get('/health', async () => ({ status: 'ok' }));

    await app.listen({ port: 0 }); // random port
    const addr = app.server.address();
    if (typeof addr === 'string' || !addr) throw new Error('Failed to get server address');
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('health check', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('full workflow lifecycle: create → validate → run → complete', async () => {
    // 1. Create a simple workflow
    const workflow: Partial<Workflow> = {
      name: 'E2E Test Workflow',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'agent1', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'Agent', model: 'gpt-5.4', systemPrompt: 'Echo the input' } },
        { id: 'output', type: 'output', position: { x: 400, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'agent1' },
        { id: 'e2', source: 'agent1', target: 'output' },
      ],
    };

    const createRes = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });
    expect(createRes.ok).toBe(true);
    const created = await createRes.json() as Workflow;
    expect(created.id).toBeDefined();
    expect(created.name).toBe('E2E Test Workflow');

    // 2. Validate workflow
    const validateRes = await fetch(`${baseUrl}/api/workflows/${created.id}/validate`, {
      method: 'POST',
    });
    expect(validateRes.ok).toBe(true);
    const validation = await validateRes.json();
    expect(validation.valid).toBe(true);

    // 3. Start a run
    const runRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: created.id, input: { message: 'Hello E2E!' } }),
    });
    expect(runRes.ok).toBe(true);
    const runStart = await runRes.json();
    expect(runStart.id).toBeDefined();
    expect(runStart.status).toBe('running');

    // 4. Poll for completion (with timeout)
    let run: Run | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const pollRes = await fetch(`${baseUrl}/api/runs/${runStart.id}`);
      run = await pollRes.json() as Run;
      if (run.status === 'completed' || run.status === 'failed') break;
    }

    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.nodeStates['input'].status).toBe('completed');
    expect(run!.nodeStates['agent1'].status).toBe('completed');
    expect(run!.nodeStates['output'].status).toBe('completed');

    // 5. Verify mock provider was used (output contains [Mock ...])
    const agentOutput = run!.nodeStates['agent1'].output as string;
    expect(agentOutput).toContain('[Mock');
  });

  it('parallel execution: 3 agents run concurrently', async () => {
    const workflow: Partial<Workflow> = {
      name: 'Parallel Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 100 }, config: { name: 'Input' } },
        { id: 'a1', type: 'agent', position: { x: 200, y: 0 }, config: { name: 'A1', model: 'gpt-5.4' } },
        { id: 'a2', type: 'agent', position: { x: 200, y: 100 }, config: { name: 'A2', model: 'claude-sonnet-4-6' } },
        { id: 'a3', type: 'agent', position: { x: 200, y: 200 }, config: { name: 'A3', model: 'gemini-3-pro-preview' } },
        { id: 'merge', type: 'merge', position: { x: 400, y: 100 }, config: { name: 'Merge' } },
        { id: 'output', type: 'output', position: { x: 600, y: 100 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'a1' },
        { id: 'e2', source: 'input', target: 'a2' },
        { id: 'e3', source: 'input', target: 'a3' },
        { id: 'e4', source: 'a1', target: 'merge' },
        { id: 'e5', source: 'a2', target: 'merge' },
        { id: 'e6', source: 'a3', target: 'merge' },
        { id: 'e7', source: 'merge', target: 'output' },
      ],
    };

    const createRes = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });
    const created = await createRes.json() as Workflow;

    const runRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: created.id, input: { task: 'review this code' } }),
    });
    const runStart = await runRes.json();

    // Poll for completion
    let run: Run | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const pollRes = await fetch(`${baseUrl}/api/runs/${runStart.id}`);
      run = await pollRes.json() as Run;
      if (run.status === 'completed' || run.status === 'failed') break;
    }

    expect(run!.status).toBe('completed');

    // All 3 agents should have completed
    expect(run!.nodeStates['a1'].status).toBe('completed');
    expect(run!.nodeStates['a2'].status).toBe('completed');
    expect(run!.nodeStates['a3'].status).toBe('completed');

    // Merge should have collected all outputs
    const mergeOutput = run!.nodeStates['merge'].output as Record<string, unknown>;
    expect(mergeOutput['a1']).toBeDefined();
    expect(mergeOutput['a2']).toBeDefined();
    expect(mergeOutput['a3']).toBeDefined();

    // Each agent used different provider
    expect(String(mergeOutput['a1'])).toContain('[Mock openai]');
    expect(String(mergeOutput['a2'])).toContain('[Mock claude]');
    expect(String(mergeOutput['a3'])).toContain('[Mock gemini]');
  });

  it('validation rejects cyclic workflows', async () => {
    const workflow: Partial<Workflow> = {
      name: 'Cyclic Test',
      nodes: [
        { id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: { name: 'A' } },
        { id: 'b', type: 'agent', position: { x: 100, y: 0 }, config: { name: 'B' } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' }, // cycle!
      ],
    };

    const createRes = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });
    const created = await createRes.json() as Workflow;

    const validateRes = await fetch(`${baseUrl}/api/workflows/${created.id}/validate`, {
      method: 'POST',
    });
    const validation = await validateRes.json();
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e: { code: string }) => e.code === 'CYCLE_DETECTED')).toBe(true);
  });
});

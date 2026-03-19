import type { FastifyInstance } from 'fastify';
import type { Workflow } from '@council/core';
import { validateWorkflow } from '@council/core';
import { storage } from '../storage.js';
import crypto from 'node:crypto';

export async function workflowRoutes(app: FastifyInstance) {
  // List workflows
  app.get('/', async () => storage.listWorkflows());

  // Get workflow
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const wf = storage.getWorkflow(req.params.id);
    if (!wf) return reply.code(404).send({ error: 'Workflow not found' });
    return wf;
  });

  // Create workflow
  app.post<{ Body: Omit<Workflow, 'id' | 'metadata'> }>('/', async (req) => {
    const body = req.body;
    const now = new Date().toISOString();
    const wf: Workflow = {
      ...body,
      id: crypto.randomUUID(),
      metadata: { created: now, updated: now, version: '1' },
    };
    storage.saveWorkflow(wf);
    storage.commitVersion(wf.id, 1, wf, 'Initial version');
    return wf;
  });

  // Update workflow
  app.put<{ Params: { id: string }; Body: Partial<Workflow> }>('/:id', async (req, reply) => {
    const existing = storage.getWorkflow(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'Workflow not found' });

    const body = req.body as Record<string, unknown>;
    const updated: Workflow = {
      ...existing,
      ...body,
      id: existing.id,
      metadata: { ...existing.metadata, updated: new Date().toISOString() },
    } as Workflow;
    storage.saveWorkflow(updated);

    const nextVer = storage.latestVersion(updated.id) + 1;
    storage.commitVersion(updated.id, nextVer, updated, (body as Record<string, unknown>).versionMessage as string ?? undefined);
    return updated;
  });

  // Delete workflow
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!storage.deleteWorkflow(req.params.id)) {
      return reply.code(404).send({ error: 'Workflow not found' });
    }
    storage.deleteVersions(req.params.id);
    return { ok: true };
  });

  // Validate workflow DAG
  app.post<{ Params: { id: string } }>('/:id/validate', async (req, reply) => {
    const wf = storage.getWorkflow(req.params.id);
    if (!wf) return reply.code(404).send({ error: 'Workflow not found' });

    const result = validateWorkflow(wf);
    return result;
  });
}

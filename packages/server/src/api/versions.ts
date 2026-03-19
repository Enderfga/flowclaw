import type { FastifyInstance } from 'fastify';
import { diffWorkflows } from '@council/core';
import { storage } from '../storage.js';

export async function versionRoutes(app: FastifyInstance) {
  // List all versions for a workflow
  app.get<{ Params: { id: string } }>('/api/workflows/:id/versions', async (req, reply) => {
    const wf = storage.getWorkflow(req.params.id);
    if (!wf) return reply.code(404).send({ error: 'Workflow not found' });
    return storage.listVersions(req.params.id);
  });

  // Get a specific version snapshot
  app.get<{ Params: { id: string; version: string } }>(
    '/api/workflows/:id/versions/:version',
    async (req, reply) => {
      const ver = storage.getVersion(req.params.id, parseInt(req.params.version, 10));
      if (!ver) return reply.code(404).send({ error: 'Version not found' });
      return ver;
    },
  );

  // Commit current workflow state as a new version
  app.post<{ Params: { id: string }; Body: { message?: string; author?: string } }>(
    '/api/workflows/:id/versions',
    async (req, reply) => {
      const wf = storage.getWorkflow(req.params.id);
      if (!wf) return reply.code(404).send({ error: 'Workflow not found' });

      const body = req.body ?? {};
      const nextVersion = storage.latestVersion(req.params.id) + 1;
      storage.commitVersion(req.params.id, nextVersion, wf, body.message, body.author);
      return { version: nextVersion, workflowId: req.params.id };
    },
  );

  // Diff between two versions
  app.get<{ Params: { id: string }; Querystring: { from: string; to: string } }>(
    '/api/workflows/:id/diff',
    async (req, reply) => {
      const from = parseInt(req.query.from, 10);
      const to = parseInt(req.query.to, 10);

      if (isNaN(from) || isNaN(to)) {
        return reply.code(400).send({ error: 'from and to must be integers' });
      }

      const fromVer = storage.getVersion(req.params.id, from);
      const toVer = storage.getVersion(req.params.id, to);
      if (!fromVer || !toVer) return reply.code(404).send({ error: 'One or both versions not found' });
      return diffWorkflows(fromVer.snapshot, toVer.snapshot, from, to);
    },
  );

  // Diff current workflow against a specific version
  app.get<{ Params: { id: string; version: string } }>(
    '/api/workflows/:id/diff/:version',
    async (req, reply) => {
      const wf = storage.getWorkflow(req.params.id);
      if (!wf) return reply.code(404).send({ error: 'Workflow not found' });

      const ver = storage.getVersion(req.params.id, parseInt(req.params.version, 10));
      if (!ver) return reply.code(404).send({ error: 'Version not found' });

      return diffWorkflows(ver.snapshot, wf, ver.version, -1);
    },
  );

  // Restore workflow to a previous version
  app.post<{ Params: { id: string; version: string } }>(
    '/api/workflows/:id/restore/:version',
    async (req, reply) => {
      const ver = storage.getVersion(req.params.id, parseInt(req.params.version, 10));
      if (!ver) return reply.code(404).send({ error: 'Version not found' });

      const restored = JSON.parse(JSON.stringify(ver.snapshot));
      restored.metadata.updated = new Date().toISOString();
      storage.saveWorkflow(restored);

      const nextVersion = storage.latestVersion(req.params.id) + 1;
      storage.commitVersion(
        req.params.id,
        nextVersion,
        restored,
        `Restored from version ${req.params.version}`,
      );

      return { restored: true, version: nextVersion, workflow: restored };
    },
  );
}

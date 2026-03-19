import type { FastifyInstance } from 'fastify';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'workflows', 'templates');

interface TemplateSummary {
  filename: string;
  name: string;
  description: string;
  nodeCount: number;
  edgeCount: number;
}

export async function templateRoutes(app: FastifyInstance) {
  // List all templates
  app.get('/api/templates', async (_req, reply) => {
    try {
      const files = await readdir(TEMPLATES_DIR);
      const templates: TemplateSummary[] = [];

      for (const file of files.filter(f => f.endsWith('.json'))) {
        try {
          const content = await readFile(join(TEMPLATES_DIR, file), 'utf-8');
          const wf = JSON.parse(content);
          templates.push({
            filename: file,
            name: wf.name ?? file,
            description: wf.description ?? '',
            nodeCount: wf.nodes?.length ?? 0,
            edgeCount: wf.edges?.length ?? 0,
          });
        } catch {
          // skip invalid files
        }
      }

      return reply.send(templates);
    } catch {
      return reply.send([]);
    }
  });

  // Get a specific template
  app.get<{ Params: { filename: string } }>('/api/templates/:filename', async (req, reply) => {
    const { filename } = req.params;
    // Security: prevent path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }
    try {
      const content = await readFile(join(TEMPLATES_DIR, filename), 'utf-8');
      return reply.send(JSON.parse(content));
    } catch {
      return reply.code(404).send({ error: 'Template not found' });
    }
  });
}

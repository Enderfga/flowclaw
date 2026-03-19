import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { workflowRoutes } from './api/workflows.js';
import { runRoutes } from './api/runs.js';
import { plannerRoutes } from './api/planner.js';
import { templateRoutes } from './api/templates.js';
import { versionRoutes } from './api/versions.js';
import { wsHandler } from './ws/handler.js';
import { listProviderStatus, checkProviderHealth, buildProviders } from './providers.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // REST API
  await app.register(workflowRoutes, { prefix: '/api/workflows' });
  await app.register(runRoutes, { prefix: '/api/runs' });
  await app.register(plannerRoutes, { prefix: '/api/planner' });
  await app.register(templateRoutes);
  await app.register(versionRoutes);

  // WebSocket for live run status
  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, wsHandler);
  });

  const providers = buildProviders();

  // Serve council web frontend (static files from packages/web/dist)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const webDistPath = join(__dirname, '../../web/dist');
  
  try {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false, // Let API routes take priority
    });
    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
    console.log(`📁 Serving web UI from ${webDistPath}`);
  } catch (e) {
    console.warn(`⚠️ Web UI not found at ${webDistPath} — API-only mode`);
  }

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
  app.get('/api/providers', async () => listProviderStatus());
  app.get('/api/providers/health', async () => checkProviderHealth(providers));

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`🚀 Council server listening on http://localhost:${PORT}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

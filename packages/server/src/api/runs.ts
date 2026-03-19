import type { FastifyInstance } from 'fastify';
import type { Run, ExecutionEvent, HumanApproval, RunSummary } from '@council/core';
import { DAGExecutor, estimateCost, summarizeRun, BreakpointPauseError } from '@council/core';
import { storage } from '../storage.js';
import { broadcast } from '../ws/handler.js';
import { buildProviders } from '../providers.js';
import crypto from 'node:crypto';

// Build providers once at module load
const providers = buildProviders();

// SSE run listeners (per-run event subscribers)
type RunListener = (event: ExecutionEvent) => void;
const runListeners = new Map<string, Set<RunListener>>();

function addRunListener(runId: string, listener: RunListener) {
  if (!runListeners.has(runId)) runListeners.set(runId, new Set());
  runListeners.get(runId)!.add(listener);
}

function removeRunListener(runId: string, listener: RunListener) {
  runListeners.get(runId)?.delete(listener);
  if (runListeners.get(runId)?.size === 0) runListeners.delete(runId);
}

function notifyRunListeners(event: ExecutionEvent) {
  const listeners = runListeners.get(event.runId);
  if (listeners) {
    for (const listener of listeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }
}

// Track active executors for resume/cancel
const activeExecutors = new Map<string, { executor: DAGExecutor; workflowId: string }>();

export async function runRoutes(app: FastifyInstance) {
  // List runs (optionally filter by workflowId)
  app.get<{ Querystring: { workflowId?: string } }>('/', async (req) => {
    return storage.listRuns(req.query.workflowId);
  });

  // Get run
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const run = storage.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return run;
  });

  // Start a run — actually executes via the DAG engine
  app.post<{ Body: { workflowId: string; input?: unknown } }>('/', async (req, reply) => {
    const { workflowId, input } = req.body;
    const wf = storage.getWorkflow(workflowId);
    if (!wf) return reply.code(404).send({ error: 'Workflow not found' });

    // Create executor with providers and event broadcasting
    const executor = new DAGExecutor({
      maxConcurrency: 10,
      providers,
      onEvent: (event: ExecutionEvent) => {
        broadcast({ ...event });
        notifyRunListeners(event);
      },
    });

    // Execute asynchronously (don't block the HTTP response)
    const runPromise = executor.execute(wf, input ?? {});

    // Return the run ID immediately; client subscribes via WebSocket
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const pendingRun: Run = {
      id: runId,
      workflowId,
      status: 'running',
      input: input ?? {},
      nodeStates: {},
      startedAt: now,
    };
    for (const node of wf.nodes) {
      pendingRun.nodeStates[node.id] = { status: 'waiting' };
    }
    storage.saveRun(pendingRun);
    broadcast({ type: 'run:start', runId, timestamp: now });

    // Track executor for potential resume/cancel
    activeExecutors.set(runId, { executor, workflowId });

    // Fire and forget — update storage when done
    runPromise
      .then((result: Run) => {
        const finalRun: Run = { ...result, id: runId };
        storage.saveRun(finalRun);
        if (finalRun.status === 'paused') {
          // Don't remove executor — we need it for resume
          broadcast({
            type: 'run:paused',
            runId,
            timestamp: new Date().toISOString(),
            data: { pausedNodes: finalRun.pausedNodes },
          });
        } else {
          activeExecutors.delete(runId);
          broadcast({ type: 'run:complete', runId, timestamp: new Date().toISOString() });
        }
      })
      .catch((err: unknown) => {
        activeExecutors.delete(runId);
        pendingRun.status = 'failed';
        pendingRun.completedAt = new Date().toISOString();
        storage.saveRun(pendingRun);
        broadcast({ type: 'run:fail', runId, timestamp: new Date().toISOString(), data: { error: String(err) } });
      });

    return { id: runId, status: 'running', workflowId };
  });

  // Approve/reject a human node
  app.post<{
    Params: { id: string; nodeId: string };
    Body: { status: 'approved' | 'rejected'; comment?: string; data?: unknown; approvedBy?: string };
  }>(
    '/:id/approve/:nodeId',
    async (req, reply) => {
      const run = storage.getRun(req.params.id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      if (run.status !== 'paused') return reply.code(400).send({ error: 'Run is not paused' });

      const nodeState = run.nodeStates[req.params.nodeId];
      if (!nodeState || nodeState.status !== 'paused') {
        return reply.code(400).send({ error: 'Node is not paused' });
      }

      const active = activeExecutors.get(req.params.id);
      if (!active) return reply.code(400).send({ error: 'Executor not found — run may have expired' });

      const wf = storage.getWorkflow(active.workflowId);
      if (!wf) return reply.code(404).send({ error: 'Workflow not found' });

      const approval: HumanApproval = {
        status: req.body.status,
        comment: req.body.comment,
        data: req.body.data,
        approvedBy: req.body.approvedBy,
        approvedAt: new Date().toISOString(),
      };

      // Call executor.resume to continue execution
      active.executor.resume(wf, run, req.params.nodeId, approval)
        .then((result: Run) => {
          storage.saveRun(result);
          if (result.status === 'paused') {
            broadcast({
              type: 'run:paused',
              runId: run.id,
              timestamp: new Date().toISOString(),
              data: { pausedNodes: result.pausedNodes },
            });
          } else if (result.status === 'completed') {
            activeExecutors.delete(run.id);
            broadcast({ type: 'run:complete', runId: run.id, timestamp: new Date().toISOString() });
          } else if (result.status === 'failed') {
            activeExecutors.delete(run.id);
            broadcast({ type: 'run:fail', runId: run.id, timestamp: new Date().toISOString() });
          }
        })
        .catch((err: unknown) => {
          run.status = 'failed';
          storage.saveRun(run);
          activeExecutors.delete(run.id);
          broadcast({ type: 'run:fail', runId: run.id, timestamp: new Date().toISOString(), data: { error: String(err) } });
        });

      return { status: 'resuming', runId: run.id, nodeId: req.params.nodeId, approval: approval.status };
    }
  );

  // SSE stream for a run — real-time events via Server-Sent Events
  app.get<{ Params: { id: string } }>('/:id/stream', async (req, reply) => {
    const run = storage.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current state first
    reply.raw.write(`data: ${JSON.stringify({ type: 'snapshot', run })}\n\n`);

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      reply.raw.write(`data: ${JSON.stringify({ type: run.status === 'completed' ? 'run:complete' : 'run:fail', runId: run.id })}\n\n`);
      reply.raw.end();
      return;
    }

    // Subscribe to events for this run via broadcast listener
    const listener = (event: ExecutionEvent) => {
      if (event.runId !== req.params.id) return;
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'run:complete' || event.type === 'run:fail') {
          // Also send final cost estimate
          const finalRun = storage.getRun(req.params.id);
          if (finalRun) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'cost', cost: finalRun.cost })}\n\n`);
          }
          reply.raw.end();
        }
      } catch {
        // Client disconnected
      }
    };

    // Register listener — use the ws handler's subscriber mechanism
    addRunListener(req.params.id, listener);

    req.raw.on('close', () => {
      removeRunListener(req.params.id, listener);
    });
  });

  // Cancel a run
  app.post<{ Params: { id: string } }>('/:id/cancel', async (req, reply) => {
    const run = storage.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    run.status = 'cancelled';
    run.completedAt = new Date().toISOString();
    storage.saveRun(run);
    activeExecutors.delete(req.params.id);
    return run;
  });

  // ---------- Breakpoint Debugging API ----------

  // Set breakpoints on an active run's executor
  app.post<{
    Params: { id: string };
    Body: { nodeIds: string[] };
  }>('/:id/breakpoints', async (req, reply) => {
    const active = activeExecutors.get(req.params.id);
    if (!active) return reply.code(404).send({ error: 'No active executor for this run' });
    for (const nodeId of req.body.nodeIds) {
      active.executor.addBreakpoint(nodeId);
    }
    return { runId: req.params.id, breakpoints: active.executor.getBreakpoints() };
  });

  // Remove breakpoints
  app.delete<{
    Params: { id: string };
    Body: { nodeIds: string[] };
  }>('/:id/breakpoints', async (req, reply) => {
    const active = activeExecutors.get(req.params.id);
    if (!active) return reply.code(404).send({ error: 'No active executor for this run' });
    for (const nodeId of req.body.nodeIds) {
      active.executor.removeBreakpoint(nodeId);
    }
    return { runId: req.params.id, breakpoints: active.executor.getBreakpoints() };
  });

  // Resume from breakpoint (optionally with modified input)
  app.post<{
    Params: { id: string; nodeId: string };
    Body: { modifiedInput?: unknown };
  }>('/:id/breakpoints/:nodeId/resume', async (req, reply) => {
    const run = storage.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });

    const active = activeExecutors.get(req.params.id);
    if (!active) return reply.code(400).send({ error: 'Executor not found' });

    const wf = storage.getWorkflow(active.workflowId);
    if (!wf) return reply.code(404).send({ error: 'Workflow not found' });

    active.executor.resumeBreakpoint(wf, run, req.params.nodeId, req.body.modifiedInput)
      .then((result: Run) => {
        storage.saveRun(result);
        if (result.status === 'completed') {
          activeExecutors.delete(run.id);
          broadcast({ type: 'run:complete', runId: run.id, timestamp: new Date().toISOString() });
        } else if (result.status === 'paused') {
          broadcast({
            type: 'run:paused',
            runId: run.id,
            timestamp: new Date().toISOString(),
            data: { breakpoints: result.breakpoints, pausedNodes: result.pausedNodes },
          });
        }
      })
      .catch((err: unknown) => {
        run.status = 'failed';
        storage.saveRun(run);
        activeExecutors.delete(run.id);
        broadcast({ type: 'run:fail', runId: run.id, timestamp: new Date().toISOString(), data: { error: String(err) } });
      });

    return { status: 'resuming', runId: run.id, nodeId: req.params.nodeId };
  });

  // ---------- Execution History API ----------

  // List run summaries (with pagination)
  app.get<{ Querystring: { workflowId?: string; limit?: string; offset?: string } }>(
    '/history',
    async (req) => {
      const limit = parseInt(req.query.limit ?? '50', 10);
      const offset = parseInt(req.query.offset ?? '0', 10);
      const allRuns = storage.listRuns(req.query.workflowId);

      // Sort by startedAt desc
      allRuns.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

      const page = allRuns.slice(offset, offset + limit);
      const summaries: RunSummary[] = page.map(run => {
        const wf = storage.getWorkflow(run.workflowId);
        return summarizeRun(run, wf?.name ?? 'Unknown');
      });

      return { total: allRuns.length, offset, limit, runs: summaries };
    }
  );

  // Get full run detail (for replay/inspection)
  app.get<{ Params: { id: string } }>('/:id/detail', async (req, reply) => {
    const run = storage.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const wf = storage.getWorkflow(run.workflowId);
    return {
      run,
      workflow: wf ?? null,
      summary: summarizeRun(run, wf?.name ?? 'Unknown'),
    };
  });
}

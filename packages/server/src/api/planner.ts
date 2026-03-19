import type { FastifyInstance } from 'fastify';
import { planWorkflow, autoFixWorkflow, validateWorkflow } from '@council/core';
import type { AgentProvider, ProviderRequest, ProviderResponse, ProviderMessage, Workflow } from '@council/core';
import { storage } from '../storage.js';

// ---------- Provider Factory ----------

/**
 * Create an AgentProvider from environment variables.
 * Supports OpenAI-compatible APIs.
 */
function createProviderFromEnv(): AgentProvider | null {
  // Try multiple providers in priority order
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.GOOGLE_API_KEY;
  
  if (!apiKey) return null;

  // Use Google AI (Gemini) if that's the only key available
  const isGoogle = !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !!process.env.GOOGLE_API_KEY;
  const baseUrl = isGoogle
    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1');

  return {
    name: 'openai-compatible',
    async chat(request: ProviderRequest): Promise<ProviderResponse> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: isGoogle ? 'gemini-3.1-flash' : request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.3,
          max_tokens: request.maxTokens ?? 4096,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Provider API error ${res.status}: ${body}`);
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
        model: string;
      };

      return {
        content: data.choices[0]?.message?.content ?? '',
        tokenUsage: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
        },
        model: data.model,
      };
    },
  };
}


// ---------- Routes ----------

export async function plannerRoutes(app: FastifyInstance) {
  // POST /api/planner/generate — Generate workflow from natural language
  app.post<{
    Body: {
      task: string;
      model?: string;
      temperature?: number;
      autoSave?: boolean;
    };
  }>('/generate', async (req, reply) => {
    const { task, model, temperature, autoSave } = req.body;

    if (!task || task.trim().length === 0) {
      return reply.code(400).send({ error: 'Task description is required' });
    }

    // Try real provider first, fall back to mock
    const provider = createProviderFromEnv();
    if (!provider) {
      return reply.code(503).send({ error: 'No AI provider configured. Set GOOGLE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.' });
    }
    
    try {
      const result = await planWorkflow(task, {
        provider,
        model: model ?? 'gpt-5.4',
        temperature,
      });

      if (autoSave !== false) {
        storage.saveWorkflow(result.workflow);
      }

      return {
        workflow: result.workflow,
        validationErrors: result.validationErrors,
        autoFixed: result.autoFixed,
      };
    } catch (error) {
      return reply.code(500).send({ error: String(error) });
    }
  });

  // POST /api/planner/fix — Auto-fix an existing workflow
  app.post<{ Body: { workflow: Workflow } }>('/fix', async (req, reply) => {
    try {
      const result = autoFixWorkflow(req.body.workflow);
      const validation = validateWorkflow(result.workflow);
      return { workflow: result.workflow, validation, wasFixed: result.wasFixed, errors: result.errors };
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  // POST /api/planner/validate — Validate a workflow
  app.post<{ Body: { workflow: Workflow } }>('/validate', async (req, reply) => {
    try {
      const validation = validateWorkflow(req.body.workflow);
      return validation;
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  // POST /api/planner/refine — Modify existing workflow with AI
  app.post<{
    Body: { workflowId: string; instruction: string; model?: string };
  }>('/refine', async (req, reply) => {
    const { workflowId, instruction, model } = req.body;
    const existing = storage.getWorkflow(workflowId);
    if (!existing) return reply.code(404).send({ error: 'Workflow not found' });

    const provider = createProviderFromEnv();
    if (!provider) {
      return reply.code(503).send({ error: 'No AI provider configured. Set GOOGLE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.' });
    }
    
    try {
      const taskWithContext = `${instruction}\n\nCurrent workflow:\n${JSON.stringify(existing, null, 2)}\n\nModify this workflow. Keep existing node IDs where possible.`;
      const result = await planWorkflow(taskWithContext, { provider, model });
      result.workflow.id = workflowId;
      result.workflow.metadata.updated = new Date().toISOString();
      storage.saveWorkflow(result.workflow);
      return { workflow: result.workflow, validationErrors: result.validationErrors, autoFixed: result.autoFixed };
    } catch (err) {
      return reply.code(500).send({ error: 'Refinement failed', detail: String(err) });
    }
  });
}

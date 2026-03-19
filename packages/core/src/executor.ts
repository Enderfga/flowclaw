// ============================================================
// @dagflow/core — DAG Execution Engine
// ============================================================

import type {
  Workflow,
  DAGNode,
  Run,
  RunStatus,
  NodeRunState,
  NodeRunStatus,
  ExecutionEvent,
  ExecutionEventType,
  AgentProvider,
  TokenUsage,
  HumanApproval,
  CostEstimate,
  RunSummary,
} from './types.js';
import {
  validateWorkflow,
  buildReverseAdjacencyList,
  buildAdjacencyList,
} from './dag.js';
import { assembleNodeInput } from './template.js';
import { executeTool } from './tools.js';

// ---------- Node Handler Registry ----------

export type NodeHandler = (
  node: DAGNode,
  input: unknown,
  context: ExecutionContext
) => Promise<{ output: unknown; tokenUsage?: TokenUsage }>;

export interface ExecutionContext {
  run: Run;
  workflow: Workflow;
  providers: Map<string, AgentProvider>;
  emit: (event: ExecutionEvent) => void;
  /** Access completed node outputs */
  getNodeOutput: (nodeId: string) => unknown;
  /** Whether streaming is enabled for this execution */
  streaming: boolean;
}

// ---------- Default Node Handlers ----------

const builtinHandlers: Record<string, NodeHandler> = {
  input: async (_node, input) => ({ output: input }),

  output: async (_node, input) => ({ output: input }),

  merge: async (_node, input) => ({ output: input }),

  agent: async (node, input, ctx) => {
    const model = node.config.model ?? 'gpt-5.4';
    const providerName = resolveProviderName(model);
    const provider = ctx.providers.get(providerName);
    if (!provider) {
      throw new Error(`No provider registered for "${providerName}" (model: ${model})`);
    }

    const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
    const messages = [
      ...(node.config.systemPrompt
        ? [{ role: 'system' as const, content: node.config.systemPrompt }]
        : []),
      { role: 'user' as const, content: inputStr },
    ];

    const request = {
      model,
      messages,
      temperature: node.config.temperature,
      maxTokens: node.config.maxTokens,
    };

    // Use streaming if provider supports it and streaming is enabled
    if (ctx.streaming && provider.chatStream) {
      let content = '';
      let tokenUsage: TokenUsage | undefined;

      for await (const chunk of provider.chatStream(request)) {
        content += chunk.content;
        if (chunk.tokenUsage) tokenUsage = chunk.tokenUsage;

        // Emit stream event for real-time display
        ctx.emit({
          type: 'node:stream',
          runId: ctx.run.id,
          nodeId: node.id,
          timestamp: new Date().toISOString(),
          data: { chunk: chunk.content, accumulated: content, done: chunk.done },
        });
      }

      return { output: content, tokenUsage };
    }

    const response = await provider.chat(request);
    return { output: response.content, tokenUsage: response.tokenUsage };
  },

  tool: async (node, input) => {
    const tools = node.config.tools;
    if (!tools || tools.length === 0) {
      return { output: `[tool:${node.config.name}] no tools configured` };
    }

    // Execute all tools sequentially, piping output
    const results: Array<{ name: string; success: boolean; output: string; error?: string }> = [];
    let lastOutput: unknown = input;

    for (const tool of tools) {
      const result = await executeTool(tool, lastOutput);
      results.push({ name: tool.name, ...result });
      if (!result.success) break;
      lastOutput = result.output;
    }

    const allSuccess = results.every((r) => r.success);
    return {
      output: results.length === 1
        ? (allSuccess ? results[0].output : { error: results[0].error, output: results[0].output })
        : { results, success: allSuccess },
    };
  },

  condition: async (node, input) => {
    // Evaluate condition expression against input
    // Supports: "true", "false", field checks like "status === 'success'",
    // and simple contains/equals checks
    const expr = node.config.conditionExpr ?? 'true';
    const inputObj = typeof input === 'string' ? { value: input } : (input as Record<string, unknown>);
    
    let result: boolean;
    try {
      if (expr === 'true') {
        result = true;
      } else if (expr === 'false') {
        result = false;
      } else if (expr.includes('===')) {
        // Simple equality: "field === 'value'" or "field === true"
        const [lhs, rhs] = expr.split('===').map(s => s.trim());
        const lhsVal = String(getNestedValue(inputObj, lhs) ?? '');
        const rhsVal = rhs.replace(/^['"]|['"]$/g, ''); // strip quotes
        result = lhsVal === rhsVal;
      } else if (expr.includes('!==')) {
        const [lhs, rhs] = expr.split('!==').map(s => s.trim());
        const lhsVal = String(getNestedValue(inputObj, lhs) ?? '');
        const rhsVal = rhs.replace(/^['"]|['"]$/g, '');
        result = lhsVal !== rhsVal;
      } else if (expr.includes('>')) {
        const [lhs, rhs] = expr.split('>').map(s => s.trim());
        const lhsVal = Number(getNestedValue(inputObj, lhs) ?? 0);
        result = lhsVal > Number(rhs);
      } else if (expr.includes('<')) {
        const [lhs, rhs] = expr.split('<').map(s => s.trim());
        const lhsVal = Number(getNestedValue(inputObj, lhs) ?? 0);
        result = lhsVal < Number(rhs);
      } else {
        // Truthy check on a field, or string contains
        const val = getNestedValue(inputObj, expr);
        result = val !== undefined ? !!val : JSON.stringify(input).includes(expr);
      }
    } catch {
      result = true;
    }

    // Output includes both the boolean result and a "branch" field
    // Downstream edges can use edge.condition = "true" or "false" to route
    return { output: { __condition: result, branch: result ? 'true' : 'false', input } };
  },

  loop: async (node, input, ctx) => {
    const maxIter = node.config.maxIterations ?? 5;
    const exitExpr = node.config.exitCondition as string | undefined;
    const state = ctx.run.nodeStates[node.id];
    let current = input;
    let totalTokens = { prompt: 0, completion: 0 };

    const bodyModel = node.config.model ?? 'gpt-5.4';
    const bodyPrompt = node.config.systemPrompt;

    for (let i = 0; i < maxIter; i++) {
      if (state) state.iteration = i;
      ctx.emit({
        type: 'node:iteration' as any,
        runId: ctx.run.id,
        nodeId: node.id,
        timestamp: new Date().toISOString(),
        data: { iteration: i, maxIterations: maxIter },
      });

      // If we have a body prompt, execute it as an agent call
      if (bodyPrompt) {
        const providerName = resolveProviderName(bodyModel);
        const provider = ctx.providers.get(providerName);
        if (provider) {
          const inputStr = typeof current === 'string' ? current : JSON.stringify(current);
          const iterPrompt = bodyPrompt.replace('{{iteration}}', String(i))
            .replace('{{maxIterations}}', String(maxIter));
          const response = await provider.chat({
            model: bodyModel,
            messages: [
              { role: 'system', content: iterPrompt },
              { role: 'user', content: inputStr },
            ],
            temperature: node.config.temperature,
          });
          current = response.content;
          if (response.tokenUsage) {
            totalTokens.prompt += response.tokenUsage.prompt;
            totalTokens.completion += response.tokenUsage.completion;
          }
        }
      } else {
        current = typeof current === 'object'
          ? { ...(current as Record<string, unknown>), __iteration: i }
          : current;
      }

      // Check exit condition
      if (exitExpr) {
        // Try to parse JSON if current is a string
        let currentObj: Record<string, unknown>;
        if (typeof current === 'string') {
          try {
            const parsed = JSON.parse(current);
            currentObj = typeof parsed === 'object' && parsed !== null ? parsed : { value: current };
          } catch {
            currentObj = { value: current };
          }
        } else {
          currentObj = current as Record<string, unknown>;
        }
        // Check for exit: literal 'true', __done flag, or expression evaluation
        if (exitExpr === 'true' || currentObj.__done === true || getNestedValue(currentObj, exitExpr) === true) {
          break;
        }
      }
    }

    return { output: current, tokenUsage: totalTokens.prompt > 0 ? totalTokens : undefined };
  },

  human: async (node, input, ctx) => {
    // Human-in-the-loop: pause execution and wait for approval
    const state = ctx.run.nodeStates[node.id];
    
    // Check if already approved (resuming from paused state)
    if (state.approval?.status === 'approved') {
      return { output: state.approval.data ?? input };
    }
    if (state.approval?.status === 'rejected') {
      throw new Error(`Human review rejected: ${state.approval.comment ?? 'No reason given'}`);
    }

    // Pause: set approval to pending and throw a special error
    state.approval = { status: 'pending' };
    state.status = 'paused';
    
    ctx.emit({
      type: 'node:paused' as any,
      runId: ctx.run.id,
      nodeId: node.id,
      timestamp: new Date().toISOString(),
      data: { waitingForHuman: true, input, prompt: node.config.systemPrompt ?? 'Awaiting human approval' },
    });

    // Throw a sentinel error that the executor will catch to pause the run
    throw new HumanPauseError(node.id);
  },

  planner: async (node, input, ctx) => {
    // Planner generates a sub-DAG from natural language
    // Delegates to an agent provider
    const model = node.config.model ?? 'gpt-5.4';
    const providerName = resolveProviderName(model);
    const provider = ctx.providers.get(providerName);
    if (!provider) {
      throw new Error(`No provider for planner: ${providerName}`);
    }

    const plannerPrompt = node.config.systemPrompt ??
      'You are a workflow planner. Given a task description, output a valid DAG workflow in JSON format.';

    const response = await provider.chat({
      model,
      messages: [
        { role: 'system', content: plannerPrompt },
        { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
      ],
      temperature: node.config.temperature ?? 0.3,
    });

    return { output: response.content, tokenUsage: response.tokenUsage };
  },

  subworkflow: async (node, input, ctx) => {
    // Execute a nested workflow as a single node
    const subWf = node.config.subWorkflow as Workflow | undefined;
    if (!subWf) {
      throw new Error(`Subworkflow node "${node.id}" has no subWorkflow defined`);
    }

    // Create a child executor sharing the same providers
    const childExecutor = new DAGExecutor({
      maxConcurrency: 10,
      providers: ctx.providers,
      onEvent: (event) => {
        // Re-emit child events with prefixed nodeId for tracking
        ctx.emit({
          ...event,
          nodeId: event.nodeId ? `${node.id}/${event.nodeId}` : node.id,
          data: { ...((event.data as Record<string, unknown>) ?? {}), parentNode: node.id },
        });
      },
    });

    const childRun = await childExecutor.execute(subWf, input);

    if (childRun.status === 'failed') {
      const failedNodes = Object.entries(childRun.nodeStates)
        .filter(([, s]) => s.status === 'failed')
        .map(([id, s]) => `${id}: ${s.error}`);
      throw new Error(`Subworkflow failed: ${failedNodes.join('; ')}`);
    }

    // Find output node(s) and return their result
    const outputNodes = subWf.nodes.filter(n => n.type === 'output');
    if (outputNodes.length === 1) {
      return {
        output: childRun.nodeStates[outputNodes[0].id]?.output,
        tokenUsage: childRun.totalTokenUsage,
      };
    }

    // Multiple outputs or no explicit output: return all completed outputs
    const outputs: Record<string, unknown> = {};
    for (const [nodeId, state] of Object.entries(childRun.nodeStates)) {
      if (state.status === 'completed') {
        outputs[nodeId] = state.output;
      }
    }
    return { output: outputs, tokenUsage: childRun.totalTokenUsage };
  },
};


// ---------- Human Pause Error ----------

export class HumanPauseError extends Error {
  public readonly nodeId: string;
  constructor(nodeId: string) {
    super(`Human approval required at node: ${nodeId}`);
    this.name = 'HumanPauseError';
    this.nodeId = nodeId;
  }
}

export class BreakpointPauseError extends Error {
  public readonly nodeId: string;
  constructor(nodeId: string) {
    super(`Breakpoint hit at node: ${nodeId}`);
    this.name = 'BreakpointPauseError';
    this.nodeId = nodeId;
  }
}

// ---------- Run Summary Helper ----------

export function summarizeRun(run: Run, workflowName: string): RunSummary {
  let completed = 0, failed = 0, skipped = 0;
  for (const state of Object.values(run.nodeStates)) {
    if (state.status === 'completed') completed++;
    else if (state.status === 'failed') failed++;
    else if (state.status === 'skipped') skipped++;
  }
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    totalTokenUsage: run.totalTokenUsage,
    cost: run.cost,
    nodeCount: Object.keys(run.nodeStates).length,
    nodeSummary: { completed, failed, skipped },
  };
}

// ---------- Helpers ----------

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((curr, key) => {
    if (curr && typeof curr === 'object' && key in (curr as Record<string, unknown>)) {
      return (curr as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ---------- Cost Estimation ----------

// Approximate pricing per 1M tokens (USD) — updated periodically
const MODEL_PRICING: Record<string, { promptPer1M: number; completionPer1M: number }> = {
  'gpt-5.4': { promptPer1M: 2.5, completionPer1M: 10 },
  'gpt-5.4-mini': { promptPer1M: 0.15, completionPer1M: 0.6 },
  'gpt-4-turbo': { promptPer1M: 10, completionPer1M: 30 },
  'claude-sonnet-4-6': { promptPer1M: 3, completionPer1M: 15 },
  'claude-opus-4-6': { promptPer1M: 15, completionPer1M: 75 },
  'claude-haiku-3.5': { promptPer1M: 0.8, completionPer1M: 4 },
  'gemini-3-pro-preview': { promptPer1M: 1.25, completionPer1M: 5 },
  'gemini-3-flash-preview': { promptPer1M: 0.075, completionPer1M: 0.3 },
};

export function estimateCost(run: Run, workflow: Workflow): CostEstimate {
  const perNode: CostEstimate['perNode'] = {};
  let totalUsd = 0;

  for (const node of workflow.nodes) {
    const state = run.nodeStates[node.id];
    if (!state?.tokenUsage) continue;

    const model = node.config.model ?? 'gpt-5.4';
    const pricing = MODEL_PRICING[model] ?? { promptPer1M: 2.5, completionPer1M: 10 };
    const cost =
      (state.tokenUsage.prompt / 1_000_000) * pricing.promptPer1M +
      (state.tokenUsage.completion / 1_000_000) * pricing.completionPer1M;

    perNode[node.id] = {
      model,
      promptTokens: state.tokenUsage.prompt,
      completionTokens: state.tokenUsage.completion,
      costUsd: Math.round(cost * 1_000_000) / 1_000_000, // 6 decimal places
    };
    totalUsd += cost;
  }

  return {
    totalUsd: Math.round(totalUsd * 1_000_000) / 1_000_000,
    perNode,
  };
}

// ---------- Provider Resolution ----------

function resolveProviderName(model: string): string {
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('claude-')) return 'claude';
  if (model.startsWith('gemini-')) return 'gemini';
  // Default: use the model string as provider name
  return model.split('/')[0] ?? 'openai';
}

// ---------- Executor ----------

export interface ExecutorOptions {
  maxConcurrency?: number;
  handlers?: Record<string, NodeHandler>;
  providers?: Map<string, AgentProvider>;
  onEvent?: (event: ExecutionEvent) => void;
  /** Enable streaming for agent nodes — emits node:stream events with partial content */
  streaming?: boolean;
  /** Node IDs to pause at before execution (breakpoints) */
  breakpoints?: Set<string>;
}

export class DAGExecutor {
  private handlers: Record<string, NodeHandler>;
  private providers: Map<string, AgentProvider>;
  private maxConcurrency: number;
  private onEvent: (event: ExecutionEvent) => void;
  private streaming: boolean;
  private breakpoints: Set<string>;

  constructor(options: ExecutorOptions = {}) {
    this.handlers = { ...builtinHandlers, ...options.handlers };
    this.providers = options.providers ?? new Map();
    this.maxConcurrency = options.maxConcurrency ?? 10;
    this.onEvent = options.onEvent ?? (() => {});
    this.streaming = options.streaming ?? false;
    this.breakpoints = options.breakpoints ?? new Set();
  }

  /** Add a breakpoint on a node */
  addBreakpoint(nodeId: string): void { this.breakpoints.add(nodeId); }
  /** Remove a breakpoint from a node */
  removeBreakpoint(nodeId: string): void { this.breakpoints.delete(nodeId); }
  /** Get all active breakpoints */
  getBreakpoints(): string[] { return [...this.breakpoints]; }

  /**
   * Resume from a breakpoint: optionally inject modified input, then continue.
   */
  async resumeBreakpoint(
    workflow: Workflow,
    run: Run,
    nodeId: string,
    modifiedInput?: unknown
  ): Promise<Run> {
    const state = run.nodeStates[nodeId];
    if (!state || state.status !== 'breakpoint') {
      throw new Error(`Node ${nodeId} is not at a breakpoint`);
    }

    // Apply modified input if provided
    if (modifiedInput !== undefined && state.breakpointData) {
      state.breakpointData.modifiedInput = modifiedInput;
    }

    // Mark as ready to run — the BFS will pick it up
    state.status = 'running';
    run.breakpoints = (run.breakpoints ?? []).filter(id => id !== nodeId);

    this.emit(run, 'node:resumed' as ExecutionEventType, nodeId, { modifiedInput });

    // Remove the breakpoint so it doesn't trigger again on resume
    this.breakpoints.delete(nodeId);

    // Continue execution
    if (run.breakpoints?.length === 0 || !run.breakpoints) {
      run.status = 'running';

      const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));
      const reverse = buildReverseAdjacencyList(workflow.nodes, workflow.edges);
      const forward = buildAdjacencyList(workflow.nodes, workflow.edges);
      const edgesByTarget = new Map<string, Map<string, string | undefined>>();
      for (const edge of workflow.edges) {
        if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, new Map());
        edgesByTarget.get(edge.target)!.set(edge.source, edge.transform);
      }

      const ctx: ExecutionContext = {
        run,
        workflow,
        providers: this.providers,
        emit: (event) => this.onEvent(event),
        getNodeOutput: (nid: string) => run.nodeStates[nid]?.output,
        streaming: this.streaming,
      };

      // The breakpoint node needs to actually execute now
      const node = nodeMap.get(nodeId)!;
      const nodeInput = modifiedInput ?? state.breakpointData?.input ?? state.input;
      
      try {
        const result = await this.executeNodeWithRetry(node, nodeInput, ctx);
        state.status = 'completed';
        state.output = result.output;
        state.tokenUsage = result.tokenUsage;
        state.completedAt = new Date().toISOString();
        state.breakpointData = undefined;
        this.emit(run, 'node:complete', nodeId, { output: result.output });
      } catch (error) {
        if (error instanceof HumanPauseError) {
          throw error;
        }
        state.status = 'failed';
        state.error = String(error);
        state.completedAt = new Date().toISOString();
        this.emit(run, 'node:fail', nodeId, { error: state.error });
      }

      // Continue with remaining nodes
      try {
        await this.executeBFS(run, workflow, nodeMap, reverse, forward, edgesByTarget, run.input, ctx);
        run.status = 'completed';
        this.emit(run, 'run:complete');
      } catch (error) {
        if (error instanceof HumanPauseError) {
          run.status = 'paused';
          run.pausedNodes = run.pausedNodes ?? [];
          if (!run.pausedNodes.includes(error.nodeId)) run.pausedNodes.push(error.nodeId);
        } else if (error instanceof BreakpointPauseError) {
          run.status = 'paused';
          run.breakpoints = run.breakpoints ?? [];
          if (!run.breakpoints.includes(error.nodeId)) run.breakpoints.push(error.nodeId);
        } else {
          run.status = 'failed';
          this.emit(run, 'run:fail', undefined, { error: String(error) });
        }
      }

      run.completedAt = new Date().toISOString();
      run.totalTokenUsage = { prompt: 0, completion: 0 };
      for (const s of Object.values(run.nodeStates)) {
        if (s.tokenUsage) {
          run.totalTokenUsage.prompt += s.tokenUsage.prompt;
          run.totalTokenUsage.completion += s.tokenUsage.completion;
        }
      }
      run.cost = estimateCost(run, workflow);
    }

    return run;
  }

  /**
   * Resume a paused run after human approval/rejection.
   */
  async resume(
    workflow: Workflow,
    run: Run,
    nodeId: string,
    approval: HumanApproval
  ): Promise<Run> {
    const state = run.nodeStates[nodeId];
    if (!state || state.status !== 'paused') {
      throw new Error(`Node ${nodeId} is not paused`);
    }

    // Apply approval
    state.approval = approval;
    run.pausedNodes = (run.pausedNodes ?? []).filter(id => id !== nodeId);

    if (approval.status === 'approved') {
      state.status = 'completed';
      state.output = approval.data ?? state.input;
      state.completedAt = new Date().toISOString();
      this.emit(run, 'node:complete', nodeId, { output: state.output });
    } else {
      state.status = 'failed';
      state.error = `Rejected: ${approval.comment ?? 'No reason'}`;
      state.completedAt = new Date().toISOString();
      this.emit(run, 'node:fail', nodeId, { error: state.error });
    }

    // If no more paused nodes, resume execution
    if (run.pausedNodes.length === 0 && approval.status === 'approved') {
      run.status = 'running';

      // Re-run BFS — already-completed nodes won't re-execute
      const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));
      const reverse = buildReverseAdjacencyList(workflow.nodes, workflow.edges);
      const forward = buildAdjacencyList(workflow.nodes, workflow.edges);
      const edgesByTarget = new Map<string, Map<string, string | undefined>>();
      for (const edge of workflow.edges) {
        if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, new Map());
        edgesByTarget.get(edge.target)!.set(edge.source, edge.transform);
      }

      const ctx: ExecutionContext = {
        run,
        workflow,
        providers: this.providers,
        emit: (event) => this.onEvent(event),
        getNodeOutput: (nid: string) => run.nodeStates[nid]?.output,
        streaming: this.streaming,
      };

      try {
        await this.executeBFS(run, workflow, nodeMap, reverse, forward, edgesByTarget, run.input, ctx);
        run.status = 'completed';
        this.emit(run, 'run:complete');
      } catch (error) {
        if (error instanceof HumanPauseError) {
          run.status = 'paused';
          run.pausedNodes = run.pausedNodes ?? [];
          if (!run.pausedNodes.includes(error.nodeId)) run.pausedNodes.push(error.nodeId);
        } else {
          run.status = 'failed';
          this.emit(run, 'run:fail', undefined, { error: String(error) });
        }
      }

      run.completedAt = new Date().toISOString();
    }

    return run;
  }

    /**
   * Execute a workflow with the given input.
   */
  async execute(workflow: Workflow, input: unknown): Promise<Run> {
    // 1. Validate
    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      throw new Error(
        `Invalid workflow: ${validation.errors.map((e) => e.message).join('; ')}`
      );
    }

    // 2. Initialize run
    const run: Run = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      status: 'running',
      input,
      nodeStates: {},
      startedAt: new Date().toISOString(),
      variables: workflow.variables as Record<string, unknown> | undefined,
    };

    for (const node of workflow.nodes) {
      run.nodeStates[node.id] = { status: 'waiting' };
    }

    this.emit(run, 'run:start');

    // 3. Build graph structures
    const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));
    const reverse = buildReverseAdjacencyList(workflow.nodes, workflow.edges);
    const forward = buildAdjacencyList(workflow.nodes, workflow.edges);

    // 4. Build edge info for transforms
    const edgesByTarget = new Map<string, Map<string, string | undefined>>();
    for (const edge of workflow.edges) {
      if (!edgesByTarget.has(edge.target)) {
        edgesByTarget.set(edge.target, new Map());
      }
      edgesByTarget.get(edge.target)!.set(edge.source, edge.transform);
    }

    // 5. Execution context
    const ctx: ExecutionContext = {
      run,
      workflow,
      providers: this.providers,
      emit: (event) => this.onEvent(event),
      getNodeOutput: (nodeId: string) => run.nodeStates[nodeId]?.output,
      streaming: this.streaming,
    };

    // 6. Merge global variables into the run
    run.variables = { ...(workflow.variables ?? {}) };

    // 7. Set breakpoints on the run
    if (this.breakpoints.size > 0) {
      run.breakpoints = [...this.breakpoints];
    }

    // 8. Execute using BFS with concurrency control
    try {
      await this.executeBFS(run, workflow, nodeMap, reverse, forward, edgesByTarget, input, ctx);
      run.status = 'completed';
      this.emit(run, 'run:complete');
    } catch (error) {
      if (error instanceof HumanPauseError) {
        run.status = 'paused';
        run.pausedNodes = run.pausedNodes ?? [];
        if (!run.pausedNodes.includes(error.nodeId)) {
          run.pausedNodes.push(error.nodeId);
        }
      } else if (error instanceof BreakpointPauseError) {
        run.status = 'paused';
        // breakpoints already tracked on the run object
      } else {
        run.status = 'failed';
        this.emit(run, 'run:fail', undefined, { error: String(error) });
      }
    }

    run.completedAt = new Date().toISOString();

    // Aggregate token usage
    run.totalTokenUsage = { prompt: 0, completion: 0 };
    for (const state of Object.values(run.nodeStates)) {
      if (state.tokenUsage) {
        run.totalTokenUsage.prompt += state.tokenUsage.prompt;
        run.totalTokenUsage.completion += state.tokenUsage.completion;
      }
    }

    // Estimate cost
    run.cost = estimateCost(run, workflow);

    return run;
  }

  private async executeBFS(
    run: Run,
    workflow: Workflow,
    nodeMap: Map<string, DAGNode>,
    reverse: Map<string, string[]>,
    forward: Map<string, string[]>,
    edgesByTarget: Map<string, Map<string, string | undefined>>,
    workflowInput: unknown,
    ctx: ExecutionContext
  ): Promise<void> {
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Set<string>();

    const isReady = (nodeId: string): boolean => {
      const preds = reverse.get(nodeId) ?? [];
      // A node is ready if all predecessors are done (completed/failed/skipped)
      // Actual skip logic is handled by shouldSkip
      return preds.every((p) => completed.has(p) || failed.has(p) || paused.has(p));
    };

    // Build edge lookup for condition-based routing
    const edgeList = workflow.edges;
    const incomingEdges = new Map<string, typeof edgeList>();
    for (const edge of edgeList) {
      if (!incomingEdges.has(edge.target)) incomingEdges.set(edge.target, []);
      incomingEdges.get(edge.target)!.push(edge);
    }

    const shouldSkip = (nodeId: string): boolean => {
      const incoming = incomingEdges.get(nodeId) ?? [];
      // If any incoming edge has a condition, check if the source condition node's
      // output branch matches the edge condition
      for (const edge of incoming) {
        if (edge.condition) {
          const sourceOutput = run.nodeStates[edge.source]?.output;
          if (sourceOutput && typeof sourceOutput === 'object' && '__condition' in (sourceOutput as any)) {
            const branch = (sourceOutput as any).branch;
            if (branch !== edge.condition) {
              return true; // This branch is not taken
            }
          }
        }
        // If source failed or is paused, skip downstream (unless it's a condition branch)
        if ((failed.has(edge.source) || paused.has(edge.source)) && !edge.condition) {
          return true;
        }
      }
      return false;
    };

    const paused = new Set<string>();
    while (completed.size + failed.size + paused.size < workflow.nodes.length) {
      // Find all ready nodes
      const readyNodes: string[] = [];
      for (const node of workflow.nodes) {
        const id = node.id;
        if (completed.has(id) || failed.has(id) || running.has(id)) continue;
        if (isReady(id)) readyNodes.push(id);
      }

      if (readyNodes.length === 0 && running.size === 0) {
        // No more work — either paused or deadlock
        if (paused.size > 0) {
          // Paused due to human nodes — exit gracefully
          throw new HumanPauseError([...paused][0]);
        }
        // True deadlock — shouldn't happen with valid DAG
        throw new Error('Execution deadlock: no ready nodes and nothing running');
      }

      if (readyNodes.length === 0) {
        // Wait for running nodes (shouldn't reach here with Promise.all below)
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      // Execute ready nodes with concurrency limit
      const batch = readyNodes.slice(0, this.maxConcurrency - running.size);

      const promises = batch.map(async (nodeId) => {
        const node = nodeMap.get(nodeId)!;

        if (shouldSkip(nodeId)) {
          run.nodeStates[nodeId].status = 'skipped';
          this.emit(run, 'node:skip', nodeId);
          failed.add(nodeId); // treat skipped as "not completed" for downstream
          return;
        }

        // --- Breakpoint check: pause BEFORE executing ---
        if (this.breakpoints.has(nodeId) && run.nodeStates[nodeId].status !== 'breakpoint') {
          const bpInput = this.assembleInput(node, reverse, edgesByTarget, run, workflowInput);
          run.nodeStates[nodeId].status = 'breakpoint';
          run.nodeStates[nodeId].input = bpInput;
          run.nodeStates[nodeId].breakpointData = { input: bpInput };
          run.breakpoints = run.breakpoints ?? [];
          if (!run.breakpoints.includes(nodeId)) run.breakpoints.push(nodeId);
          this.emit(run, 'node:breakpoint' as ExecutionEventType, nodeId, { input: bpInput });
          throw new BreakpointPauseError(nodeId);
        }

        // Skip already-completed nodes (from resume)
        if (run.nodeStates[nodeId].status === 'completed') {
          completed.add(nodeId);
          return;
        }

        running.add(nodeId);
        run.nodeStates[nodeId].status = 'running';
        run.nodeStates[nodeId].startedAt = new Date().toISOString();
        this.emit(run, 'node:start', nodeId);

        try {
          // Assemble input
          const nodeInput = this.assembleInput(
            node,
            reverse,
            edgesByTarget,
            run,
            workflowInput
          );

          // Execute with retry
          const result = await this.executeNodeWithRetry(node, nodeInput, ctx);

          run.nodeStates[nodeId].status = 'completed';
          run.nodeStates[nodeId].output = result.output;
          run.nodeStates[nodeId].tokenUsage = result.tokenUsage;
          run.nodeStates[nodeId].completedAt = new Date().toISOString();
          this.emit(run, 'node:complete', nodeId, { output: result.output });

          completed.add(nodeId);
        } catch (error) {
          if (error instanceof HumanPauseError) {
            // Don't mark as failed — the handler already set status to 'paused'
            throw error; // Re-throw to break out of BFS loop
          }
          if (error instanceof BreakpointPauseError) {
            throw error;
          }
          run.nodeStates[nodeId].status = 'failed';
          run.nodeStates[nodeId].error = String(error);
          run.nodeStates[nodeId].completedAt = new Date().toISOString();
          this.emit(run, 'node:fail', nodeId, { error: String(error) });

          failed.add(nodeId);
        } finally {
          running.delete(nodeId);
        }
      });

      // Use allSettled so HumanPauseError/BreakpointPauseError doesn't swallow other batch results
      const results = await Promise.allSettled(promises);
      const pauseError = results.find(
        r => r.status === 'rejected' && (r.reason instanceof HumanPauseError || r.reason instanceof BreakpointPauseError)
      );
      if (pauseError) {
        throw (pauseError as PromiseRejectedResult).reason;
      }
    }

    // Check if any critical node failed
    if (failed.size > 0) {
      const failedNodes = [...failed].filter(
        (id) => run.nodeStates[id].status === 'failed'
      );
      if (failedNodes.length > 0) {
        throw new Error(
          `Nodes failed: ${failedNodes.join(', ')}`
        );
      }
    }
  }

  private assembleInput(
    node: DAGNode,
    reverse: Map<string, string[]>,
    edgesByTarget: Map<string, Map<string, string | undefined>>,
    run: Run,
    workflowInput: unknown
  ): unknown {
    const predecessors = reverse.get(node.id) ?? [];

    // Input nodes get the workflow input
    if (node.type === 'input' || predecessors.length === 0) {
      return workflowInput;
    }

    // Collect upstream outputs
    const upstreamOutputs: Record<string, unknown> = {};
    const edgeTransforms: Record<string, string> = {};

    for (const predId of predecessors) {
      upstreamOutputs[predId] = run.nodeStates[predId]?.output;
      const transform = edgesByTarget.get(node.id)?.get(predId);
      if (transform) edgeTransforms[predId] = transform;
    }

    // When a node has an inputTemplate, also include ALL completed node outputs
    // so templates can reference any node (not just direct predecessors)
    if (node.config.inputTemplate) {
      for (const [nodeId, state] of Object.entries(run.nodeStates)) {
        if (nodeId !== node.id && state.status === 'completed' && !(nodeId in upstreamOutputs)) {
          upstreamOutputs[nodeId] = state.output;
        }
      }
    }

    return assembleNodeInput(
      node.config.inputTemplate,
      upstreamOutputs,
      Object.keys(edgeTransforms).length > 0 ? edgeTransforms : undefined,
      (run.variables ?? {}) as Record<string, unknown>
    );
  }

  private async executeNodeWithRetry(
    node: DAGNode,
    input: unknown,
    ctx: ExecutionContext
  ): Promise<{ output: unknown; tokenUsage?: TokenUsage }> {
    const handler = this.handlers[node.type];
    if (!handler) {
      throw new Error(`No handler for node type: ${node.type}`);
    }

    const retryPolicy = node.config.retryPolicy ?? { maxRetries: 0, backoffMs: 1000 };
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
      try {
        return await handler(node, input, ctx);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retryPolicy.maxRetries) {
          await new Promise((r) =>
            setTimeout(r, retryPolicy.backoffMs * Math.pow(2, attempt))
          );
        }
      }
    }

    throw lastError;
  }

  private emit(
    run: Run,
    type: ExecutionEventType,
    nodeId?: string,
    data?: unknown
  ): void {
    this.onEvent({
      type,
      runId: run.id,
      nodeId,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}

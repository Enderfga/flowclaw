// ============================================================
// @dagflow/core — Core Type Definitions
// ============================================================

/** JSON Schema subset for input/output validation */
export type JSONSchema = Record<string, unknown>;

// ---------- Tool Config ----------

export interface ToolConfig {
  name: string;
  description?: string;
  /** shell | http | function */
  type: 'shell' | 'http' | 'function';
  config: Record<string, unknown>;
}

// ---------- Retry ----------

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
}

// ---------- Node ----------

export type NodeType =
  | 'input'
  | 'output'
  | 'agent'
  | 'tool'
  | 'condition'
  | 'merge'
  | 'loop'
  | 'human'
  | 'planner'
  | 'subworkflow';

export interface NodeConfig {
  name: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolConfig[];
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
  /** Template for input assembly. Use {{nodeId.output}} syntax. */
  inputTemplate?: string;
  retryPolicy?: RetryPolicy;
  /** For condition nodes: expression evaluated against upstream output */
  conditionExpr?: string;
  /** For loop nodes: max iterations */
  maxIterations?: number;
  /** For loop nodes: exit condition expression */
  exitCondition?: string;
  /** For subworkflow nodes: inline child workflow definition */
  subWorkflow?: Workflow;
  /** Arbitrary extra config per node type */
  [key: string]: unknown;
}

export interface DAGNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  config: NodeConfig;
}

// ---------- Edge ----------

export interface DAGEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  /** Condition expression — edge only active when truthy */
  condition?: string;
  /** Data transform (jq/template) applied to source output before delivery */
  transform?: string;
}

// ---------- Workflow ----------

export interface WorkflowMetadata {
  created: string;
  updated: string;
  version: string;
  description?: string;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: DAGNode[];
  edges: DAGEdge[];
  variables?: Record<string, unknown>;
  metadata: WorkflowMetadata;
}

// ---------- Run ----------

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
export type NodeRunStatus = 'waiting' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused' | 'breakpoint';

export interface TokenUsage {
  prompt: number;
  completion: number;
}

export interface NodeRunState {
  status: NodeRunStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  tokenUsage?: TokenUsage;
  /** For loop nodes: current iteration index */
  iteration?: number;
  /** For human nodes: approval data */
  approval?: HumanApproval;
  /** Breakpoint: snapshot of input available for inspection/modification */
  breakpointData?: { input: unknown; modifiedInput?: unknown };
}

// ---------- Human-in-the-loop ----------

export interface HumanApproval {
  status: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  approvedAt?: string;
  comment?: string;
  data?: unknown;
}

export interface Run {
  id: string;
  workflowId: string;
  status: RunStatus;
  input: unknown;
  nodeStates: Record<string, NodeRunState>;
  startedAt: string;
  completedAt?: string;
  totalTokenUsage?: TokenUsage;
  /** Global variables available to all nodes via {{$var.name}} */
  variables?: Record<string, unknown>;
  /** Nodes waiting for human approval */
  pausedNodes?: string[];
  /** Cost estimate for the run */
  cost?: CostEstimate;
  /** Node IDs with active breakpoints */
  breakpoints?: string[];
}

// ---------- Execution History ----------

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  totalTokenUsage?: TokenUsage;
  cost?: CostEstimate;
  nodeCount: number;
  /** Counts by status: completed, failed, skipped */
  nodeSummary: { completed: number; failed: number; skipped: number };
}

// ---------- Events ----------

export type ExecutionEventType =
  | 'run:start'
  | 'run:complete'
  | 'run:fail'
  | 'node:ready'
  | 'node:start'
  | 'node:complete'
  | 'node:fail'
  | 'node:skip'
  | 'node:paused'
  | 'node:resumed'
  | 'node:iteration'
  | 'node:stream'
  | 'node:breakpoint'
  | 'run:paused'
  | 'run:resumed';

export interface ExecutionEvent {
  type: ExecutionEventType;
  runId: string;
  nodeId?: string;
  timestamp: string;
  data?: unknown;
}

// ---------- Provider ----------

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolConfig[];
}

export interface ProviderResponse {
  content: string;
  tokenUsage: TokenUsage;
  model: string;
  finishReason?: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  tokenUsage?: TokenUsage;
}

export interface AgentProvider {
  name: string;
  chat(request: ProviderRequest): Promise<ProviderResponse>;
  /** Stream chat completion — yields content chunks. Optional. */
  chatStream?(request: ProviderRequest): AsyncIterable<StreamChunk>;
}

// ---------- Cost Tracking ----------

export interface CostEstimate {
  /** Total estimated cost in USD */
  totalUsd: number;
  /** Per-node cost breakdown */
  perNode: Record<string, { model: string; promptTokens: number; completionTokens: number; costUsd: number }>;
}

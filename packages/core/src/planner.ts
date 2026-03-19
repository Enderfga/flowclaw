// ============================================================
// @council/core — AI Planner: Natural Language → DAG
// ============================================================

import type {
  Workflow,
  DAGNode,
  DAGEdge,
  AgentProvider,
  NodeType,
} from './types.js';
import { validateWorkflow, topologicalSort } from './dag.js';

// ---------- Planner Prompt ----------

const PLANNER_SYSTEM_PROMPT = `You are an expert workflow planner. Your job is to convert a natural language task description into a valid DAG (Directed Acyclic Graph) workflow definition.

## Output Format

You MUST output a valid JSON object with this exact structure:
\`\`\`json
{
  "name": "Workflow Name",
  "description": "Brief description",
  "nodes": [
    {
      "id": "unique-id",
      "type": "input|output|agent|tool|condition|merge|loop|human|planner",
      "position": { "x": number, "y": number },
      "config": {
        "name": "Human-readable name",
        "systemPrompt": "Prompt for agent nodes",
        "model": "model-name",
        "inputTemplate": "Template using {{nodeId.output}}"
      }
    }
  ],
  "edges": [
    {
      "id": "edge-id",
      "source": "source-node-id",
      "target": "target-node-id"
    }
  ]
}
\`\`\`

## Node Types

- **input**: Entry point. Every workflow MUST have exactly one. It receives the user's initial input.
- **output**: Exit point. Every workflow MUST have exactly one. It produces the final result.
- **agent**: An LLM agent that processes input and produces output. Specify model and systemPrompt.
- **tool**: Executes external tools (shell commands, HTTP calls). Use for non-AI tasks.
- **condition**: Routes data based on conditions. Has conditionExpr in config.
- **merge**: Combines outputs from multiple parallel branches into one.
- **loop**: Iterates until a condition is met. Has maxIterations and exitCondition.
- **human**: Pauses for human approval/input before continuing.
- **planner**: Meta-node that generates sub-workflows (advanced, rarely needed).

## Layout Rules

- Position nodes left-to-right or top-to-bottom
- Input node at top (y: 0), output at bottom
- Parallel branches at same y level, spaced horizontally
- Typical x spacing: 250px, y spacing: 150px

## Design Principles

1. **Start with input, end with output** — always
2. **Maximize parallelism** — if tasks are independent, run them in parallel (same level, separate branches merging later)
3. **Be specific** — each agent node should have a clear, focused systemPrompt
4. **Use merge wisely** — when parallel branches need to combine before downstream processing
5. **Keep it minimal** — don't add unnecessary nodes. Simpler is better.
6. **Model selection** — default to "gemini-3.1-flash" for all agent nodes
7. **Template references** — use {{nodeId.output}} in inputTemplate to reference upstream outputs
8. **No cycles** — this is a DAG, never create circular dependencies

## Examples

### Simple: "Translate text to French and Spanish"
- input → [agent-french, agent-spanish] (parallel) → merge → output

### Complex: "Review code, run tests, and decide to deploy"  
- input → [agent-review, tool-test] (parallel) → merge → condition (pass/fail) → [agent-deploy | agent-fix] → output

Output ONLY the JSON object. No markdown fences, no explanation.`;

// ---------- Planner Interface ----------

export interface PlannerOptions {
  /** Provider to use for planning */
  provider: AgentProvider;
  /** Model to use (default: gemini-3.1-flash) */
  model?: string;
  /** Temperature (default: 0.2 for deterministic planning) */
  temperature?: number;
  /** Max tokens for response */
  maxTokens?: number;
  /** Additional context to include in the prompt */
  additionalContext?: string;
}

export interface PlannerResult {
  workflow: Workflow;
  raw: string;
  validationErrors: string[];
  autoFixed: boolean;
}

// ---------- Planner ----------

/**
 * Generate a DAG workflow from a natural language description.
 */
export async function planWorkflow(
  taskDescription: string,
  options: PlannerOptions
): Promise<PlannerResult> {
  const model = options.model ?? 'gemini-3.1-flash';

  const userPrompt = options.additionalContext
    ? `${taskDescription}\n\nAdditional context:\n${options.additionalContext}`
    : taskDescription;

  const response = await options.provider.chat({
    model,
    messages: [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? 8192,
  });

  const raw = response.content;

  // Parse JSON from response (handle markdown fences if present)
  const parsed = parseWorkflowJSON(raw);

  // Build workflow object
  const workflow: Workflow = {
    id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: parsed.name ?? 'AI-Generated Workflow',
    nodes: parsed.nodes ?? [],
    edges: parsed.edges ?? [],
    variables: {},
    metadata: {
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      version: '1.0.0',
      description: parsed.description ?? taskDescription,
    },
  };

  // Validate and auto-fix
  const { workflow: fixed, errors, wasFixed } = autoFixWorkflow(workflow);

  return {
    workflow: fixed,
    raw,
    validationErrors: errors,
    autoFixed: wasFixed,
  };
}

// ---------- JSON Parsing ----------

function parseWorkflowJSON(raw: string): Record<string, any> {
  // Try direct parse first
  try {
    return JSON.parse(raw);
  } catch {
    // noop
  }

  // Extract from markdown code fence
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // noop
    }
  }

  // Try to find JSON object in the text
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // noop
    }
  }

  throw new Error(`Failed to parse planner output as JSON. Raw output:\n${raw.slice(0, 500)}`);
}

// ---------- Auto-Fix (T3.3) ----------

/**
 * Validate and auto-fix common issues in AI-generated workflows.
 */
export function autoFixWorkflow(workflow: Workflow): {
  workflow: Workflow;
  errors: string[];
  wasFixed: boolean;
} {
  let wasFixed = false;
  const errors: string[] = [];
  const w = structuredClone(workflow);

  // 1. Ensure all nodes have valid IDs
  const usedIds = new Set<string>();
  for (const node of w.nodes) {
    if (!node.id || usedIds.has(node.id)) {
      const oldId = node.id;
      node.id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // Update edge references
      for (const edge of w.edges) {
        if (edge.source === oldId) edge.source = node.id;
        if (edge.target === oldId) edge.target = node.id;
      }
      wasFixed = true;
    }
    usedIds.add(node.id);
  }

  // 2. Ensure all edges have valid IDs
  const usedEdgeIds = new Set<string>();
  for (const edge of w.edges) {
    if (!edge.id || usedEdgeIds.has(edge.id)) {
      edge.id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      wasFixed = true;
    }
    usedEdgeIds.add(edge.id);
  }

  // 3. Remove edges referencing non-existent nodes
  const nodeIds = new Set(w.nodes.map((n) => n.id));
  const originalEdgeCount = w.edges.length;
  w.edges = w.edges.filter((e) => {
    const valid = nodeIds.has(e.source) && nodeIds.has(e.target);
    if (!valid) errors.push(`Removed invalid edge ${e.id}: ${e.source} → ${e.target}`);
    return valid;
  });
  if (w.edges.length !== originalEdgeCount) wasFixed = true;

  // 4. Remove self-loops
  const preLoopCount = w.edges.length;
  w.edges = w.edges.filter((e) => {
    if (e.source === e.target) {
      errors.push(`Removed self-loop on node ${e.source}`);
      return false;
    }
    return true;
  });
  if (w.edges.length !== preLoopCount) wasFixed = true;

  // 5. Ensure input node exists
  const hasInput = w.nodes.some((n) => n.type === 'input');
  if (!hasInput && w.nodes.length > 0) {
    const inputNode: DAGNode = {
      id: 'input-auto',
      type: 'input',
      position: { x: 400, y: 0 },
      config: { name: 'Input' },
    };
    w.nodes.unshift(inputNode);
    // Connect to first non-input node that has no predecessors
    const targets = new Set(w.edges.map((e) => e.target));
    const rootNodes = w.nodes.filter((n) => n.id !== 'input-auto' && !targets.has(n.id));
    for (const root of rootNodes) {
      w.edges.push({
        id: `edge-auto-input-${root.id}`,
        source: 'input-auto',
        target: root.id,
      });
    }
    wasFixed = true;
    errors.push('Added missing input node');
  }

  // 6. Ensure output node exists
  const hasOutput = w.nodes.some((n) => n.type === 'output');
  if (!hasOutput && w.nodes.length > 0) {
    const maxY = Math.max(...w.nodes.map((n) => n.position.y), 0);
    const outputNode: DAGNode = {
      id: 'output-auto',
      type: 'output',
      position: { x: 400, y: maxY + 200 },
      config: { name: 'Output' },
    };
    w.nodes.push(outputNode);
    // Connect leaf nodes (no outgoing edges) to output
    const sources = new Set(w.edges.map((e) => e.source));
    const leafNodes = w.nodes.filter(
      (n) => n.id !== 'output-auto' && !sources.has(n.id)
    );
    for (const leaf of leafNodes) {
      w.edges.push({
        id: `edge-auto-${leaf.id}-output`,
        source: leaf.id,
        target: 'output-auto',
      });
    }
    wasFixed = true;
    errors.push('Added missing output node');
  }

  // 7. Validate node types
  const validTypes: Set<string> = new Set([
    'input', 'output', 'agent', 'tool', 'condition',
    'merge', 'loop', 'human', 'planner',
  ]);
  for (const node of w.nodes) {
    if (!validTypes.has(node.type)) {
      errors.push(`Invalid node type "${node.type}" on node ${node.id}, defaulting to "agent"`);
      node.type = 'agent' as NodeType;
      wasFixed = true;
    }
  }

  // 8. Fix missing positions (layout auto-assign)
  for (const node of w.nodes) {
    if (!node.position || typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
      node.position = { x: 200 + Math.random() * 400, y: 200 + Math.random() * 400 };
      wasFixed = true;
    }
  }

  // 9. Fix missing config
  for (const node of w.nodes) {
    if (!node.config) {
      node.config = { name: node.id };
      wasFixed = true;
    }
    if (!node.config.name) {
      node.config.name = node.type.charAt(0).toUpperCase() + node.type.slice(1);
      wasFixed = true;
    }
  }

  // 10. Cycle detection — if still has cycle, try to break it
  const sorted = topologicalSort(w.nodes, w.edges);
  if (sorted === null) {
    errors.push('Cycle detected in AI-generated workflow. Attempting to break cycles.');
    // Simple cycle breaking: remove back-edges using DFS
    const broken = breakCycles(w.nodes, w.edges);
    if (broken.removed > 0) {
      w.edges = broken.edges;
      wasFixed = true;
      errors.push(`Removed ${broken.removed} back-edge(s) to break cycle`);
    }
  }

  // Final validation
  const validation = validateWorkflow(w);
  if (!validation.valid) {
    for (const err of validation.errors) {
      errors.push(`Validation: ${err.message}`);
    }
  }

  return { workflow: w, errors, wasFixed };
}

/**
 * Break cycles by removing back-edges found via DFS.
 */
function breakCycles(
  nodes: DAGNode[],
  edges: DAGEdge[]
): { edges: DAGEdge[]; removed: number } {
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node.id, []);
  for (const edge of edges) {
    adj.get(edge.source)?.push(edge.target);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of nodes) color.set(node.id, WHITE);

  const backEdges = new Set<string>(); // "source->target"

  function dfs(u: string): void {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        backEdges.add(`${u}->${v}`);
      } else if (color.get(v) === WHITE) {
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const node of nodes) {
    if (color.get(node.id) === WHITE) dfs(node.id);
  }

  const filtered = edges.filter(
    (e) => !backEdges.has(`${e.source}->${e.target}`)
  );

  return { edges: filtered, removed: edges.length - filtered.length };
}

// ---------- Export Prompt (for testing/customization) ----------

export { PLANNER_SYSTEM_PROMPT };

// ============================================================
// @dagflow/core — DAG Validation & Topological Sort
// ============================================================

import type { DAGNode, DAGEdge, Workflow } from './types.js';

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

/**
 * Build adjacency list from edges.
 */
export function buildAdjacencyList(
  nodes: DAGNode[],
  edges: DAGEdge[]
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    const targets = adj.get(edge.source);
    if (targets) targets.push(edge.target);
  }
  return adj;
}

/**
 * Build reverse adjacency list (predecessors).
 */
export function buildReverseAdjacencyList(
  nodes: DAGNode[],
  edges: DAGEdge[]
): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const node of nodes) {
    rev.set(node.id, []);
  }
  for (const edge of edges) {
    const preds = rev.get(edge.target);
    if (preds) preds.push(edge.source);
  }
  return rev;
}

/**
 * Compute in-degree for each node.
 */
export function computeInDegrees(
  nodes: DAGNode[],
  edges: DAGEdge[]
): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  return inDegree;
}

/**
 * Kahn's algorithm: topological sort.
 * Returns sorted node IDs, or null if a cycle exists.
 */
export function topologicalSort(
  nodes: DAGNode[],
  edges: DAGEdge[]
): string[] | null {
  const adj = buildAdjacencyList(nodes, edges);
  const inDegree = computeInDegrees(nodes, edges);

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];

  while (queue.length > 0) {
    // Sort for deterministic ordering
    queue.sort();
    const nodeId = queue.shift()!;
    sorted.push(nodeId);

    for (const neighbor of adj.get(nodeId) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== nodes.length) {
    return null; // cycle detected
  }

  return sorted;
}

/**
 * Validate a workflow definition.
 */
export function validateWorkflow(workflow: Workflow): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const nodeIds = new Set(workflow.nodes.map((n) => n.id));

  // 1. Check for duplicate node IDs
  const seenIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (seenIds.has(node.id)) {
      errors.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node ID: "${node.id}"`,
        nodeId: node.id,
      });
    }
    seenIds.add(node.id);
  }

  // 2. Check edges reference valid nodes
  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push({
        code: 'INVALID_EDGE_SOURCE',
        message: `Edge "${edge.id}" references unknown source node "${edge.source}"`,
        edgeId: edge.id,
      });
    }
    if (!nodeIds.has(edge.target)) {
      errors.push({
        code: 'INVALID_EDGE_TARGET',
        message: `Edge "${edge.id}" references unknown target node "${edge.target}"`,
        edgeId: edge.id,
      });
    }
  }

  // 3. Cycle detection via topological sort
  const sorted = topologicalSort(workflow.nodes, workflow.edges);
  if (sorted === null) {
    errors.push({
      code: 'CYCLE_DETECTED',
      message: 'Workflow contains a cycle — DAG required',
    });
  }

  // 4. Orphan nodes (no edges at all)
  const connectedNodes = new Set<string>();
  for (const edge of workflow.edges) {
    connectedNodes.add(edge.source);
    connectedNodes.add(edge.target);
  }
  for (const node of workflow.nodes) {
    if (!connectedNodes.has(node.id) && workflow.nodes.length > 1) {
      warnings.push({
        code: 'ORPHAN_NODE',
        message: `Node "${node.id}" (${node.config.name}) has no connections`,
        nodeId: node.id,
      });
    }
  }

  // 5. Agent nodes should have a model
  for (const node of workflow.nodes) {
    if (node.type === 'agent' && !node.config.model) {
      warnings.push({
        code: 'AGENT_NO_MODEL',
        message: `Agent node "${node.id}" (${node.config.name}) has no model specified`,
        nodeId: node.id,
      });
    }
    if (node.type === 'agent' && !node.config.systemPrompt) {
      warnings.push({
        code: 'AGENT_NO_PROMPT',
        message: `Agent node "${node.id}" (${node.config.name}) has no system prompt`,
        nodeId: node.id,
      });
    }
  }

  // 6. Must have at least one input and one output node
  const hasInput = workflow.nodes.some((n) => n.type === 'input');
  const hasOutput = workflow.nodes.some((n) => n.type === 'output');
  if (!hasInput) {
    warnings.push({
      code: 'NO_INPUT_NODE',
      message: 'Workflow has no input node',
    });
  }
  if (!hasOutput) {
    warnings.push({
      code: 'NO_OUTPUT_NODE',
      message: 'Workflow has no output node',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Get nodes that are ready to execute (all predecessors completed).
 */
export function getReadyNodes(
  nodes: DAGNode[],
  edges: DAGEdge[],
  completedNodeIds: Set<string>,
  runningNodeIds: Set<string>
): string[] {
  const reverse = buildReverseAdjacencyList(nodes, edges);
  const ready: string[] = [];

  for (const node of nodes) {
    if (completedNodeIds.has(node.id) || runningNodeIds.has(node.id)) continue;

    const predecessors = reverse.get(node.id) ?? [];
    const allPredsComplete = predecessors.every((p) => completedNodeIds.has(p));
    if (allPredsComplete) {
      ready.push(node.id);
    }
  }

  return ready;
}

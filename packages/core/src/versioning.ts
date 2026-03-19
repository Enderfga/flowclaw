/**
 * Workflow Versioning & Diff System
 *
 * Tracks workflow changes over time and computes structured diffs
 * between any two versions.
 */

import type { Workflow, DAGNode, DAGEdge } from './types.js';

// ---------- Types ----------

export interface WorkflowVersion {
  version: number;
  snapshot: Workflow;
  message?: string;
  createdAt: string;
  author?: string;
}

export type DiffChangeType = 'added' | 'removed' | 'modified';

export interface NodeDiff {
  type: DiffChangeType;
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  before?: Partial<DAGNode>;
  after?: Partial<DAGNode>;
  changes?: PropertyChange[];
}

export interface EdgeDiff {
  type: DiffChangeType;
  edgeId: string;
  source?: string;
  target?: string;
  before?: Partial<DAGEdge>;
  after?: Partial<DAGEdge>;
  changes?: PropertyChange[];
}

export interface PropertyChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface WorkflowDiff {
  fromVersion: number;
  toVersion: number;
  nodes: NodeDiff[];
  edges: EdgeDiff[];
  metadata: PropertyChange[];
  summary: string;
}

// ---------- Deep comparison helpers ----------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/**
 * Compute property-level changes between two objects.
 * Only goes one level deep for readability.
 */
function diffProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = '',
): PropertyChange[] {
  const changes: PropertyChange[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    if (key === 'id') continue; // ID changes are structural, not property changes
    const path = prefix ? `${prefix}.${key}` : key;
    const bVal = before[key];
    const aVal = after[key];

    if (!deepEqual(bVal, aVal)) {
      changes.push({ path, before: bVal, after: aVal });
    }
  }
  return changes;
}

// ---------- Diff computation ----------

/**
 * Compute a structured diff between two workflow snapshots.
 */
export function diffWorkflows(
  from: Workflow,
  to: Workflow,
  fromVersion = 0,
  toVersion = 1,
): WorkflowDiff {
  const nodeDiffs = diffNodes(from.nodes, to.nodes);
  const edgeDiffs = diffEdges(from.edges, to.edges);
  const metaDiffs = diffProperties(
    from.metadata as unknown as Record<string, unknown>,
    to.metadata as unknown as Record<string, unknown>,
  );

  // Check top-level fields
  if (from.name !== to.name) {
    metaDiffs.push({ path: 'name', before: from.name, after: to.name });
  }
  if (!deepEqual(from.variables, to.variables)) {
    metaDiffs.push({ path: 'variables', before: from.variables, after: to.variables });
  }

  const summary = buildSummary(nodeDiffs, edgeDiffs, metaDiffs);

  return { fromVersion, toVersion, nodes: nodeDiffs, edges: edgeDiffs, metadata: metaDiffs, summary };
}

function diffNodes(from: DAGNode[], to: DAGNode[]): NodeDiff[] {
  const diffs: NodeDiff[] = [];
  const fromMap = new Map(from.map((n) => [n.id, n]));
  const toMap = new Map(to.map((n) => [n.id, n]));

  // Removed nodes
  for (const [id, node] of fromMap) {
    if (!toMap.has(id)) {
      diffs.push({
        type: 'removed',
        nodeId: id,
        nodeName: node.config.name,
        nodeType: node.type,
        before: node,
      });
    }
  }

  // Added nodes
  for (const [id, node] of toMap) {
    if (!fromMap.has(id)) {
      diffs.push({
        type: 'added',
        nodeId: id,
        nodeName: node.config.name,
        nodeType: node.type,
        after: node,
      });
    }
  }

  // Modified nodes
  for (const [id, toNode] of toMap) {
    const fromNode = fromMap.get(id);
    if (!fromNode) continue;
    if (deepEqual(fromNode, toNode)) continue;

    const changes: PropertyChange[] = [];

    // Position changes
    if (!deepEqual(fromNode.position, toNode.position)) {
      changes.push({ path: 'position', before: fromNode.position, after: toNode.position });
    }

    // Type change
    if (fromNode.type !== toNode.type) {
      changes.push({ path: 'type', before: fromNode.type, after: toNode.type });
    }

    // Config changes
    const configChanges = diffProperties(
      fromNode.config as unknown as Record<string, unknown>,
      toNode.config as unknown as Record<string, unknown>,
      'config',
    );
    changes.push(...configChanges);

    if (changes.length > 0) {
      diffs.push({
        type: 'modified',
        nodeId: id,
        nodeName: toNode.config.name,
        nodeType: toNode.type,
        before: fromNode,
        after: toNode,
        changes,
      });
    }
  }

  return diffs;
}

function diffEdges(from: DAGEdge[], to: DAGEdge[]): EdgeDiff[] {
  const diffs: EdgeDiff[] = [];
  const fromMap = new Map(from.map((e) => [e.id, e]));
  const toMap = new Map(to.map((e) => [e.id, e]));

  for (const [id, edge] of fromMap) {
    if (!toMap.has(id)) {
      diffs.push({ type: 'removed', edgeId: id, source: edge.source, target: edge.target, before: edge });
    }
  }

  for (const [id, edge] of toMap) {
    if (!fromMap.has(id)) {
      diffs.push({ type: 'added', edgeId: id, source: edge.source, target: edge.target, after: edge });
    }
  }

  for (const [id, toEdge] of toMap) {
    const fromEdge = fromMap.get(id);
    if (!fromEdge) continue;
    if (deepEqual(fromEdge, toEdge)) continue;

    const changes = diffProperties(
      fromEdge as unknown as Record<string, unknown>,
      toEdge as unknown as Record<string, unknown>,
    );
    if (changes.length > 0) {
      diffs.push({
        type: 'modified',
        edgeId: id,
        source: toEdge.source,
        target: toEdge.target,
        before: fromEdge,
        after: toEdge,
        changes,
      });
    }
  }

  return diffs;
}

function buildSummary(nodes: NodeDiff[], edges: EdgeDiff[], meta: PropertyChange[]): string {
  const parts: string[] = [];
  const added = nodes.filter((n) => n.type === 'added');
  const removed = nodes.filter((n) => n.type === 'removed');
  const modified = nodes.filter((n) => n.type === 'modified');

  if (added.length) parts.push(`+${added.length} node${added.length > 1 ? 's' : ''}`);
  if (removed.length) parts.push(`-${removed.length} node${removed.length > 1 ? 's' : ''}`);
  if (modified.length) parts.push(`~${modified.length} node${modified.length > 1 ? 's' : ''}`);

  const edgeAdded = edges.filter((e) => e.type === 'added').length;
  const edgeRemoved = edges.filter((e) => e.type === 'removed').length;
  if (edgeAdded) parts.push(`+${edgeAdded} edge${edgeAdded > 1 ? 's' : ''}`);
  if (edgeRemoved) parts.push(`-${edgeRemoved} edge${edgeRemoved > 1 ? 's' : ''}`);

  if (meta.length) parts.push(`${meta.length} metadata change${meta.length > 1 ? 's' : ''}`);

  return parts.length ? parts.join(', ') : 'no changes';
}

// ---------- Version Store (in-memory, MVP) ----------

export class VersionStore {
  private versions = new Map<string, WorkflowVersion[]>();

  /** Save a new version snapshot. Returns version number. */
  commit(workflowId: string, workflow: Workflow, message?: string, author?: string): number {
    const history = this.versions.get(workflowId) ?? [];
    const version = history.length + 1;

    // Deep clone the workflow to avoid mutation
    const snapshot = JSON.parse(JSON.stringify(workflow)) as Workflow;
    history.push({
      version,
      snapshot,
      message: message ?? `Version ${version}`,
      createdAt: new Date().toISOString(),
      author,
    });

    this.versions.set(workflowId, history);
    return version;
  }

  /** Get all versions for a workflow. */
  listVersions(workflowId: string): Omit<WorkflowVersion, 'snapshot'>[] {
    const history = this.versions.get(workflowId) ?? [];
    return history.map(({ version, message, createdAt, author }) => ({
      version, message, createdAt, author,
    }));
  }

  /** Get a specific version's full snapshot. */
  getVersion(workflowId: string, version: number): WorkflowVersion | undefined {
    const history = this.versions.get(workflowId) ?? [];
    return history.find((v) => v.version === version);
  }

  /** Get the latest version number (0 if no versions). */
  latestVersion(workflowId: string): number {
    return (this.versions.get(workflowId) ?? []).length;
  }

  /** Compute diff between two versions. */
  diff(workflowId: string, fromVer: number, toVer: number): WorkflowDiff | undefined {
    const fromSnapshot = this.getVersion(workflowId, fromVer);
    const toSnapshot = this.getVersion(workflowId, toVer);
    if (!fromSnapshot || !toSnapshot) return undefined;
    return diffWorkflows(fromSnapshot.snapshot, toSnapshot.snapshot, fromVer, toVer);
  }

  /** Restore a workflow to a previous version. Returns the restored snapshot. */
  restore(workflowId: string, version: number): Workflow | undefined {
    const ver = this.getVersion(workflowId, version);
    if (!ver) return undefined;
    return JSON.parse(JSON.stringify(ver.snapshot)) as Workflow;
  }

  /** Delete all version history for a workflow. */
  clear(workflowId: string): void {
    this.versions.delete(workflowId);
  }
}

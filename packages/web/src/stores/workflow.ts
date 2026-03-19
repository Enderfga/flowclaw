import { create } from 'zustand';
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from '@xyflow/react';
import type { DAGNode, NodeType, NodeRunState } from '@council/core';

// Extended node data for ReactFlow
export interface NodeData extends Record<string, unknown> {
  dagNode: DAGNode;
  runState?: NodeRunState;
}

export type FlowNode = Node<NodeData>;
export type FlowEdge = Edge;

interface WorkflowState {
  // Graph
  nodes: FlowNode[];
  edges: FlowEdge[];
  onNodesChange: OnNodesChange<FlowNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // Selection
  selectedNodeId: string | null;
  selectNode: (id: string | null) => void;

  // Node CRUD
  addNode: (type: NodeType, position: { x: number; y: number }) => void;
  updateNodeConfig: (id: string, config: Partial<DAGNode['config']>) => void;
  deleteNode: (id: string) => void;

  // Variables (T4.5)
  variables: Record<string, string>;
  setVariable: (key: string, value: string) => void;
  deleteVariable: (key: string) => void;

  // Run state
  nodeRunStates: Record<string, NodeRunState>;
  updateNodeRunState: (nodeId: string, state: NodeRunState) => void;
  clearRunStates: () => void;

  // Workflow I/O
  toJSON: () => { nodes: DAGNode[]; edges: Array<{ id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string; condition?: string; transform?: string }>; variables?: Record<string, string> };
  loadFromJSON: (data: { nodes: DAGNode[]; edges: Array<{ id: string; source: string; target: string }>; variables?: Record<string, string> }) => void;
}

let nodeCounter = 0;

const NODE_DEFAULTS: Record<NodeType, Partial<DAGNode['config']>> = {
  input: { name: 'Input' },
  output: { name: 'Output' },
  agent: { name: 'Agent', model: 'claude-sonnet-4-6', systemPrompt: 'You are a helpful assistant.' },
  tool: { name: 'Tool' },
  condition: { name: 'Condition' },
  merge: { name: 'Merge' },
  loop: { name: 'Loop' },
  human: { name: 'Human Review' },
  planner: { name: 'Planner', model: 'claude-sonnet-4-6', systemPrompt: 'Analyze the task and create a plan.' },
  subworkflow: { name: 'Sub-workflow' },
};

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  nodes: [],
  edges: [],

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    // Auto-add condition labels for edges from condition nodes
    const sourceNode = get().nodes.find(n => n.id === connection.source);
    const isCondition = sourceNode?.data.dagNode.type === 'condition';
    const existingFromSource = get().edges.filter(e => e.source === connection.source);
    
    const newEdge: FlowEdge = {
      ...connection,
      id: `e-${Date.now()}`,
      ...(isCondition ? {
        label: existingFromSource.length === 0 ? 'true' : 'false',
        data: { condition: existingFromSource.length === 0 ? 'true' : 'false' },
        style: { stroke: existingFromSource.length === 0 ? '#22c55e' : '#ef4444', strokeWidth: 2 },
        labelStyle: { fill: existingFromSource.length === 0 ? '#22c55e' : '#ef4444', fontWeight: 600, fontSize: 12 },
      } : {}),
    };
    set({ edges: addEdge(newEdge, get().edges) });
  },

  selectedNodeId: null,
  selectNode: (id) => set({ selectedNodeId: id }),

  // Variables (T4.5)
  variables: {},
  setVariable: (key, value) => set({ variables: { ...get().variables, [key]: value } }),
  deleteVariable: (key) => {
    const { [key]: _, ...rest } = get().variables;
    set({ variables: rest });
  },

  addNode: (type, position) => {
    const id = `node-${++nodeCounter}-${Date.now()}`;
    const dagNode: DAGNode = {
      id,
      type,
      position,
      config: { name: NODE_DEFAULTS[type]?.name ?? type, ...NODE_DEFAULTS[type] },
    };
    const flowNode: FlowNode = {
      id,
      type: 'custom',
      position,
      data: { dagNode },
    };
    set({ nodes: [...get().nodes, flowNode] });
  },

  updateNodeConfig: (id, config) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, dagNode: { ...n.data.dagNode, config: { ...n.data.dagNode.config, ...config } } } }
          : n,
      ),
    });
  },

  deleteNode: (id) => {
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
    });
  },

  nodeRunStates: {},
  updateNodeRunState: (nodeId, state) => {
    set({ nodeRunStates: { ...get().nodeRunStates, [nodeId]: state } });
    // Also update the node data for visual feedback
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, runState: state } } : n,
      ),
    });
  },
  clearRunStates: () => {
    set({
      nodeRunStates: {},
      nodes: get().nodes.map((n) => ({ ...n, data: { ...n.data, runState: undefined } })),
    });
  },

  toJSON: () => {
    const { nodes, edges, variables } = get();
    return {
      nodes: nodes.map((n) => ({ ...n.data.dagNode, position: n.position })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...((e as any).data?.condition ? { condition: (e as any).data.condition } : {}),
      })),
      ...(Object.keys(variables).length > 0 ? { variables } : {}),
    };
  },

  loadFromJSON: (data) => {
    nodeCounter = data.nodes.length;
    set({
      nodes: data.nodes.map((dagNode) => ({
        id: dagNode.id,
        type: 'custom',
        position: dagNode.position,
        data: { dagNode },
      })),
      edges: data.edges.map((e) => ({ ...e, id: e.id || `e-${Date.now()}-${Math.random()}` })),
      variables: data.variables ?? {},
    });
  },
}));

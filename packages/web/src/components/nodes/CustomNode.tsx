import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData, FlowNode } from '../../stores/workflow';
import type { NodeType, NodeRunStatus } from '@council/core';
import {
  Brain,
  Terminal,
  GitFork,
  Merge,
  RefreshCw,
  User,
  Lightbulb,
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
} from 'lucide-react';

const NODE_ICONS: Record<NodeType, React.FC<{ size?: number }>> = {
  input: ArrowDownToLine,
  output: ArrowUpFromLine,
  agent: Brain,
  tool: Terminal,
  condition: GitFork,
  merge: Merge,
  loop: RefreshCw,
  human: User,
  planner: Lightbulb,
  subworkflow: Boxes,
};

const NODE_COLORS: Record<NodeType, string> = {
  input: 'border-green-500 bg-green-500/10',
  output: 'border-red-500 bg-red-500/10',
  agent: 'border-blue-500 bg-blue-500/10',
  tool: 'border-yellow-500 bg-yellow-500/10',
  condition: 'border-purple-500 bg-purple-500/10',
  merge: 'border-cyan-500 bg-cyan-500/10',
  loop: 'border-orange-500 bg-orange-500/10',
  human: 'border-pink-500 bg-pink-500/10',
  planner: 'border-indigo-500 bg-indigo-500/10',
  subworkflow: 'border-teal-500 bg-teal-500/10',
};

const STATUS_COLORS: Record<NodeRunStatus, string> = {
  waiting: 'bg-slate-500',
  ready: 'bg-amber-500',
  running: 'bg-blue-500 animate-pulse',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  skipped: 'bg-slate-400',
  paused: 'bg-yellow-500 animate-pulse',
  breakpoint: 'bg-orange-500 animate-pulse',
};

function CustomNode({ data, selected }: NodeProps<FlowNode>) {
  const { dagNode, runState } = data as NodeData;
  const Icon = NODE_ICONS[dagNode.type];
  const colorClass = NODE_COLORS[dagNode.type];

  return (
    <div
      className={`
        relative rounded-lg border-2 px-4 py-3 min-w-[180px] shadow-lg
        transition-all duration-200
        ${colorClass}
        ${selected ? 'ring-2 ring-white/50 scale-105' : ''}
      `}
    >
      {/* Status indicator */}
      {runState && (
        <div className={`absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full ${STATUS_COLORS[runState.status]}`} />
      )}

      {/* Input handle */}
      {dagNode.type !== 'input' && (
        <Handle
          type="target"
          position={Position.Top}
          className="!w-3 !h-3 !bg-slate-400 !border-slate-600"
        />
      )}

      <div className="flex items-center gap-2">
        <Icon size={18} />
        <div>
          <div className="font-semibold text-sm">{dagNode.config.name}</div>
          <div className="text-xs text-slate-400">{dagNode.type}</div>
        </div>
      </div>

      {dagNode.config.model && (
        <div className="text-xs text-slate-500 mt-1 truncate max-w-[160px]">
          {dagNode.config.model}
        </div>
      )}

      {runState?.status === 'running' && (
        <div className="text-xs text-blue-400 mt-1 animate-pulse">Running...</div>
      )}
      {runState?.status === 'completed' && runState.tokenUsage && (
        <div className="text-xs text-green-400 mt-1">
          {runState.tokenUsage.prompt + runState.tokenUsage.completion} tokens
        </div>
      )}
      {runState?.status === 'paused' && (
        <div className="text-xs text-yellow-400 mt-1 animate-pulse">⏸ Awaiting approval</div>
      )}
      {runState?.status === 'failed' && (
        <div className="text-xs text-red-400 mt-1 truncate max-w-[160px]">{runState.error}</div>
      )}

      {/* Output handles — condition nodes get true/false handles */}
      {dagNode.type === 'condition' ? (
        <div className="flex justify-between px-2 -mb-1">
          <div className="relative">
            <Handle
              type="source"
              position={Position.Bottom}
              id="true"
              className="!w-3 !h-3 !bg-green-400 !border-green-600"
              style={{ left: '25%' }}
            />
            <span className="absolute -bottom-4 left-0 text-[9px] text-green-400">✓</span>
          </div>
          <div className="relative">
            <Handle
              type="source"
              position={Position.Bottom}
              id="false"
              className="!w-3 !h-3 !bg-red-400 !border-red-600"
              style={{ left: '75%' }}
            />
            <span className="absolute -bottom-4 right-0 text-[9px] text-red-400">✗</span>
          </div>
        </div>
      ) : dagNode.type !== 'output' ? (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!w-3 !h-3 !bg-slate-400 !border-slate-600"
        />
      ) : null}
    </div>
  );
}

export default memo(CustomNode);

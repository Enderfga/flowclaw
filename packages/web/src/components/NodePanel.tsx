import type { NodeType } from '@council/core';
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

const NODE_TYPES: { type: NodeType; label: string; icon: React.FC<{ size?: number }>; desc: string }[] = [
  { type: 'input', label: 'Input', icon: ArrowDownToLine, desc: 'Workflow entry point' },
  { type: 'output', label: 'Output', icon: ArrowUpFromLine, desc: 'Final result' },
  { type: 'agent', label: 'Agent', icon: Brain, desc: 'LLM agent node' },
  { type: 'tool', label: 'Tool', icon: Terminal, desc: 'Shell / HTTP tool' },
  { type: 'condition', label: 'Condition', icon: GitFork, desc: 'Branch logic' },
  { type: 'merge', label: 'Merge', icon: Merge, desc: 'Combine results' },
  { type: 'loop', label: 'Loop', icon: RefreshCw, desc: 'Iterate until done' },
  { type: 'human', label: 'Human', icon: User, desc: 'Approval gate' },
  { type: 'planner', label: 'Planner', icon: Lightbulb, desc: 'Auto-plan sub-DAG' },
  { type: 'subworkflow', label: 'Sub-workflow', icon: Boxes, desc: 'Nested DAG' },
];

interface Props {
  onAddNode: (type: NodeType) => void;
}

export default function NodePanel({ onAddNode }: Props) {
  return (
    <div className="w-56 bg-slate-800 border-r border-slate-700 p-3 overflow-y-auto">
      <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Nodes</h2>
      <div className="space-y-1.5">
        {NODE_TYPES.map(({ type, label, icon: Icon, desc }) => (
          <button
            key={type}
            onClick={() => onAddNode(type)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/council-node-type', type);
              e.dataTransfer.effectAllowed = 'move';
            }}
            className="
              w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left
              bg-slate-700/50 hover:bg-slate-700 border border-slate-600/50
              transition-colors cursor-grab active:cursor-grabbing
            "
          >
            <Icon size={16} />
            <div>
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-slate-400">{desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

import { useWorkflowStore } from '../stores/workflow';
import { X, Trash2 } from 'lucide-react';
import VariablesPanel from './VariablesPanel';

function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

const MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gpt-4o',
  'gpt-5.4',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
];

export default function Inspector() {
  const { nodes, selectedNodeId, selectNode, updateNodeConfig, deleteNode } = useWorkflowStore();
  const node = nodes.find((n) => n.id === selectedNodeId);

  if (!node) return null;

  const { dagNode } = node.data;
  const cfg = dagNode.config;

  const update = (patch: Record<string, unknown>) => updateNodeConfig(node.id, patch);

  return (
    <div className="w-80 bg-slate-800 border-l border-slate-700 p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">Inspector</h2>
        <button onClick={() => selectNode(null)} className="text-slate-400 hover:text-white">
          <X size={16} />
        </button>
      </div>

      {/* Name */}
      <Field label="Name">
        <input
          value={cfg.name}
          onChange={(e) => update({ name: e.target.value })}
          className="input-field"
        />
      </Field>

      {/* Type badge */}
      <Field label="Type">
        <span className="text-sm px-2 py-0.5 rounded bg-slate-700 text-slate-300">{dagNode.type}</span>
      </Field>

      {/* Model selector (for agent/planner) */}
      {(dagNode.type === 'agent' || dagNode.type === 'planner') && (
        <>
          <Field label="Model">
            <select
              value={cfg.model ?? ''}
              onChange={(e) => update({ model: e.target.value })}
              className="input-field"
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>

          <Field label="System Prompt">
            <textarea
              value={cfg.systemPrompt ?? ''}
              onChange={(e) => update({ systemPrompt: e.target.value })}
              rows={6}
              className="input-field resize-y"
            />
          </Field>

          <Field label="Temperature">
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={cfg.temperature ?? 0.7}
              onChange={(e) => update({ temperature: parseFloat(e.target.value) })}
              className="input-field w-24"
            />
          </Field>

          <Field label="Max Tokens">
            <input
              type="number"
              min={1}
              max={200000}
              value={cfg.maxTokens ?? 4096}
              onChange={(e) => update({ maxTokens: parseInt(e.target.value, 10) })}
              className="input-field w-32"
            />
          </Field>
        </>
      )}

      {/* Condition node config */}
      {dagNode.type === 'condition' && (
        <>
          <Field label="Condition Expression">
            <input
              value={(cfg as any).conditionExpr ?? 'true'}
              onChange={(e) => update({ conditionExpr: e.target.value })}
              placeholder="e.g. status === 'success'"
              className="input-field"
            />
          </Field>
          <p className="text-xs text-slate-500 mb-3">
            Supports: ===, !==, &gt;, &lt;, field truthiness. Connect edges with condition "true"/"false".
          </p>
        </>
      )}

      {/* Loop node config */}
      {dagNode.type === 'loop' && (
        <>
          <Field label="Max Iterations">
            <input
              type="number"
              min={1}
              max={100}
              value={(cfg as any).maxIterations ?? 5}
              onChange={(e) => update({ maxIterations: parseInt(e.target.value, 10) })}
              className="input-field w-24"
            />
          </Field>
          <Field label="Exit Condition">
            <input
              value={(cfg as any).exitCondition ?? ''}
              onChange={(e) => update({ exitCondition: e.target.value })}
              placeholder="e.g. __done"
              className="input-field"
            />
          </Field>
          <Field label="Model">
            <select
              value={cfg.model ?? 'gpt-4o'}
              onChange={(e) => update({ model: e.target.value })}
              className="input-field"
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="System Prompt (per iteration)">
            <textarea
              value={cfg.systemPrompt ?? ''}
              onChange={(e) => update({ systemPrompt: e.target.value })}
              rows={4}
              placeholder="Use {{iteration}}/{{maxIterations}} for iteration info"
              className="input-field resize-y"
            />
          </Field>
        </>
      )}

      {/* Human node config */}
      {dagNode.type === 'human' && (
        <>
          <Field label="Approval Prompt">
            <textarea
              value={cfg.systemPrompt ?? ''}
              onChange={(e) => update({ systemPrompt: e.target.value })}
              rows={3}
              placeholder="What should the reviewer check?"
              className="input-field resize-y"
            />
          </Field>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-yellow-900/30 border border-yellow-700/50 text-yellow-300 text-xs mt-1">
            <span>⏸</span>
            <span>Execution pauses here until human approval</span>
          </div>
        </>
      )}

      {/* Tool node config */}
      {dagNode.type === 'tool' && (
        <>
          <Field label="Tool Type">
            <select
              value={(cfg as any).toolType ?? 'shell'}
              onChange={(e) => update({ toolType: e.target.value })}
              className="input-field"
            >
              <option value="shell">Shell Command</option>
              <option value="http">HTTP Request</option>
              <option value="function">Function</option>
            </select>
          </Field>
          <Field label="Command / URL">
            <input
              value={(cfg as any).toolCommand ?? ''}
              onChange={(e) => update({ toolCommand: e.target.value })}
              placeholder={
                (cfg as any).toolType === 'http' ? 'https://api.example.com/...' : 'echo "hello"'
              }
              className="input-field"
            />
          </Field>
        </>
      )}

      {/* Retry Policy (universal except input/output) */}
      {dagNode.type !== 'input' && dagNode.type !== 'output' && (
        <details className="mb-3 mt-2">
          <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-300">
            ⚙️ Retry Policy
          </summary>
          <div className="mt-2 space-y-2 pl-2 border-l border-slate-700">
            <Field label="Max Retries">
              <input
                type="number"
                min={0}
                max={10}
                value={cfg.retryPolicy?.maxRetries ?? 0}
                onChange={(e) => update({ retryPolicy: { ...cfg.retryPolicy, maxRetries: parseInt(e.target.value, 10), backoffMs: cfg.retryPolicy?.backoffMs ?? 1000 } })}
                className="input-field w-20"
              />
            </Field>
            <Field label="Backoff (ms)">
              <input
                type="number"
                min={100}
                step={100}
                value={cfg.retryPolicy?.backoffMs ?? 1000}
                onChange={(e) => update({ retryPolicy: { ...cfg.retryPolicy, maxRetries: cfg.retryPolicy?.maxRetries ?? 0, backoffMs: parseInt(e.target.value, 10) } })}
                className="input-field w-24"
              />
            </Field>
          </div>
        </details>
      )}

      {/* Input template (universal) */}
      <Field label="Input Template">
        <textarea
          value={cfg.inputTemplate ?? ''}
          onChange={(e) => update({ inputTemplate: e.target.value })}
          rows={3}
          placeholder="e.g. Based on {{node-1.output}}, do..."
          className="input-field resize-y"
        />
      </Field>

      {/* Run Output & Cost (shown when node has been executed) */}
      {node.data.runState && (
        <div className="mt-4 pt-4 border-t border-slate-700">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Execution Result</h3>
          
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full ${
              node.data.runState.status === 'completed' ? 'bg-green-500' :
              node.data.runState.status === 'failed' ? 'bg-red-500' :
              node.data.runState.status === 'running' ? 'bg-blue-500 animate-pulse' :
              node.data.runState.status === 'paused' ? 'bg-yellow-500 animate-pulse' :
              'bg-slate-500'
            }`} />
            <span className="text-xs text-slate-300 capitalize">{node.data.runState.status}</span>
            {node.data.runState.tokenUsage && (
              <span className="text-xs text-slate-500 ml-auto">
                {node.data.runState.tokenUsage.prompt + node.data.runState.tokenUsage.completion} tokens
              </span>
            )}
          </div>

          {node.data.runState.error && (
            <div className="text-xs text-red-400 bg-red-900/20 rounded p-2 mb-2 break-words">
              {String(node.data.runState.error)}
            </div>
          )}

          {node.data.runState.output !== undefined && (
            <details open={node.data.runState.status === 'completed'}>
              <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-300 mb-1">Output</summary>
              <pre className="text-xs text-slate-300 bg-slate-900 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                {formatOutput(node.data.runState.output)}
              </pre>
            </details>
          )}

          {node.data.runState.tokenUsage && (
            <div className="mt-2 text-xs text-slate-500 flex justify-between">
              <span>Prompt: {node.data.runState.tokenUsage.prompt}</span>
              <span>Completion: {node.data.runState.tokenUsage.completion}</span>
            </div>
          )}
        </div>
      )}

      {/* Delete */}
      <button
        onClick={() => { deleteNode(node.id); selectNode(null); }}
        className="mt-6 w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-red-900/50 hover:bg-red-800 text-red-300 text-sm transition-colors"
      >
        <Trash2 size={14} />
        Delete Node
      </button>

      {/* Variables Panel */}
      <VariablesPanel />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-xs text-slate-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

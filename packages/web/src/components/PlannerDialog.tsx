import { useState, useCallback, useRef, useEffect } from 'react';
import { Sparkles, Loader2, X, AlertTriangle, Check } from 'lucide-react';
import { useWorkflowStore } from '../stores/workflow';

interface PlannerDialogProps {
  open: boolean;
  onClose: () => void;
}

type PlannerState = 'idle' | 'generating' | 'success' | 'error';

export default function PlannerDialog({ open, onClose }: PlannerDialogProps) {
  const [task, setTask] = useState('');
  const [constraints, setConstraints] = useState('');
  const [state, setState] = useState<PlannerState>('idle');
  const [error, setError] = useState('');
  const [previewNodes, setPreviewNodes] = useState(0);
  const [previewEdges, setPreviewEdges] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { loadFromJSON } = useWorkflowStore();

  useEffect(() => {
    if (open && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [open]);

  const handleGenerate = useCallback(async () => {
    if (!task.trim()) return;

    setState('generating');
    setError('');
    setWarnings([]);

    try {
      const res = await fetch('/api/planner/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: task.trim(),
          constraints: constraints.trim() || undefined,
          autoSave: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Server error: ${res.status}`);
      }

      const data = await res.json();
      const { workflow, validationErrors, autoFixed } = data;

      if (validationErrors && validationErrors.length > 0) {
        throw new Error(
          `Generated workflow has errors: ${validationErrors.join('; ')}`
        );
      }

      setPreviewNodes(workflow.nodes.length);
      setPreviewEdges(workflow.edges.length);

      const warns: string[] = [];
      if (autoFixed) warns.push('⚡ Some issues were auto-fixed');
      if (data.mock) warns.push('🧪 Generated with mock provider (set API key for real AI planning)');
      setWarnings(warns);

      // Load into the editor
      loadFromJSON({
        nodes: workflow.nodes,
        edges: workflow.edges,
      });

      setState('success');
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setState('error');
    }
  }, [task, constraints, loadFromJSON]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleGenerate();
      }
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [handleGenerate, onClose]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="bg-slate-800 rounded-xl shadow-2xl border border-slate-700 w-full max-w-lg mx-4"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Sparkles size={20} className="text-indigo-400" />
            <h2 className="text-lg font-semibold text-slate-100">AI Planner</h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Task description */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Describe your workflow
            </label>
            <textarea
              ref={textareaRef}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="e.g. Research a topic from 3 different angles, then synthesize the findings into a comprehensive report"
              rows={4}
              className="input-field resize-none"
              disabled={state === 'generating'}
            />
          </div>

          {/* Constraints (collapsible) */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Constraints <span className="text-slate-500">(optional)</span>
            </label>
            <textarea
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              placeholder="e.g. Use Claude for all agents. Max 5 nodes. Include a human review step."
              rows={2}
              className="input-field resize-none"
              disabled={state === 'generating'}
            />
          </div>

          {/* Status messages */}
          {state === 'generating' && (
            <div className="flex items-center gap-2 text-blue-400 text-sm">
              <Loader2 size={16} className="animate-spin" />
              Generating workflow...
            </div>
          )}

          {state === 'success' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <Check size={16} />
                Generated {previewNodes} nodes and {previewEdges} edges
              </div>
              {warnings.length > 0 && (
                <div className="space-y-1">
                  {warnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-amber-400 text-xs">
                      <AlertTriangle size={12} />
                      {w}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {state === 'error' && (
            <div className="flex items-start gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-slate-700">
          <span className="text-xs text-slate-500">⌘+Enter to generate</span>
          <div className="flex gap-2">
            {state === 'success' ? (
              <button
                onClick={onClose}
                className="toolbar-btn !bg-green-600 hover:!bg-green-500 !text-white"
              >
                <Check size={16} />
                Done
              </button>
            ) : (
              <>
                <button onClick={onClose} className="toolbar-btn">
                  Cancel
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={state === 'generating' || !task.trim()}
                  className="toolbar-btn !bg-indigo-600 hover:!bg-indigo-500 !text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {state === 'generating' ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  Generate
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useWorkflowStore } from '../stores/workflow';
import { Play, Square, Download, Upload, Trash2, Sparkles, BookTemplate } from 'lucide-react';
import { useState, useRef } from 'react';
import PlannerDialog from './PlannerDialog';
import TemplatesDialog from './TemplatesDialog';

interface Props {
  onRun: () => void;
  isRunning: boolean;
  onShowHistory?: () => void;
  onShowVersions?: () => void;
}

export default function Toolbar({ onRun, isRunning, onShowHistory, onShowVersions }: Props) {
  const { toJSON, loadFromJSON, nodes, edges, clearRunStates } = useWorkflowStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const handleExport = () => {
    const data = toJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workflow.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        loadFromJSON(data);
      } catch {
        alert('Invalid workflow JSON');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSave = async () => {
    const data = toJSON();
    try {
      await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Untitled', ...data }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      handleExport();
    }
  };

  return (
    <div className="h-12 bg-slate-800 border-b border-slate-700 flex items-center px-4 gap-3">
      <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent mr-4">
        Council
      </h1>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setPlannerOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-sm font-medium transition-colors"
        >
          <Sparkles size={14} />
          AI Plan
        </button>

        <button
          onClick={() => setTemplatesOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-600 hover:bg-slate-500 text-sm font-medium transition-colors"
          title="Browse workflow templates"
        >
          <BookTemplate size={14} />
          Templates
        </button>

        <button
          onClick={onRun}
          disabled={isRunning || nodes.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 disabled:opacity-40 text-sm font-medium transition-colors"
        >
          {isRunning ? <Square size={14} /> : <Play size={14} />}
          {isRunning ? 'Running...' : 'Run'}
        </button>

        <button onClick={handleSave} className="toolbar-btn" title="Save">
          {saved ? '✓ Saved' : 'Save'}
        </button>

        <button onClick={handleExport} className="toolbar-btn" title="Export JSON">
          <Download size={14} />
        </button>

        <button onClick={handleImport} className="toolbar-btn" title="Import JSON">
          <Upload size={14} />
        </button>

        <button onClick={clearRunStates} className="toolbar-btn" title="Clear run states">
          <Trash2 size={14} />
        </button>

        {onShowHistory && (
          <button onClick={onShowHistory} className="toolbar-btn" title="Execution History">
            📜 History
          </button>
        )}

        {onShowVersions && (
          <button onClick={onShowVersions} className="toolbar-btn" title="Version History">
            📋 Versions
          </button>
        )}
      </div>

      <div className="ml-auto text-xs text-slate-500">
        {nodes.length} nodes · {edges.length} edges
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileChange}
        className="hidden"
      />

      <PlannerDialog open={plannerOpen} onClose={() => setPlannerOpen(false)} />
      <TemplatesDialog
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onLoad={(wf) => loadFromJSON(wf)}
      />
    </div>
  );
}

import { useState } from 'react';
import { useWorkflowStore } from '../stores/workflow';
import { Plus, Trash2, Variable } from 'lucide-react';

export default function VariablesPanel() {
  const { variables, setVariable, deleteVariable } = useWorkflowStore();
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  const entries = Object.entries(variables);

  const addVar = () => {
    const key = newKey.trim();
    if (!key) return;
    setVariable(key, newVal);
    setNewKey('');
    setNewVal('');
  };

  return (
    <details className="border-t border-slate-700 pt-3 mt-3">
      <summary className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer hover:text-slate-300 select-none">
        <Variable size={14} />
        <span>Global Variables ({entries.length})</span>
      </summary>
      <div className="mt-2 space-y-1.5">
        {entries.map(([key, val]) => (
          <div key={key} className="flex items-center gap-1.5 group">
            <code className="text-xs text-emerald-400 bg-slate-700/50 px-1.5 py-0.5 rounded min-w-[60px]">
              {key}
            </code>
            <input
              value={val}
              onChange={(e) => setVariable(key, e.target.value)}
              className="input-field text-xs flex-1"
            />
            <button
              onClick={() => deleteVariable(key)}
              className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 transition-opacity"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}

        {/* Add new variable */}
        <div className="flex items-center gap-1.5 pt-1">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="key"
            className="input-field text-xs w-20"
            onKeyDown={(e) => e.key === 'Enter' && addVar()}
          />
          <input
            value={newVal}
            onChange={(e) => setNewVal(e.target.value)}
            placeholder="value"
            className="input-field text-xs flex-1"
            onKeyDown={(e) => e.key === 'Enter' && addVar()}
          />
          <button
            onClick={addVar}
            disabled={!newKey.trim()}
            className="text-emerald-400 hover:text-emerald-300 disabled:text-slate-600 transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>

        <p className="text-[10px] text-slate-500 mt-1">
          Use <code className="text-emerald-500">{'{{$key}}'}</code> in templates to reference variables.
        </p>
      </div>
    </details>
  );
}

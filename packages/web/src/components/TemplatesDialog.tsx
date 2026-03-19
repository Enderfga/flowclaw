import { useState, useEffect } from 'react';
import { X, FileText, Layers, ArrowRight } from 'lucide-react';

interface TemplateSummary {
  filename: string;
  name: string;
  description: string;
  nodeCount: number;
  edgeCount: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onLoad: (workflow: any) => void;
}

export default function TemplatesDialog({ open, onClose, onLoad }: Props) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch('/api/templates')
      .then(r => r.json())
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, [open]);

  const loadTemplate = async (filename: string) => {
    try {
      const res = await fetch(`/api/templates/${filename}`);
      const wf = await res.json();
      onLoad(wf);
      onClose();
    } catch (err) {
      console.error('Failed to load template:', err);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-800 rounded-xl p-6 w-[600px] max-h-[80vh] overflow-auto border border-slate-600">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <FileText size={20} />
            Workflow Templates
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="text-slate-400 text-center py-8">Loading templates...</div>
        ) : templates.length === 0 ? (
          <div className="text-slate-400 text-center py-8">No templates available</div>
        ) : (
          <div className="space-y-3">
            {templates.map(t => (
              <button
                key={t.filename}
                onClick={() => loadTemplate(t.filename)}
                className="w-full text-left bg-slate-700/50 hover:bg-slate-700 rounded-lg p-4 border border-slate-600 hover:border-blue-500 transition-all group"
              >
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-white font-semibold">{t.name}</h3>
                    <p className="text-slate-400 text-sm mt-1">{t.description}</p>
                  </div>
                  <ArrowRight size={18} className="text-slate-500 group-hover:text-blue-400 mt-1 transition-colors" />
                </div>
                <div className="flex gap-4 mt-2 text-xs text-slate-500">
                  <span className="flex items-center gap-1">
                    <Layers size={12} /> {t.nodeCount} nodes
                  </span>
                  <span>{t.edgeCount} edges</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

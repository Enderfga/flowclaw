import { useState } from 'react';

interface BreakpointOverlayProps {
  runId: string;
  nodeId: string;
  nodeName: string;
  input: unknown;
  onResume: (modifiedInput?: unknown) => void;
  onClose: () => void;
}

export default function BreakpointOverlay({
  runId,
  nodeId,
  nodeName,
  input,
  onResume,
  onClose,
}: BreakpointOverlayProps) {
  const [editedInput, setEditedInput] = useState(
    typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  );
  const [modified, setModified] = useState(false);

  const handleResume = () => {
    if (modified) {
      try {
        const parsed = JSON.parse(editedInput);
        onResume(parsed);
      } catch {
        // If not valid JSON, pass as string
        onResume(editedInput);
      }
    } else {
      onResume();
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.6)',
      zIndex: 200,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e293b',
        borderRadius: 12,
        border: '2px solid #f59e0b',
        width: 560,
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        color: '#e2e8f0',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #334155',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>
              🔴 Breakpoint: {nodeName}
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
              Node: {nodeId} • Run: {runId.slice(0, 8)}...
            </div>
          </div>
          <button onClick={onClose} className="toolbar-btn" style={{ padding: '4px 8px' }}>✕</button>
        </div>

        {/* Input inspector */}
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 500 }}>
            Node Input {modified && <span style={{ color: '#f59e0b' }}>(modified)</span>}
          </div>
          <textarea
            value={editedInput}
            onChange={(e) => {
              setEditedInput(e.target.value);
              setModified(true);
            }}
            style={{
              width: '100%',
              minHeight: 200,
              padding: 12,
              borderRadius: 8,
              border: modified ? '2px solid #f59e0b' : '1px solid #475569',
              background: '#0f172a',
              color: '#e2e8f0',
              fontFamily: 'monospace',
              fontSize: 12,
              resize: 'vertical',
              outline: 'none',
            }}
          />
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
            Edit the input above to modify what this node receives, or resume with original input.
          </div>
        </div>

        {/* Actions */}
        <div style={{
          padding: '12px 20px',
          borderTop: '1px solid #334155',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
        }}>
          {modified && (
            <button
              onClick={() => { setEditedInput(typeof input === 'string' ? input : JSON.stringify(input, null, 2)); setModified(false); }}
              className="toolbar-btn"
            >
              ↩️ Reset
            </button>
          )}
          <button
            onClick={handleResume}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              background: '#22c55e',
              color: 'white',
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ▶️ Resume {modified ? '(with changes)' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

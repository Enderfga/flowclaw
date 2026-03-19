import { useState, useEffect, useCallback } from 'react';
import type { RunSummary } from '@council/core';

interface HistoryEntry extends RunSummary {}

interface HistoryResponse {
  total: number;
  offset: number;
  limit: number;
  runs: HistoryEntry[];
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  failed: '#ef4444',
  running: '#3b82f6',
  paused: '#f59e0b',
  cancelled: '#6b7280',
  pending: '#94a3b8',
};

const STATUS_ICONS: Record<string, string> = {
  completed: '✅',
  failed: '❌',
  running: '⏳',
  paused: '⏸️',
  cancelled: '🚫',
  pending: '🔄',
};

export default function HistoryPanel({ onClose, onLoadRun }: {
  onClose: () => void;
  onLoadRun?: (runId: string) => void;
}) {
  const [runs, setRuns] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/runs/history?limit=50');
      if (!res.ok) throw new Error('Failed to fetch history');
      const data: HistoryResponse = await res.json();
      setRuns(data.runs);
      setTotal(data.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const fetchDetail = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/detail`);
      if (!res.ok) return;
      const data = await res.json();
      setDetail(data);
      setSelectedRun(runId);
    } catch { /* ignore */ }
  }, []);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const formatDuration = (start: string, end?: string) => {
    if (!end) return '—';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: 420,
      background: '#0f172a',
      borderLeft: '1px solid #334155',
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      color: '#e2e8f0',
      fontSize: 13,
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #334155',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>📜 Execution History</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={fetchHistory} className="toolbar-btn" style={{ padding: '4px 8px' }}>↻</button>
          <button onClick={onClose} className="toolbar-btn" style={{ padding: '4px 8px' }}>✕</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        {loading && <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8' }}>Loading...</div>}
        {error && <div style={{ padding: 16, color: '#ef4444' }}>{error}</div>}
        
        {!loading && runs.length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8' }}>No runs yet</div>
        )}

        {runs.map(run => (
          <div
            key={run.id}
            onClick={() => fetchDetail(run.id)}
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid #1e293b',
              cursor: 'pointer',
              background: selectedRun === run.id ? '#1e293b' : 'transparent',
              transition: 'background 0.15s',
            }}
            onMouseOver={e => { if (selectedRun !== run.id) (e.currentTarget as HTMLDivElement).style.background = '#1e293b50'; }}
            onMouseOut={e => { if (selectedRun !== run.id) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontWeight: 500 }}>
                {STATUS_ICONS[run.status] ?? '❓'} {run.workflowName}
              </span>
              <span style={{ color: STATUS_COLORS[run.status], fontSize: 12 }}>
                {run.status}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: 11 }}>
              <span>{formatTime(run.startedAt)}</span>
              <span>{formatDuration(run.startedAt, run.completedAt)}</span>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11, color: '#94a3b8' }}>
              <span>🟢 {run.nodeSummary.completed}</span>
              {run.nodeSummary.failed > 0 && <span>🔴 {run.nodeSummary.failed}</span>}
              {run.nodeSummary.skipped > 0 && <span>⏭️ {run.nodeSummary.skipped}</span>}
              {run.cost && <span>💰 ${run.cost.totalUsd.toFixed(4)}</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Detail panel */}
      {detail && (
        <div style={{
          borderTop: '1px solid #334155',
          maxHeight: '40%',
          overflow: 'auto',
          padding: 16,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Run Detail: {detail.summary?.workflowName}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8 }}>
            ID: {detail.run?.id?.slice(0, 8)}...
          </div>

          {/* Node states */}
          {detail.run && Object.entries(detail.run.nodeStates).map(([nodeId, state]: [string, any]) => (
            <div key={nodeId} style={{
              padding: '6px 8px',
              marginBottom: 4,
              borderRadius: 4,
              background: '#1e293b',
              fontSize: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 500 }}>{nodeId}</span>
                <span style={{ color: STATUS_COLORS[state.status] ?? '#94a3b8' }}>{state.status}</span>
              </div>
              {state.output && (
                <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2, maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {typeof state.output === 'string' ? state.output.slice(0, 100) : JSON.stringify(state.output).slice(0, 100)}
                </div>
              )}
              {state.error && (
                <div style={{ color: '#ef4444', fontSize: 11, marginTop: 2 }}>{state.error}</div>
              )}
            </div>
          ))}

          {onLoadRun && detail.run && (
            <button
              onClick={() => onLoadRun(detail.run.id)}
              className="toolbar-btn"
              style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}
            >
              🔄 Load Workflow to Editor
            </button>
          )}
        </div>
      )}
    </div>
  );
}

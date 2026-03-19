import { useState, useCallback } from 'react';
import type { WorkflowDiff, WorkflowVersion, NodeDiff, EdgeDiff, PropertyChange } from '@council/core';

const API = (import.meta as any).env?.VITE_API_URL ?? '';

interface VersionPanelProps {
  workflowId: string | null;
  onRestore?: (workflow: unknown) => void;
}

type VersionMeta = Omit<WorkflowVersion, 'snapshot'>;

export function VersionPanel({ workflowId, onRestore }: VersionPanelProps) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [diff, setDiff] = useState<WorkflowDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFrom, setSelectedFrom] = useState<number | null>(null);
  const [selectedTo, setSelectedTo] = useState<number | null>(null);

  const fetchVersions = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/workflows/${workflowId}/versions`);
      if (res.ok) setVersions(await res.json());
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  const fetchDiff = useCallback(async () => {
    if (!workflowId || selectedFrom === null || selectedTo === null) return;
    const res = await fetch(`${API}/api/workflows/${workflowId}/diff?from=${selectedFrom}&to=${selectedTo}`);
    if (res.ok) setDiff(await res.json());
  }, [workflowId, selectedFrom, selectedTo]);

  const handleRestore = useCallback(async (version: number) => {
    if (!workflowId) return;
    if (!confirm(`Restore workflow to version ${version}?`)) return;
    const res = await fetch(`${API}/api/workflows/${workflowId}/restore/${version}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      onRestore?.(data.workflow);
      fetchVersions();
    }
  }, [workflowId, onRestore, fetchVersions]);

  const commitVersion = useCallback(async () => {
    if (!workflowId) return;
    const message = prompt('Version message (optional):') ?? undefined;
    const res = await fetch(`${API}/api/workflows/${workflowId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (res.ok) fetchVersions();
  }, [workflowId, fetchVersions]);

  if (!workflowId) {
    return <div style={styles.panel}><p style={styles.muted}>Save workflow to enable versioning</p></div>;
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <h3 style={styles.title}>📋 Version History</h3>
        <div style={styles.actions}>
          <button onClick={fetchVersions} style={styles.btn} title="Refresh">🔄</button>
          <button onClick={commitVersion} style={styles.btnPrimary} title="Save version">💾 Commit</button>
        </div>
      </div>

      {loading && <p style={styles.muted}>Loading...</p>}

      {versions.length > 0 && (
        <div style={styles.versionList}>
          {versions.slice().reverse().map((v) => (
            <div
              key={v.version}
              style={{
                ...styles.versionItem,
                borderLeft: (selectedFrom === v.version || selectedTo === v.version)
                  ? '3px solid #3b82f6'
                  : '3px solid transparent',
              }}
              onClick={() => {
                if (selectedFrom === null) setSelectedFrom(v.version);
                else if (selectedTo === null) { setSelectedTo(v.version); }
                else { setSelectedFrom(v.version); setSelectedTo(null); setDiff(null); }
              }}
            >
              <div style={styles.versionHeader}>
                <span style={styles.versionNum}>v{v.version}</span>
                <span style={styles.versionDate}>
                  {new Date(v.createdAt).toLocaleString()}
                </span>
              </div>
              <div style={styles.versionMsg}>{v.message}</div>
              {v.author && <div style={styles.versionAuthor}>by {v.author}</div>}
              <button
                onClick={(e) => { e.stopPropagation(); handleRestore(v.version); }}
                style={styles.restoreBtn}
                title="Restore this version"
              >
                ↩️ Restore
              </button>
            </div>
          ))}
        </div>
      )}

      {selectedFrom !== null && selectedTo !== null && (
        <div style={styles.diffSection}>
          <button onClick={fetchDiff} style={styles.btnPrimary}>
            Compare v{Math.min(selectedFrom, selectedTo)} → v{Math.max(selectedFrom, selectedTo)}
          </button>
          <button onClick={() => { setSelectedFrom(null); setSelectedTo(null); setDiff(null); }} style={styles.btn}>
            Clear
          </button>
        </div>
      )}

      {diff && <DiffView diff={diff} />}

      {versions.length === 0 && !loading && (
        <p style={styles.muted}>No versions yet. Click Commit to save the first version.</p>
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: WorkflowDiff }) {
  return (
    <div style={styles.diffContainer}>
      <div style={styles.diffHeader}>
        v{diff.fromVersion} → v{diff.toVersion}: <em>{diff.summary}</em>
      </div>

      {diff.nodes.length > 0 && (
        <div>
          <h4 style={styles.diffSectionTitle}>Nodes</h4>
          {diff.nodes.map((nd: NodeDiff, i: number) => (
            <div key={i} style={{ ...styles.diffItem, borderLeft: `3px solid ${diffColor(nd.type)}` }}>
              <span style={{ color: diffColor(nd.type), fontWeight: 'bold' }}>
                {diffIcon(nd.type)} {nd.nodeId}
              </span>
              {nd.nodeName && <span style={styles.muted}> ({nd.nodeName})</span>}
              {nd.changes && nd.changes.map((c: PropertyChange, j: number) => (
                <div key={j} style={styles.changeLine}>
                  <code>{c.path}</code>: {renderValue(c.before)} → {renderValue(c.after)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {diff.edges.length > 0 && (
        <div>
          <h4 style={styles.diffSectionTitle}>Edges</h4>
          {diff.edges.map((ed: EdgeDiff, i: number) => (
            <div key={i} style={{ ...styles.diffItem, borderLeft: `3px solid ${diffColor(ed.type)}` }}>
              <span style={{ color: diffColor(ed.type), fontWeight: 'bold' }}>
                {diffIcon(ed.type)} {ed.source} → {ed.target}
              </span>
            </div>
          ))}
        </div>
      )}

      {diff.metadata.length > 0 && (
        <div>
          <h4 style={styles.diffSectionTitle}>Metadata</h4>
          {diff.metadata.map((m: PropertyChange, i: number) => (
            <div key={i} style={styles.changeLine}>
              <code>{m.path}</code>: {renderValue(m.before)} → {renderValue(m.after)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function diffColor(type: string) {
  return type === 'added' ? '#22c55e' : type === 'removed' ? '#ef4444' : '#f59e0b';
}

function diffIcon(type: string) {
  return type === 'added' ? '+' : type === 'removed' ? '−' : '~';
}

function renderValue(v: unknown): string {
  if (v === undefined) return '∅';
  if (typeof v === 'string') return `"${v.length > 40 ? v.slice(0, 40) + '...' : v}"`;
  return JSON.stringify(v);
}

const styles: Record<string, React.CSSProperties> = {
  panel: { padding: 12, fontSize: 13, overflow: 'auto', maxHeight: 500 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  title: { margin: 0, fontSize: 14 },
  actions: { display: 'flex', gap: 4 },
  btn: { padding: '4px 8px', border: '1px solid #555', borderRadius: 4, background: '#2a2a2a', color: '#fff', cursor: 'pointer', fontSize: 12 },
  btnPrimary: { padding: '4px 8px', border: 'none', borderRadius: 4, background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 12 },
  muted: { color: '#888', fontSize: 12 },
  versionList: { display: 'flex', flexDirection: 'column', gap: 4 },
  versionItem: { padding: '6px 8px', background: '#1e1e1e', borderRadius: 4, cursor: 'pointer', position: 'relative' as const },
  versionHeader: { display: 'flex', justifyContent: 'space-between' },
  versionNum: { fontWeight: 'bold', color: '#60a5fa' },
  versionDate: { fontSize: 11, color: '#888' },
  versionMsg: { fontSize: 12, marginTop: 2 },
  versionAuthor: { fontSize: 11, color: '#888' },
  restoreBtn: { position: 'absolute' as const, right: 8, top: 6, fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: '#888' },
  diffSection: { display: 'flex', gap: 4, marginTop: 8 },
  diffContainer: { marginTop: 8, padding: 8, background: '#111', borderRadius: 4 },
  diffHeader: { fontSize: 12, marginBottom: 8, color: '#ccc' },
  diffSectionTitle: { margin: '8px 0 4px', fontSize: 12, color: '#aaa' },
  diffItem: { padding: '4px 8px', marginBottom: 4, fontSize: 12 },
  changeLine: { fontSize: 11, color: '#aaa', marginLeft: 12, marginTop: 2 },
};

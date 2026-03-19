import { useState, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import Canvas from './components/Canvas';
import NodePanel from './components/NodePanel';
import Inspector from './components/Inspector';
import Toolbar from './components/Toolbar';
import HistoryPanel from './components/HistoryPanel';
import BreakpointOverlay from './components/BreakpointOverlay';
import { VersionPanel } from './components/VersionPanel';
import { useWorkflowStore } from './stores/workflow';
import { useReconnectingWebSocket } from './hooks/useReconnectingWebSocket';
import type { NodeType } from '@council/core';

export default function App() {
  const { addNode, selectedNodeId } = useWorkflowStore();
  const [isRunning, setIsRunning] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [currentWorkflowId, setCurrentWorkflowId] = useState<string | null>(null);
  const [breakpointInfo, setBreakpointInfo] = useState<{
    runId: string;
    nodeId: string;
    nodeName: string;
    input: unknown;
  } | null>(null);
  const { connect: wsConnect, disconnect: wsDisconnect } = useReconnectingWebSocket();

  const handleAddNode = useCallback(
    (type: NodeType) => {
      // Add at center-ish with some randomness so they don't stack
      addNode(type, {
        x: 300 + Math.random() * 200,
        y: 200 + Math.random() * 200,
      });
    },
    [addNode],
  );

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    const { toJSON, updateNodeRunState, clearRunStates } = useWorkflowStore.getState();
    clearRunStates();

    const workflow = toJSON();

    try {
      // First save workflow to server
      const saveRes = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Live Run', ...workflow }),
      });
      if (!saveRes.ok) throw new Error('Server not available');
      const savedWf = await saveRes.json();
      setCurrentWorkflowId(savedWf.id);

      // Connect WebSocket with auto-reconnection for live updates
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

      const wsReady = new Promise<void>((resolve) => {
        wsConnect({
          url: wsUrl,
          maxRetries: 5,
          baseDelay: 1000,
          onOpen: () => resolve(),
          onMessage: (msg) => {
            try {
              const event = JSON.parse(msg.data);
              if (event.type === 'node:stream' && event.nodeId) {
                updateNodeRunState(event.nodeId, {
                  status: 'running',
                  output: event.data?.accumulated,
                });
              } else if (event.nodeId) {
                const status = event.type.split(':')[1] as string;
                if (status === 'breakpoint') {
                  updateNodeRunState(event.nodeId, { status: 'breakpoint' as any });
                  const node = useWorkflowStore.getState().toJSON().nodes.find((n: any) => n.id === event.nodeId);
                  setBreakpointInfo({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    nodeName: node?.config?.name ?? event.nodeId,
                    input: event.data?.input,
                  });
                } else {
                  updateNodeRunState(event.nodeId, {
                    status: status === 'start' ? 'running' : status === 'complete' ? 'completed' : status === 'fail' ? 'failed' : status === 'skip' ? 'skipped' : status === 'paused' ? 'paused' : 'waiting',
                    ...(event.data?.output ? { output: event.data.output } : {}),
                    ...(event.data?.error ? { error: event.data.error } : {}),
                    ...(event.data?.tokenUsage ? { tokenUsage: event.data.tokenUsage } : {}),
                    ...(status === 'start' ? { startedAt: event.timestamp } : {}),
                    ...(status !== 'start' ? { completedAt: event.timestamp } : {}),
                  });
                }
              }
              if (event.type === 'run:complete' || event.type === 'run:fail') {
                wsDisconnect();
                setIsRunning(false);
              }
            } catch { /* ignore parse errors */ }
          },
        });
        // Fallback timeout if WS can't connect
        setTimeout(resolve, 500);
      });

      await wsReady;

      // Start the run
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: savedWf.id, input: {} }),
      });
      if (!res.ok) throw new Error('Run failed to start');
      const runData = await res.json();

      // Fallback: poll run status in case WS missed events (e.g. mock provider is instant)
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/runs/${runData.id}`);
          if (!statusRes.ok) return;
          const run = await statusRes.json();
          if (run.status === 'completed' || run.status === 'failed') {
            clearInterval(pollInterval);
            // Update all node states from the final run
            for (const [nodeId, state] of Object.entries(run.nodeStates ?? {})) {
              updateNodeRunState(nodeId, state as any);
            }
            setIsRunning(false);
            wsDisconnect();
          }
        } catch { /* ignore */ }
      }, 1000);

      return; // WebSocket handles the rest
    } catch {
      // Mock execution for demo when server is not available
      for (const node of workflow.nodes) {
        updateNodeRunState(node.id, { status: 'running', startedAt: new Date().toISOString() });
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
        updateNodeRunState(node.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          output: { result: `Output from ${node.config.name}` },
          tokenUsage: node.type === 'agent' || node.type === 'planner'
            ? { prompt: Math.floor(Math.random() * 1000), completion: Math.floor(Math.random() * 500) }
            : undefined,
        });
      }
    }

    setIsRunning(false);
  }, []);

  return (
    <ReactFlowProvider>
      <div className="h-screen w-screen flex flex-col overflow-hidden">
        <Toolbar onRun={handleRun} isRunning={isRunning} onShowHistory={() => setShowHistory(true)} onShowVersions={() => setShowVersions(!showVersions)} />
        <div className="flex flex-1 overflow-hidden">
          <NodePanel onAddNode={handleAddNode} />
          <Canvas />
          <div className="flex flex-col">
            {selectedNodeId && <Inspector />}
            {showVersions && (
              <div className="w-72 bg-slate-800 border-l border-slate-700 overflow-auto">
                <VersionPanel workflowId={currentWorkflowId} onRestore={(wf) => {
                  const { loadFromJSON } = useWorkflowStore.getState();
                  loadFromJSON(wf as any);
                }} />
              </div>
            )}
          </div>
        </div>
      </div>

      {showHistory && (
        <HistoryPanel
          onClose={() => setShowHistory(false)}
          onLoadRun={(runId) => {
            // TODO: load workflow from run into editor
            setShowHistory(false);
          }}
        />
      )}

      {breakpointInfo && (
        <BreakpointOverlay
          runId={breakpointInfo.runId}
          nodeId={breakpointInfo.nodeId}
          nodeName={breakpointInfo.nodeName}
          input={breakpointInfo.input}
          onResume={async (modifiedInput) => {
            try {
              await fetch(`/api/runs/${breakpointInfo.runId}/breakpoints/${breakpointInfo.nodeId}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modifiedInput }),
              });
            } catch { /* ignore */ }
            setBreakpointInfo(null);
          }}
          onClose={() => setBreakpointInfo(null)}
        />
      )}

      <style>{`
        .input-field {
          width: 100%;
          padding: 6px 10px;
          border-radius: 6px;
          border: 1px solid #475569;
          background: #1e293b;
          color: #e2e8f0;
          font-size: 13px;
          outline: none;
          transition: border-color 0.2s;
        }
        .input-field:focus {
          border-color: #3b82f6;
        }
        .toolbar-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 10px;
          border-radius: 6px;
          background: #334155;
          color: #cbd5e1;
          font-size: 13px;
          border: none;
          cursor: pointer;
          transition: background 0.2s;
        }
        .toolbar-btn:hover {
          background: #475569;
        }
      `}</style>
    </ReactFlowProvider>
  );
}

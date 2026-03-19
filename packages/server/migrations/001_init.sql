-- Council SQLite Schema v1
-- Workflows, Runs, and Versions

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nodes TEXT NOT NULL DEFAULT '[]',       -- JSON array of DAGNode
  edges TEXT NOT NULL DEFAULT '[]',       -- JSON array of DAGEdge
  variables TEXT DEFAULT NULL,            -- JSON object or null
  metadata TEXT NOT NULL DEFAULT '{}',    -- JSON WorkflowMetadata
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input TEXT DEFAULT NULL,                -- JSON
  node_states TEXT NOT NULL DEFAULT '{}', -- JSON Record<string, NodeRunState>
  started_at TEXT NOT NULL,
  completed_at TEXT DEFAULT NULL,
  total_token_usage TEXT DEFAULT NULL,    -- JSON TokenUsage
  cost TEXT DEFAULT NULL,                 -- JSON CostEstimate
  variables TEXT DEFAULT NULL,            -- JSON
  paused_nodes TEXT DEFAULT NULL,         -- JSON string[]
  breakpoints TEXT DEFAULT NULL,          -- JSON string[]
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_workflow_id ON runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,                 -- JSON Workflow
  message TEXT DEFAULT NULL,
  author TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workflow_id, version),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_versions_workflow_id ON versions(workflow_id);

// ============================================================
// SQLite-backed persistent storage for Council
// Replaces the in-memory Map-based MVP storage
// ============================================================

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workflow, Run } from '@council/core';
import type { WorkflowVersion } from '@council/core';

// ---------- Database initialization ----------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getDbPath(): string {
  const envPath = process.env.COUNCIL_DB_PATH;
  if (envPath) return resolve(envPath);

  // Default: data/council.db relative to project root
  const dataDir = resolve(__dirname, '..', '..', '..', 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return resolve(dataDir, 'council.db');
}

let db: Database.Database;

function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.COUNCIL_DB === ':memory:' ? ':memory:' : getDbPath();
  db = new Database(dbPath);

  // Performance tuning
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Run migrations
  runMigrations(db);

  console.log(`💾 SQLite storage initialized: ${dbPath}`);
  return db;
}

function runMigrations(database: Database.Database): void {
  const migrationPath = resolve(__dirname, '..', 'migrations', '001_init.sql');
  if (existsSync(migrationPath)) {
    const sql = readFileSync(migrationPath, 'utf-8');
    database.exec(sql);
  } else {
    // Inline fallback if migration file not found (e.g., running from dist/)
    database.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nodes TEXT NOT NULL DEFAULT '[]',
        edges TEXT NOT NULL DEFAULT '[]',
        variables TEXT DEFAULT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        input TEXT DEFAULT NULL,
        node_states TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT DEFAULT NULL,
        total_token_usage TEXT DEFAULT NULL,
        cost TEXT DEFAULT NULL,
        variables TEXT DEFAULT NULL,
        paused_nodes TEXT DEFAULT NULL,
        breakpoints TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_workflow_id ON runs(workflow_id);
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        message TEXT DEFAULT NULL,
        author TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(workflow_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_versions_workflow_id ON versions(workflow_id);
    `);
  }
}

// ---------- Workflow serialization ----------

function workflowToRow(wf: Workflow) {
  return {
    id: wf.id,
    name: wf.name,
    nodes: JSON.stringify(wf.nodes),
    edges: JSON.stringify(wf.edges),
    variables: wf.variables ? JSON.stringify(wf.variables) : null,
    metadata: JSON.stringify(wf.metadata),
    created_at: wf.metadata?.created ?? new Date().toISOString(),
    updated_at: wf.metadata?.updated ?? new Date().toISOString(),
  };
}

function rowToWorkflow(row: any): Workflow {
  return {
    id: row.id,
    name: row.name,
    nodes: JSON.parse(row.nodes),
    edges: JSON.parse(row.edges),
    variables: row.variables ? JSON.parse(row.variables) : undefined,
    metadata: JSON.parse(row.metadata),
  };
}

// ---------- Run serialization ----------

function runToRow(run: Run) {
  return {
    id: run.id,
    workflow_id: run.workflowId,
    status: run.status,
    input: JSON.stringify(run.input),
    node_states: JSON.stringify(run.nodeStates),
    started_at: run.startedAt,
    completed_at: run.completedAt ?? null,
    total_token_usage: run.totalTokenUsage ? JSON.stringify(run.totalTokenUsage) : null,
    cost: run.cost ? JSON.stringify(run.cost) : null,
    variables: run.variables ? JSON.stringify(run.variables) : null,
    paused_nodes: run.pausedNodes ? JSON.stringify(run.pausedNodes) : null,
    breakpoints: run.breakpoints ? JSON.stringify(run.breakpoints) : null,
  };
}

function rowToRun(row: any): Run {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    input: JSON.parse(row.input ?? 'null'),
    nodeStates: JSON.parse(row.node_states),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    totalTokenUsage: row.total_token_usage ? JSON.parse(row.total_token_usage) : undefined,
    cost: row.cost ? JSON.parse(row.cost) : undefined,
    variables: row.variables ? JSON.parse(row.variables) : undefined,
    pausedNodes: row.paused_nodes ? JSON.parse(row.paused_nodes) : undefined,
    breakpoints: row.breakpoints ? JSON.parse(row.breakpoints) : undefined,
  };
}

// ---------- Public storage interface ----------
// Same interface as the original in-memory storage for drop-in replacement

export const storage = {
  // Workflows
  getWorkflow(id: string): Workflow | undefined {
    const row = getDb().prepare('SELECT * FROM workflows WHERE id = ?').get(id);
    return row ? rowToWorkflow(row) : undefined;
  },

  listWorkflows(): Workflow[] {
    const rows = getDb().prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all();
    return rows.map(rowToWorkflow);
  },

  saveWorkflow(wf: Workflow): void {
    const row = workflowToRow(wf);
    getDb().prepare(`
      INSERT INTO workflows (id, name, nodes, edges, variables, metadata, created_at, updated_at)
      VALUES (@id, @name, @nodes, @edges, @variables, @metadata, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        nodes = @nodes,
        edges = @edges,
        variables = @variables,
        metadata = @metadata,
        updated_at = @updated_at
    `).run(row);
  },

  deleteWorkflow(id: string): boolean {
    const result = getDb().prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return result.changes > 0;
  },

  // Runs
  getRun(id: string): Run | undefined {
    const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? rowToRun(row) : undefined;
  },

  listRuns(workflowId?: string): Run[] {
    if (workflowId) {
      const rows = getDb().prepare('SELECT * FROM runs WHERE workflow_id = ? ORDER BY started_at DESC').all(workflowId);
      return rows.map(rowToRun);
    }
    const rows = getDb().prepare('SELECT * FROM runs ORDER BY started_at DESC').all();
    return rows.map(rowToRun);
  },

  saveRun(run: Run): void {
    const row = runToRow(run);
    getDb().prepare(`
      INSERT INTO runs (id, workflow_id, status, input, node_states, started_at, completed_at, total_token_usage, cost, variables, paused_nodes, breakpoints)
      VALUES (@id, @workflow_id, @status, @input, @node_states, @started_at, @completed_at, @total_token_usage, @cost, @variables, @paused_nodes, @breakpoints)
      ON CONFLICT(id) DO UPDATE SET
        status = @status,
        node_states = @node_states,
        completed_at = @completed_at,
        total_token_usage = @total_token_usage,
        cost = @cost,
        variables = @variables,
        paused_nodes = @paused_nodes,
        breakpoints = @breakpoints
    `).run(row);
  },

  // Versions (T5A.2 — persist VersionStore)
  commitVersion(workflowId: string, version: number, snapshot: Workflow, message?: string, author?: string): void {
    getDb().prepare(`
      INSERT INTO versions (workflow_id, version, snapshot, message, author)
      VALUES (?, ?, ?, ?, ?)
    `).run(workflowId, version, JSON.stringify(snapshot), message ?? `Version ${version}`, author ?? null);
  },

  listVersions(workflowId: string): Array<{ version: number; message?: string; createdAt: string; author?: string }> {
    const rows = getDb().prepare(
      'SELECT version, message, author, created_at FROM versions WHERE workflow_id = ? ORDER BY version ASC'
    ).all(workflowId) as any[];
    return rows.map((r) => ({
      version: r.version,
      message: r.message ?? undefined,
      createdAt: r.created_at,
      author: r.author ?? undefined,
    }));
  },

  getVersion(workflowId: string, version: number): { version: number; snapshot: Workflow; message?: string; createdAt: string; author?: string } | undefined {
    const row = getDb().prepare(
      'SELECT * FROM versions WHERE workflow_id = ? AND version = ?'
    ).get(workflowId, version) as any;
    if (!row) return undefined;
    return {
      version: row.version,
      snapshot: JSON.parse(row.snapshot),
      message: row.message ?? undefined,
      createdAt: row.created_at,
      author: row.author ?? undefined,
    };
  },

  latestVersion(workflowId: string): number {
    const row = getDb().prepare(
      'SELECT MAX(version) as max_ver FROM versions WHERE workflow_id = ?'
    ).get(workflowId) as any;
    return row?.max_ver ?? 0;
  },

  deleteVersions(workflowId: string): void {
    getDb().prepare('DELETE FROM versions WHERE workflow_id = ?').run(workflowId);
  },

  // Utility
  close(): void {
    if (db) {
      db.close();
      db = undefined as any;
    }
  },

  /** Reset for testing — only use with :memory: databases */
  _reset(): void {
    if (db) {
      db.exec('DELETE FROM versions');
      db.exec('DELETE FROM runs');
      db.exec('DELETE FROM workflows');
    }
  },
};

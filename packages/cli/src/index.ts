#!/usr/bin/env node
// ============================================================
// @council/cli — CLI Entry Point
// ============================================================
//
// Usage:
//   council run <workflow.json> [--input <json>] [--concurrency <n>] [--verbose]
//   council validate <workflow.json>
//   council visualize <workflow.json>
//   council list [--server <url>]
//   council templates [--server <url>]
//   council status [--server <url>]

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { Workflow, ExecutionEvent } from '@council/core';
import { DAGExecutor, validateWorkflow, topologicalSort } from '@council/core';

// ---------- Argument Parsing ----------

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getOption(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ---------- Colors (ANSI) ----------

const isColor = process.env.NO_COLOR === undefined && process.stdout.isTTY;

const c = isColor ? {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m',
} : {
  reset: '', bold: '', dim: '', red: '', green: '', yellow: '',
  blue: '', magenta: '', cyan: '', white: '',
  bgGreen: '', bgRed: '', bgYellow: '', bgBlue: '', bgCyan: '',
};

// ---------- Node type styling ----------

const nodeIcons: Record<string, string> = {
  input: '📥', output: '📤', agent: '🤖', tool: '🔧',
  condition: '🔀', merge: '🔗', loop: '🔄', human: '👤',
  planner: '🧠', subworkflow: '📦',
};

const nodeColors: Record<string, string> = {
  input: c.green, output: c.red, agent: c.blue,
  tool: c.yellow, condition: c.magenta, merge: c.cyan,
  loop: c.yellow, human: c.magenta, planner: c.blue,
  subworkflow: c.cyan,
};

// ---------- Commands ----------

async function run() {
  const file = args[1];
  if (!file) {
    console.error(`${c.red}Usage: council run <workflow.json>${c.reset}`);
    process.exit(1);
  }

  const workflow = loadWorkflow(file);
  const verbose = getFlag('verbose');
  const concurrency = parseInt(getOption('concurrency') ?? '10', 10);
  let input: unknown = {};

  const inputStr = getOption('input');
  if (inputStr) {
    try { input = JSON.parse(inputStr); } catch { input = inputStr; }
  }

  // Validate first
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    printHeader('VALIDATION FAILED', c.bgRed);
    for (const err of validation.errors) {
      console.error(`  ${c.red}✗ ${err.message}${c.reset}`);
    }
    process.exit(1);
  }

  for (const warn of validation.warnings) {
    console.warn(`  ${c.yellow}⚠ ${warn.message}${c.reset}`);
  }

  printHeader(`RUNNING: ${workflow.name}`, c.bgBlue);
  console.log(`  ${c.dim}Nodes: ${workflow.nodes.length} | Edges: ${workflow.edges.length} | Concurrency: ${concurrency}${c.reset}\n`);

  // Build a live node status tracker
  const nodeStatus = new Map<string, { status: string; startTime?: number; elapsed?: string }>();
  for (const node of workflow.nodes) {
    nodeStatus.set(node.id, { status: 'waiting' });
  }

  const startTime = Date.now();

  const executor = new DAGExecutor({
    maxConcurrency: concurrency,
    onEvent: (event: ExecutionEvent) => {
      updateNodeStatus(event, nodeStatus);
      if (verbose) logEventVerbose(event, workflow);
      else logEventCompact(event, workflow);
    },
  });

  try {
    const result = await executor.execute(workflow, input);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log();
    printHeader(`COMPLETED in ${elapsed}s`, c.bgGreen);

    // Show outputs
    const outputNodes = workflow.nodes.filter((n) => n.type === 'output');
    if (outputNodes.length > 0) {
      console.log(`\n  ${c.bold}Outputs:${c.reset}`);
      for (const node of outputNodes) {
        const state = result.nodeStates[node.id];
        console.log(`  ${c.cyan}${node.config.name}:${c.reset} ${formatOutput(state?.output)}`);
      }
    }

    // Token usage summary
    if (result.totalTokenUsage && (result.totalTokenUsage.prompt > 0 || result.totalTokenUsage.completion > 0)) {
      const total = result.totalTokenUsage.prompt + result.totalTokenUsage.completion;
      console.log(`\n  ${c.dim}Tokens: ${result.totalTokenUsage.prompt} prompt + ${result.totalTokenUsage.completion} completion = ${total} total${c.reset}`);
    }

    // Cost
    if (result.cost && result.cost.totalUsd > 0) {
      console.log(`  ${c.dim}Cost: $${result.cost.totalUsd.toFixed(4)}${c.reset}`);
    }

    // Node execution summary table
    printNodeSummary(result.nodeStates, workflow);

    // Show failed nodes
    const failedNodes = Object.entries(result.nodeStates).filter(([_, s]) => s.status === 'failed');
    if (failedNodes.length > 0) {
      console.log(`\n  ${c.red}${c.bold}Failed nodes:${c.reset}`);
      for (const [id, state] of failedNodes) {
        const node = workflow.nodes.find((n) => n.id === id);
        console.log(`  ${c.red}✗ ${node?.config.name ?? id}: ${state.error}${c.reset}`);
      }
    }
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log();
    printHeader(`FAILED after ${elapsed}s`, c.bgRed);
    console.error(`  ${c.red}${err}${c.reset}`);
    process.exit(1);
  }
}

function validate() {
  const file = args[1];
  if (!file) {
    console.error(`${c.red}Usage: council validate <workflow.json>${c.reset}`);
    process.exit(1);
  }

  const workflow = loadWorkflow(file);
  const result = validateWorkflow(workflow);

  if (result.valid) {
    printHeader('VALID', c.bgGreen);
    const sorted = topologicalSort(workflow.nodes, workflow.edges);
    if (sorted) {
      console.log(`\n  ${c.bold}Execution order:${c.reset}`);
      sorted.forEach((id, i) => {
        const node = workflow.nodes.find((n) => n.id === id)!;
        const icon = nodeIcons[node.type] ?? '•';
        const color = nodeColors[node.type] ?? '';
        console.log(`  ${c.dim}${String(i + 1).padStart(2)}.${c.reset} ${icon} ${color}${node.config.name}${c.reset} ${c.dim}(${node.type})${c.reset}`);
      });
    }
  } else {
    printHeader('INVALID', c.bgRed);
    for (const err of result.errors) {
      console.error(`  ${c.red}✗ ${err.message}${c.reset}`);
    }
  }

  for (const warn of result.warnings) {
    console.warn(`  ${c.yellow}⚠ ${warn.message}${c.reset}`);
  }

  process.exit(result.valid ? 0 : 1);
}

function visualize() {
  const file = args[1];
  if (!file) {
    console.error(`${c.red}Usage: council visualize <workflow.json>${c.reset}`);
    process.exit(1);
  }

  const workflow = loadWorkflow(file);
  const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));

  printHeader(`WORKFLOW: ${workflow.name}`, c.bgCyan);
  if (workflow.metadata?.description) {
    console.log(`  ${c.dim}${workflow.metadata.description}${c.reset}`);
  }
  console.log(`  ${c.dim}Nodes: ${workflow.nodes.length} | Edges: ${workflow.edges.length}${c.reset}\n`);

  for (const node of workflow.nodes) {
    const icon = nodeIcons[node.type] ?? '•';
    const color = nodeColors[node.type] ?? '';
    const outEdges = workflow.edges.filter((e) => e.source === node.id);
    const inEdges = workflow.edges.filter((e) => e.target === node.id);

    const inputs = inEdges.map((e) => nodeMap.get(e.source)?.config.name ?? e.source).join(', ');
    const outputs = outEdges.map((e) => nodeMap.get(e.target)?.config.name ?? e.target).join(', ');

    console.log(`  ${icon} ${color}${c.bold}${node.config.name}${c.reset} ${c.dim}(${node.type})${c.reset}`);
    if (node.config.model) console.log(`    ${c.dim}model: ${node.config.model}${c.reset}`);
    if (node.config.systemPrompt) {
      const prompt = node.config.systemPrompt.length > 60
        ? node.config.systemPrompt.slice(0, 60) + '...'
        : node.config.systemPrompt;
      console.log(`    ${c.dim}prompt: "${prompt}"${c.reset}`);
    }
    if (inputs) console.log(`    ${c.green}← ${inputs}${c.reset}`);
    if (outputs) console.log(`    ${c.blue}→ ${outputs}${c.reset}`);
    console.log();
  }
}

async function listWorkflows() {
  const serverUrl = getOption('server') ?? 'http://localhost:3001';
  try {
    const resp = await fetch(`${serverUrl}/api/workflows`);
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const workflows = await resp.json() as Workflow[];

    if (workflows.length === 0) {
      console.log(`${c.dim}No workflows found on ${serverUrl}${c.reset}`);
      return;
    }

    printHeader(`WORKFLOWS (${workflows.length})`, c.bgCyan);
    console.log();

    const idWidth = 8;
    const nameWidth = 30;
    console.log(`  ${c.bold}${'ID'.padEnd(idWidth)}  ${'Name'.padEnd(nameWidth)}  Nodes  Updated${c.reset}`);
    console.log(`  ${c.dim}${'─'.repeat(idWidth)}  ${'─'.repeat(nameWidth)}  ${'─'.repeat(5)}  ${'─'.repeat(20)}${c.reset}`);

    for (const wf of workflows) {
      const shortId = wf.id.slice(0, 8);
      const name = wf.name.length > nameWidth ? wf.name.slice(0, nameWidth - 3) + '...' : wf.name;
      const nodeCount = String(wf.nodes.length).padStart(5);
      const updated = wf.metadata?.updated?.slice(0, 16) ?? 'unknown';
      console.log(`  ${c.cyan}${shortId.padEnd(idWidth)}${c.reset}  ${name.padEnd(nameWidth)}  ${nodeCount}  ${c.dim}${updated}${c.reset}`);
    }
  } catch (err) {
    console.error(`${c.red}✗ Cannot connect to server at ${serverUrl}${c.reset}`);
    console.error(`  ${c.dim}Start the server with: pnpm dev:server${c.reset}`);
    process.exit(1);
  }
}

async function listTemplates() {
  // Try server first, fall back to local files
  const serverUrl = getOption('server') ?? 'http://localhost:3001';
  let templates: Array<{ name: string; filename: string; nodes: number; description?: string }> = [];

  try {
    const resp = await fetch(`${serverUrl}/api/templates`);
    if (resp.ok) {
      templates = await resp.json() as typeof templates;
    }
  } catch {
    // Fall back to local templates directory
  }

  if (templates.length === 0) {
    // Try loading from local workflows/ directory
    const dirs = [
      resolve(process.cwd(), 'workflows'),
      resolve(process.cwd(), 'workflows/templates'),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const wf = JSON.parse(readFileSync(resolve(dir, file), 'utf-8'));
          templates.push({
            name: wf.name ?? file.replace('.json', ''),
            filename: file,
            nodes: wf.nodes?.length ?? 0,
            description: wf.metadata?.description,
          });
        } catch { /* skip invalid files */ }
      }
    }
  }

  if (templates.length === 0) {
    console.log(`${c.dim}No templates found${c.reset}`);
    return;
  }

  printHeader(`TEMPLATES (${templates.length})`, c.bgCyan);
  console.log();

  for (const t of templates) {
    console.log(`  ${c.cyan}${c.bold}${t.name}${c.reset} ${c.dim}(${t.filename}, ${t.nodes} nodes)${c.reset}`);
    if (t.description) {
      console.log(`    ${c.dim}${t.description}${c.reset}`);
    }
  }
}

async function serverStatus() {
  const serverUrl = getOption('server') ?? 'http://localhost:3001';
  try {
    const [healthResp, providersResp] = await Promise.all([
      fetch(`${serverUrl}/health`),
      fetch(`${serverUrl}/api/providers`),
    ]);

    if (!healthResp.ok) throw new Error(`Health check failed: ${healthResp.status}`);

    const health = await healthResp.json() as { status: string; timestamp: string };
    const providers = await providersResp.json() as Array<{ name: string; type: 'real' | 'mock' }>;

    printHeader('SERVER STATUS', c.bgGreen);
    console.log(`\n  ${c.green}●${c.reset} Server: ${c.bold}${serverUrl}${c.reset}`);
    console.log(`  ${c.dim}Timestamp: ${health.timestamp}${c.reset}`);

    console.log(`\n  ${c.bold}Providers:${c.reset}`);
    for (const p of providers) {
      const icon = p.type === 'real' ? `${c.green}●${c.reset}` : `${c.yellow}○${c.reset}`;
      const label = p.type === 'real' ? `${c.green}real API${c.reset}` : `${c.yellow}mock${c.reset}`;
      console.log(`  ${icon} ${p.name.padEnd(10)} ${label}`);
    }

    // Workflow count
    try {
      const wfResp = await fetch(`${serverUrl}/api/workflows`);
      const wfs = await wfResp.json() as Workflow[];
      console.log(`\n  ${c.dim}Workflows: ${wfs.length} | Database: SQLite${c.reset}`);
    } catch { /* ignore */ }

  } catch (err) {
    printHeader('SERVER OFFLINE', c.bgRed);
    console.error(`\n  ${c.red}✗ Cannot reach ${serverUrl}${c.reset}`);
    console.error(`  ${c.dim}Start with: pnpm dev:server${c.reset}`);
    process.exit(1);
  }
}

// ---------- Helpers ----------

function printHeader(text: string, bgColor: string) {
  const padding = 2;
  const padded = ' '.repeat(padding) + text + ' '.repeat(padding);
  console.log(`\n${bgColor}${c.bold}${c.white}${padded}${c.reset}`);
}

function loadWorkflow(file: string): Workflow {
  const path = resolve(process.cwd(), file);
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as Workflow;
  } catch (err) {
    console.error(`${c.red}✗ Failed to load workflow: ${err}${c.reset}`);
    process.exit(1);
  }
}

function formatOutput(output: unknown): string {
  if (output === undefined) return `${c.dim}(none)${c.reset}`;
  if (typeof output === 'string') {
    return output.length > 200 ? output.slice(0, 200) + '...' : output;
  }
  const json = JSON.stringify(output, null, 2);
  return json.length > 500 ? json.slice(0, 500) + '...' : json;
}

function updateNodeStatus(event: ExecutionEvent, nodeStatus: Map<string, { status: string; startTime?: number; elapsed?: string }>) {
  if (!event.nodeId) return;
  const entry = nodeStatus.get(event.nodeId);
  if (!entry) return;

  if (event.type === 'node:start') {
    entry.status = 'running';
    entry.startTime = Date.now();
  } else if (event.type === 'node:complete') {
    entry.status = 'completed';
    entry.elapsed = entry.startTime ? `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s` : undefined;
  } else if (event.type === 'node:fail') {
    entry.status = 'failed';
    entry.elapsed = entry.startTime ? `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s` : undefined;
  } else if (event.type === 'node:skip') {
    entry.status = 'skipped';
  }
}

function logEventVerbose(event: ExecutionEvent, workflow: Workflow) {
  const node = event.nodeId ? workflow.nodes.find((n) => n.id === event.nodeId) : null;
  const name = node?.config.name ?? event.nodeId ?? '';
  const icon = node ? (nodeIcons[node.type] ?? '•') : '';

  switch (event.type) {
    case 'run:start':
      console.log(`  ${c.bold}▶ Execution started${c.reset}`);
      break;
    case 'node:start':
      console.log(`  ${icon} ${c.blue}START${c.reset} ${c.bold}${name}${c.reset}`);
      break;
    case 'node:complete':
      console.log(`  ${icon} ${c.green}DONE${c.reset}  ${c.bold}${name}${c.reset}`);
      if (event.data && typeof event.data === 'object' && 'output' in (event.data as any)) {
        const output = formatOutput((event.data as any).output);
        console.log(`    ${c.dim}→ ${output.slice(0, 150)}${c.reset}`);
      }
      break;
    case 'node:fail':
      console.log(`  ${icon} ${c.red}FAIL${c.reset}  ${c.bold}${name}${c.reset}`);
      if (event.data && typeof event.data === 'object' && 'error' in (event.data as any)) {
        console.log(`    ${c.red}${(event.data as any).error}${c.reset}`);
      }
      break;
    case 'node:skip':
      console.log(`  ${icon} ${c.dim}SKIP  ${name}${c.reset}`);
      break;
    case 'node:stream':
      // Show streaming content inline
      if (event.data && typeof event.data === 'object' && 'content' in (event.data as any)) {
        process.stdout.write(`${c.dim}${(event.data as any).content}${c.reset}`);
      }
      break;
    case 'run:complete':
      break; // Handled by the caller
    case 'run:fail':
      break;
    default:
      if (event.data) {
        console.log(`  ${c.dim}${event.type}: ${JSON.stringify(event.data).slice(0, 100)}${c.reset}`);
      }
  }
}

function logEventCompact(event: ExecutionEvent, workflow: Workflow) {
  const node = event.nodeId ? workflow.nodes.find((n) => n.id === event.nodeId) : null;
  const name = node?.config.name ?? event.nodeId ?? '';
  const icon = node ? (nodeIcons[node.type] ?? '•') : '';

  switch (event.type) {
    case 'node:start':
      console.log(`  ${icon} ${c.blue}▶${c.reset} ${name}`);
      break;
    case 'node:complete':
      console.log(`  ${icon} ${c.green}✓${c.reset} ${name}`);
      break;
    case 'node:fail':
      console.log(`  ${icon} ${c.red}✗${c.reset} ${name}`);
      break;
    case 'node:skip':
      console.log(`  ${icon} ${c.dim}⏭ ${name}${c.reset}`);
      break;
  }
}

function printNodeSummary(nodeStates: Record<string, any>, workflow: Workflow) {
  const entries = Object.entries(nodeStates);
  if (entries.length === 0) return;

  console.log(`\n  ${c.bold}Node Summary:${c.reset}`);
  const nameWidth = 25;
  console.log(`  ${'Name'.padEnd(nameWidth)}  Status      Tokens`);
  console.log(`  ${c.dim}${'─'.repeat(nameWidth)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}${c.reset}`);

  for (const [id, state] of entries) {
    const node = workflow.nodes.find((n) => n.id === id);
    const name = (node?.config.name ?? id);
    const displayName = name.length > nameWidth ? name.slice(0, nameWidth - 3) + '...' : name.padEnd(nameWidth);

    let statusStr: string;
    switch (state.status) {
      case 'completed': statusStr = `${c.green}completed${c.reset} `; break;
      case 'failed': statusStr = `${c.red}failed${c.reset}    `; break;
      case 'skipped': statusStr = `${c.dim}skipped${c.reset}   `; break;
      case 'running': statusStr = `${c.blue}running${c.reset}   `; break;
      default: statusStr = `${c.dim}${state.status.padEnd(10)}${c.reset}`;
    }

    const tokens = state.tokenUsage
      ? `${state.tokenUsage.prompt + state.tokenUsage.completion}`
      : `${c.dim}-${c.reset}`;

    console.log(`  ${displayName}  ${statusStr}  ${tokens}`);
  }
}

// ---------- Main ----------

switch (command) {
  case 'run':
    run();
    break;
  case 'validate':
    validate();
    break;
  case 'visualize':
  case 'viz':
    visualize();
    break;
  case 'list':
  case 'ls':
    listWorkflows();
    break;
  case 'templates':
  case 'tpl':
    listTemplates();
    break;
  case 'status':
    serverStatus();
    break;
  default:
    console.log(`
${c.bold}${c.cyan}council${c.reset} — DAG-based AI Agent Orchestration

${c.bold}Local commands:${c.reset}
  ${c.green}run${c.reset} <workflow.json>       Execute a workflow locally
    --input <json>             Input data (JSON string)
    --concurrency <n>          Max parallel nodes (default: 10)
    --verbose                  Show detailed execution events

  ${c.green}validate${c.reset} <workflow.json>  Validate a workflow definition

  ${c.green}visualize${c.reset} <workflow.json> Show workflow structure (alias: viz)

${c.bold}Server commands:${c.reset} ${c.dim}(--server <url>, default: http://localhost:3001)${c.reset}
  ${c.green}list${c.reset}                     List workflows on server (alias: ls)
  ${c.green}templates${c.reset}                List available templates (alias: tpl)
  ${c.green}status${c.reset}                   Show server & provider status
`);
    process.exit(command ? 1 : 0);
}

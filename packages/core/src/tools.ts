// ============================================================
// @council/core — Tool Executor (T1.7)
// ============================================================

import type { ToolConfig } from './types.js';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

/**
 * Execute a tool configuration.
 * Supports: shell, http, function (plugin).
 */
export async function executeTool(
  tool: ToolConfig,
  input: unknown
): Promise<ToolResult> {
  switch (tool.type) {
    case 'shell':
      return executeShellTool(tool, input);
    case 'http':
      return executeHttpTool(tool, input);
    case 'function':
      return { success: false, output: '', error: 'Function tools require a registered handler' };
    default:
      return { success: false, output: '', error: `Unknown tool type: ${tool.type}` };
  }
}

async function executeShellTool(tool: ToolConfig, input: unknown): Promise<ToolResult> {
  const { spawn } = await import('node:child_process');
  const command = tool.config.command as string;
  if (!command) {
    return { success: false, output: '', error: 'Shell tool requires a "command" in config' };
  }

  // Template the input into the command
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
  const finalCommand = command.replace(/\{\{input\}\}/g, inputStr);

  const cwd = (tool.config.cwd as string) || process.cwd();
  const timeout = (tool.config.timeoutMs as number) || 30_000;

  return new Promise<ToolResult>((resolve) => {
    const proc = spawn('sh', ['-c', finalCommand], {
      cwd,
      timeout,
      env: { ...process.env, ...(tool.config.env as Record<string, string> ?? {}) },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout.trim(),
        error: stderr.trim() || undefined,
        exitCode: code ?? 1,
      });
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

async function executeHttpTool(tool: ToolConfig, input: unknown): Promise<ToolResult> {
  const url = tool.config.url as string;
  if (!url) {
    return { success: false, output: '', error: 'HTTP tool requires a "url" in config' };
  }

  const method = (tool.config.method as string) ?? 'POST';
  const headers = (tool.config.headers as Record<string, string>) ?? { 'Content-Type': 'application/json' };
  const timeout = (tool.config.timeoutMs as number) || 30_000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method,
      headers,
      body: method !== 'GET' ? JSON.stringify(input) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);

    const text = await response.text();
    return {
      success: response.ok,
      output: text,
      error: response.ok ? undefined : `HTTP ${response.status}: ${text.slice(0, 500)}`,
    };
  } catch (err) {
    return { success: false, output: '', error: String(err) };
  }
}

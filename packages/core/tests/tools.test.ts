import { describe, it, expect } from 'vitest';
import { executeTool } from '../src/tools.js';
import type { ToolConfig } from '../src/types.js';

describe('executeTool', () => {
  it('executes a shell tool (echo)', async () => {
    const tool: ToolConfig = {
      name: 'echo',
      type: 'shell',
      config: { command: 'echo "hello world"' },
    };
    const result = await executeTool(tool, {});
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
    expect(result.exitCode).toBe(0);
  });

  it('templates {{input}} into shell command', async () => {
    const tool: ToolConfig = {
      name: 'echo-input',
      type: 'shell',
      config: { command: 'echo "got: {{input}}"' },
    };
    const result = await executeTool(tool, 'test-value');
    expect(result.success).toBe(true);
    expect(result.output).toContain('got: test-value');
  });

  it('handles shell command failure', async () => {
    const tool: ToolConfig = {
      name: 'fail',
      type: 'shell',
      config: { command: 'exit 42' },
    };
    const result = await executeTool(tool, {});
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it('requires command for shell tool', async () => {
    const tool: ToolConfig = {
      name: 'no-cmd',
      type: 'shell',
      config: {},
    };
    const result = await executeTool(tool, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('command');
  });

  it('requires url for http tool', async () => {
    const tool: ToolConfig = {
      name: 'no-url',
      type: 'http',
      config: {},
    };
    const result = await executeTool(tool, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('url');
  });

  it('rejects unknown tool type', async () => {
    const tool: ToolConfig = {
      name: 'unknown',
      type: 'function',
      config: {},
    };
    const result = await executeTool(tool, {});
    expect(result.success).toBe(false);
  });
});

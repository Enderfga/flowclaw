import { describe, it, expect, vi } from 'vitest';
import {
  planWorkflow,
  autoFixWorkflow,
  PLANNER_SYSTEM_PROMPT,
  type PlannerOptions,
} from '../src/planner.js';
import type { AgentProvider, Workflow } from '../src/types.js';

// ---------- Mock Provider ----------

function mockProvider(responseContent: string): AgentProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: responseContent,
      tokenUsage: { prompt: 100, completion: 200 },
      model: 'mock-model',
    }),
  };
}

// A well-formed DAG response from the "LLM"
const VALID_WORKFLOW_JSON = JSON.stringify({
  name: 'Research & Write',
  description: 'Research a topic and write an article',
  nodes: [
    { id: 'input', type: 'input', position: { x: 400, y: 0 }, config: { name: 'Task Input' } },
    {
      id: 'researcher',
      type: 'agent',
      position: { x: 400, y: 150 },
      config: {
        name: 'Researcher',
        systemPrompt: 'You research topics thoroughly.',
        model: 'gpt-5.4',
        inputTemplate: '{{input.output}}',
      },
    },
    {
      id: 'writer',
      type: 'agent',
      position: { x: 400, y: 300 },
      config: {
        name: 'Writer',
        systemPrompt: 'You write compelling articles based on research.',
        model: 'gpt-5.4',
        inputTemplate: 'Research findings:\n{{researcher.output}}',
      },
    },
    { id: 'output', type: 'output', position: { x: 400, y: 450 }, config: { name: 'Final Article' } },
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'researcher' },
    { id: 'e2', source: 'researcher', target: 'writer' },
    { id: 'e3', source: 'writer', target: 'output' },
  ],
});

// A parallel DAG
const PARALLEL_WORKFLOW_JSON = JSON.stringify({
  name: 'Parallel Code Review',
  description: 'Three reviewers in parallel, then merge',
  nodes: [
    { id: 'input', type: 'input', position: { x: 400, y: 0 }, config: { name: 'Code' } },
    {
      id: 'security',
      type: 'agent',
      position: { x: 150, y: 150 },
      config: { name: 'Security Reviewer', systemPrompt: 'Review for security issues.', model: 'gpt-5.4' },
    },
    {
      id: 'perf',
      type: 'agent',
      position: { x: 400, y: 150 },
      config: { name: 'Performance Reviewer', systemPrompt: 'Review for performance.', model: 'gpt-5.4' },
    },
    {
      id: 'style',
      type: 'agent',
      position: { x: 650, y: 150 },
      config: { name: 'Style Reviewer', systemPrompt: 'Review code style.', model: 'gpt-5.4' },
    },
    { id: 'merge', type: 'merge', position: { x: 400, y: 300 }, config: { name: 'Merge Reviews' } },
    {
      id: 'summarizer',
      type: 'agent',
      position: { x: 400, y: 450 },
      config: { name: 'Summarizer', systemPrompt: 'Summarize all reviews.', model: 'gpt-5.4' },
    },
    { id: 'output', type: 'output', position: { x: 400, y: 600 }, config: { name: 'Review Report' } },
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'security' },
    { id: 'e2', source: 'input', target: 'perf' },
    { id: 'e3', source: 'input', target: 'style' },
    { id: 'e4', source: 'security', target: 'merge' },
    { id: 'e5', source: 'perf', target: 'merge' },
    { id: 'e6', source: 'style', target: 'merge' },
    { id: 'e7', source: 'merge', target: 'summarizer' },
    { id: 'e8', source: 'summarizer', target: 'output' },
  ],
});

// ---------- Tests ----------

describe('planWorkflow', () => {
  it('should generate a valid workflow from a well-formed LLM response', async () => {
    const provider = mockProvider(VALID_WORKFLOW_JSON);
    const result = await planWorkflow('Research AI trends and write an article', { provider });

    expect(result.workflow.name).toBe('Research & Write');
    expect(result.workflow.nodes).toHaveLength(4);
    expect(result.workflow.edges).toHaveLength(3);
    expect(result.validationErrors.filter((e) => e.includes('Validation:'))).toHaveLength(0);
  });

  it('should handle parallel workflows correctly', async () => {
    const provider = mockProvider(PARALLEL_WORKFLOW_JSON);
    const result = await planWorkflow('Review this code from 3 perspectives', { provider });

    expect(result.workflow.nodes).toHaveLength(7);
    expect(result.workflow.edges).toHaveLength(8);

    // Check parallel structure: input connects to 3 reviewers
    const inputEdges = result.workflow.edges.filter((e) => e.source === 'input');
    expect(inputEdges).toHaveLength(3);
  });

  it('should parse JSON from markdown code blocks', async () => {
    const wrappedResponse = '```json\n' + VALID_WORKFLOW_JSON + '\n```';
    const provider = mockProvider(wrappedResponse);
    const result = await planWorkflow('Test task', { provider });

    expect(result.workflow.name).toBe('Research & Write');
  });

  it('should parse JSON with surrounding text', async () => {
    const wrappedResponse = 'Here is the workflow:\n' + VALID_WORKFLOW_JSON + '\nHope this helps!';
    const provider = mockProvider(wrappedResponse);
    const result = await planWorkflow('Test task', { provider });

    expect(result.workflow.name).toBe('Research & Write');
  });

  it('should pass constraints to the LLM', async () => {
    const provider = mockProvider(VALID_WORKFLOW_JSON);
    await planWorkflow('Build a website', {
      provider,
      additionalContext: 'Use Claude for all agents. Max 5 nodes.',
    });

    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Use Claude for all agents'),
          }),
        ]),
      })
    );
  });

  it('should throw on completely unparseable response', async () => {
    const provider = mockProvider('This is not JSON at all, just plain text without any braces.');
    await expect(planWorkflow('Test', { provider })).rejects.toThrow('Failed to parse');
  });

  it('should use custom model and temperature', async () => {
    const provider = mockProvider(VALID_WORKFLOW_JSON);
    await planWorkflow('Test', { provider, model: 'gpt-5.4', temperature: 0.5 });

    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        temperature: 0.5,
      })
    );
  });

  it('should generate a unique workflow ID', async () => {
    const provider = mockProvider(VALID_WORKFLOW_JSON);
    const r1 = await planWorkflow('Test', { provider });
    const r2 = await planWorkflow('Test', { provider });
    expect(r1.workflow.id).not.toBe(r2.workflow.id);
  });

  it('should return raw LLM response', async () => {
    const provider = mockProvider(VALID_WORKFLOW_JSON);
    const result = await planWorkflow('Test', { provider });
    expect(result.raw).toBe(VALID_WORKFLOW_JSON);
  });
});

describe('autoFixWorkflow', () => {
  it('should add missing input node', () => {
    const workflow: Workflow = {
      id: 'test',
      name: 'Test',
      nodes: [
        { id: 'agent1', type: 'agent', position: { x: 0, y: 0 }, config: { name: 'Agent', systemPrompt: 'hi', model: 'gpt-5.4' } },
        { id: 'output', type: 'output', position: { x: 0, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [{ id: 'e1', source: 'agent1', target: 'output' }],
      metadata: { created: '', updated: '', version: '1' },
    };

    const result = autoFixWorkflow(workflow);
    expect(result.wasFixed).toBe(true);
    expect(result.workflow.nodes.some((n) => n.type === 'input')).toBe(true);

    // Should add edge from input to agent1 (which had no incoming edges)
    const inputNode = result.workflow.nodes.find((n) => n.type === 'input')!;
    const inputEdges = result.workflow.edges.filter((e) => e.source === inputNode.id);
    expect(inputEdges.length).toBeGreaterThan(0);
  });

  it('should add missing output node', () => {
    const workflow: Workflow = {
      id: 'test',
      name: 'Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'agent1', type: 'agent', position: { x: 0, y: 0 }, config: { name: 'Agent', systemPrompt: 'hi', model: 'gpt-5.4' } },
      ],
      edges: [{ id: 'e1', source: 'input', target: 'agent1' }],
      metadata: { created: '', updated: '', version: '1' },
    };

    const result = autoFixWorkflow(workflow);
    expect(result.wasFixed).toBe(true);
    expect(result.workflow.nodes.some((n) => n.type === 'output')).toBe(true);
  });

  it('should remove invalid edges', () => {
    const workflow: Workflow = {
      id: 'test',
      name: 'Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'output', type: 'output', position: { x: 0, y: 0 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'output' },
        { id: 'e2', source: 'ghost', target: 'output' }, // invalid source
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const result = autoFixWorkflow(workflow);
    expect(result.wasFixed).toBe(true);
    // Should have removed the ghost edge, leaving only e1
    const validEdges = result.workflow.edges.filter(
      (e) => e.source === 'input' && e.target === 'output'
    );
    expect(validEdges.length).toBe(1);
  });

  it('should remove self-loops', () => {
    const workflow: Workflow = {
      id: 'test',
      name: 'Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'agent', type: 'agent', position: { x: 0, y: 100 }, config: { name: 'Agent', systemPrompt: 'x', model: 'gpt-5.4' } },
        { id: 'output', type: 'output', position: { x: 0, y: 200 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'agent' },
        { id: 'e2', source: 'agent', target: 'agent' }, // self-loop!
        { id: 'e3', source: 'agent', target: 'output' },
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const result = autoFixWorkflow(workflow);
    expect(result.wasFixed).toBe(true);
    expect(result.errors).toContain('Removed self-loop on node agent');
    expect(result.workflow.edges.every((e) => e.source !== e.target)).toBe(true);
  });

  it('should break cycles', () => {
    const workflow: Workflow = {
      id: 'test',
      name: 'Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'a', type: 'agent', position: { x: 0, y: 100 }, config: { name: 'A', systemPrompt: 'x', model: 'gpt-5.4' } },
        { id: 'b', type: 'agent', position: { x: 0, y: 200 }, config: { name: 'B', systemPrompt: 'x', model: 'gpt-5.4' } },
        { id: 'output', type: 'output', position: { x: 0, y: 300 }, config: { name: 'Output' } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' }, // cycle!
        { id: 'e4', source: 'b', target: 'output' },
      ],
      metadata: { created: '', updated: '', version: '1' },
    };

    const result = autoFixWorkflow(workflow);
    expect(result.wasFixed).toBe(true);
    expect(result.errors.some((e) => e.includes('back-edge'))).toBe(true);
    // Cycle should be broken
    expect(result.workflow.edges.length).toBeLessThan(4);
  });

  it('should return wasFixed=false for a valid workflow', () => {
    const workflow: Workflow = {
      id: 'test',
      name: 'Test',
      nodes: [
        { id: 'input', type: 'input', position: { x: 0, y: 0 }, config: { name: 'Input' } },
        { id: 'output', type: 'output', position: { x: 0, y: 100 }, config: { name: 'Output' } },
      ],
      edges: [{ id: 'e1', source: 'input', target: 'output' }],
      metadata: { created: '', updated: '', version: '1' },
    };

    const result = autoFixWorkflow(workflow);
    expect(result.wasFixed).toBe(false);
  });
});

describe('PLANNER_SYSTEM_PROMPT', () => {
  it('should mention all node types', () => {
    const nodeTypes = ['input', 'output', 'agent', 'tool', 'condition', 'merge', 'loop', 'human'];
    for (const type of nodeTypes) {
      expect(PLANNER_SYSTEM_PROMPT).toContain(`**${type}**`);
    }
  });

  it('should mention inputTemplate syntax', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('{{nodeId.output}}');
  });
});

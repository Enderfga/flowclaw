import { describe, it, expect } from 'vitest';
import { resolveTemplate, assembleNodeInput } from '../src/template.js';

describe('resolveTemplate', () => {
  it('replaces simple references', () => {
    const result = resolveTemplate('Hello {{name.output}}', {
      name: { output: 'World' },
    });
    expect(result).toBe('Hello World');
  });

  it('replaces nested path references', () => {
    const result = resolveTemplate('{{a.output.title}} by {{a.output.author}}', {
      a: { output: { title: 'Test', author: 'Me' } },
    });
    expect(result).toBe('Test by Me');
  });

  it('preserves unresolved references', () => {
    const result = resolveTemplate('{{missing.output}}', {});
    expect(result).toBe('{{missing.output}}');
  });

  it('stringifies non-string values', () => {
    const result = resolveTemplate('{{n.output}}', {
      n: { output: { foo: 42 } },
    });
    expect(result).toBe('{"foo":42}');
  });
});

describe('resolveTemplate with variables', () => {
  it('resolves $var.name syntax', () => {
    const result = resolveTemplate('Hello {{$var.username}}', {}, { username: 'Alice' });
    expect(result).toBe('Hello Alice');
  });

  it('resolves $shorthand syntax (without var prefix)', () => {
    const result = resolveTemplate('Model: {{$model}}', {}, { model: 'gpt-5.4' });
    expect(result).toBe('Model: gpt-5.4');
  });

  it('resolves nested variable paths', () => {
    const result = resolveTemplate('Config: {{$var.config.maxTokens}}', {}, { config: { maxTokens: 4096 } });
    expect(result).toBe('Config: 4096');
  });

  it('preserves unresolved variable references', () => {
    const result = resolveTemplate('{{$var.missing}}', {}, {});
    expect(result).toBe('{{$var.missing}}');
  });

  it('mixes node outputs and variables', () => {
    const result = resolveTemplate(
      'User {{$var.user}} says: {{nodeA.output}}',
      { nodeA: { output: 'Hello' } },
      { user: 'Bob' }
    );
    expect(result).toBe('User Bob says: Hello');
  });
});

describe('assembleNodeInput', () => {
  it('uses template when provided', () => {
    const result = assembleNodeInput(
      'Based on {{nodeA.output}}, do something',
      { nodeA: 'analysis result' }
    );
    expect(result).toBe('Based on analysis result, do something');
  });

  it('passes single upstream output directly without template', () => {
    const result = assembleNodeInput(undefined, { nodeA: 'hello' });
    expect(result).toBe('hello');
  });

  it('returns map for multiple upstreams without template', () => {
    const result = assembleNodeInput(undefined, {
      nodeA: 'hello',
      nodeB: 'world',
    });
    expect(result).toEqual({ nodeA: 'hello', nodeB: 'world' });
  });
});

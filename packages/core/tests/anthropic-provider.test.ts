// ============================================================
// AnthropicProvider — Unit Tests
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { ProviderRequest } from '../src/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeRequest(systemPrompt = 'You are helpful', userMessage = 'Hello'): ProviderRequest {
  return {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.7,
    maxTokens: 1024,
  };
}

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider('test-api-key');
    mockFetch.mockReset();
  });

  describe('chat()', () => {
    it('sends correct request format to Anthropic Messages API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'msg_123',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello back!' }],
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          usage: { input_tokens: 15, output_tokens: 5 },
        }),
      });

      const result = await provider.chat(makeRequest());

      // Verify fetch was called with correct Anthropic format
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(opts.headers['x-api-key']).toBe('test-api-key');
      expect(opts.headers['anthropic-version']).toBe('2023-06-01');

      // Verify system is extracted to top-level (not in messages array)
      const body = JSON.parse(opts.body);
      expect(body.system).toBe('You are helpful');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(body.model).toBe('claude-sonnet-4-6');
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1024);

      // Verify response parsing
      expect(result.content).toBe('Hello back!');
      expect(result.tokenUsage.prompt).toBe(15);
      expect(result.tokenUsage.completion).toBe(5);
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.finishReason).toBe('stop');
    });

    it('handles multi-block content responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'msg_456',
          type: 'message',
          content: [
            { type: 'text', text: 'Part 1. ' },
            { type: 'text', text: 'Part 2.' },
          ],
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
      });

      const result = await provider.chat(makeRequest());
      expect(result.content).toBe('Part 1. Part 2.');
    });

    it('handles request without system message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      });

      const request: ProviderRequest = {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await provider.chat(request);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.system).toBeUndefined();
      expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => '{"error":{"message":"Rate limited"}}',
      });

      await expect(provider.chat(makeRequest())).rejects.toThrow('Anthropic API error 429');
    });

    it('defaults max_tokens to 4096 when not specified', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      });

      const request: ProviderRequest = {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      };
      await provider.chat(request);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(4096);
    });
  });

  describe('chatStream()', () => {
    it('handles SSE streaming events', async () => {
      const sseData = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":20}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world!"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"output_tokens":10}}',
        '',
      ].join('\n');

      const encoder = new TextEncoder();
      let consumed = false;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (!consumed) {
                consumed = true;
                return { done: false, value: encoder.encode(sseData) };
              }
              return { done: true, value: undefined };
            },
            releaseLock: () => {},
          }),
        },
      });

      const chunks: Array<{ content: string; done: boolean }> = [];
      for await (const chunk of provider.chatStream(makeRequest())) {
        chunks.push({ content: chunk.content, done: chunk.done });
        if (chunk.done) {
          expect(chunk.tokenUsage).toEqual({ prompt: 20, completion: 10 });
        }
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0].content).toBe('Hello ');
      expect(chunks[1].content).toBe('world!');
      expect(chunks[2].done).toBe(true);
    });
  });

  describe('splitSystemMessage()', () => {
    it('concatenates multiple system messages', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      });

      const request: ProviderRequest = {
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      await provider.chat(request);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.system).toBe('You are helpful.\nBe concise.');
      expect(body.messages).toHaveLength(1);
    });
  });
});

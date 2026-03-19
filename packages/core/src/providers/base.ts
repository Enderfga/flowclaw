// === Base Provider + Mock Provider ===

import type { AgentProvider, ProviderRequest, ProviderResponse, TokenUsage, StreamChunk } from '../types.js';

/**
 * Mock provider for testing. Returns a configurable response.
 */
export class MockProvider implements AgentProvider {
  name = 'mock';
  private handler: (req: ProviderRequest) => string;

  constructor(handler?: (req: ProviderRequest) => string) {
    this.handler = handler ?? ((req) => `Mock response for: ${req.messages.at(-1)?.content ?? '(empty)'}`);
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const content = this.handler(request);
    return {
      content,
      tokenUsage: {
        prompt: JSON.stringify(request.messages).length,
        completion: content.length,
      },
      model: request.model,
      finishReason: 'stop',
    };
  }

  async *chatStream(request: ProviderRequest): AsyncIterable<StreamChunk> {
    const content = this.handler(request);
    // Simulate streaming by yielding word-by-word
    const words = content.split(' ');
    for (let i = 0; i < words.length; i++) {
      const chunk = (i > 0 ? ' ' : '') + words[i];
      const done = i === words.length - 1;
      yield {
        content: chunk,
        done,
        ...(done ? {
          tokenUsage: {
            prompt: JSON.stringify(request.messages).length,
            completion: content.length,
          },
        } : {}),
      };
    }
  }
}

/**
 * HTTP-based provider that calls any OpenAI-compatible API.
 */
export class OpenAICompatibleProvider implements AgentProvider {
  name: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(name: string, baseUrl: string, apiKey: string) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Provider ${this.name} error ${resp.status}: ${body}`);
    }

    const data = await resp.json() as any;
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content ?? '',
      tokenUsage: {
        prompt: data.usage?.prompt_tokens ?? 0,
        completion: data.usage?.completion_tokens ?? 0,
      },
      model: data.model ?? request.model,
      finishReason: choice?.finish_reason === 'stop' ? 'stop' : 'length',
    };
  }

  async *chatStream(request: ProviderRequest): AsyncIterable<StreamChunk> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Provider ${this.name} stream error ${resp.status}: ${body}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data) as any;
            const delta = parsed.choices?.[0]?.delta?.content ?? '';
            const finishReason = parsed.choices?.[0]?.finish_reason;
            const usage = parsed.usage;

            if (delta || finishReason) {
              yield {
                content: delta,
                done: finishReason === 'stop',
                ...(usage ? {
                  tokenUsage: {
                    prompt: usage.prompt_tokens ?? 0,
                    completion: usage.completion_tokens ?? 0,
                  },
                } : {}),
              };
            }
          } catch {
            // skip unparseable SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

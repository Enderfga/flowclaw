// ============================================================
// Anthropic Native Provider — uses Messages API directly
// (/v1/messages, not OpenAI-compatible format)
// ============================================================

import type { AgentProvider, ProviderRequest, ProviderResponse, StreamChunk } from '../types.js';

export class AnthropicProvider implements AgentProvider {
  name = 'claude';
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.anthropic.com') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const { system, messages } = this.splitSystemMessage(request);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    const data = await resp.json() as AnthropicResponse;
    const content = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      content,
      tokenUsage: {
        prompt: data.usage?.input_tokens ?? 0,
        completion: data.usage?.output_tokens ?? 0,
      },
      model: data.model ?? request.model,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason ?? 'unknown',
    };
  }

  async *chatStream(request: ProviderRequest): AsyncIterable<StreamChunk> {
    const { system, messages } = this.splitSystemMessage(request);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic streaming error ${resp.status}: ${text}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

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

          try {
            const event = JSON.parse(data) as AnthropicStreamEvent;

            if (event.type === 'message_start' && event.message?.usage) {
              inputTokens = event.message.usage.input_tokens ?? 0;
            } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              yield { content: event.delta.text ?? '', done: false };
            } else if (event.type === 'message_delta') {
              outputTokens = event.usage?.output_tokens ?? 0;
              yield {
                content: '',
                done: true,
                tokenUsage: { prompt: inputTokens, completion: outputTokens },
              };
              return;
            }
          } catch {
            // Skip unparseable SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If stream ended without message_delta, emit final chunk
    yield {
      content: '',
      done: true,
      tokenUsage: { prompt: inputTokens, completion: outputTokens },
    };
  }

  /**
   * Anthropic Messages API requires system as a top-level param,
   * not in the messages array. Extract it from ProviderRequest messages.
   */
  private splitSystemMessage(request: ProviderRequest): {
    system: string | undefined;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    let system: string | undefined;
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        system = system ? `${system}\n${msg.content}` : msg.content;
      } else {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }

    return { system, messages };
  }
}

// ---------- Anthropic API Types ----------

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string } | { type: string; [key: string]: unknown }>;
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicStreamEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string };
  usage?: { output_tokens?: number };
}

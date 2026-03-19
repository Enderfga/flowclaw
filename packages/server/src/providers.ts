// ============================================================
// Provider Registry — configure AI providers from env vars
// ============================================================

import type { AgentProvider } from '@council/core';
import { MockProvider, OpenAICompatibleProvider, AnthropicProvider } from '@council/core';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

// Well-known provider defaults
const KNOWN_PROVIDERS: Record<string, { baseUrl: string; envKey: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY' },
  claude: { baseUrl: 'https://api.anthropic.com/v1', envKey: 'ANTHROPIC_API_KEY' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GOOGLE_API_KEY' },
};

/**
 * Build provider map from environment variables.
 * Only registers providers that have real API keys configured.
 * No mock providers — if no key, the provider simply doesn't exist.
 */
export function buildProviders(): Map<string, AgentProvider> {
  const providers = new Map<string, AgentProvider>();

  for (const [name, config] of Object.entries(KNOWN_PROVIDERS)) {
    const apiKey = process.env[config.envKey];
    if (apiKey) {
      if (name === 'claude') {
        providers.set(name, new AnthropicProvider(apiKey, config.baseUrl));
      } else {
        providers.set(name, new OpenAICompatibleProvider(name, config.baseUrl, apiKey));
      }
      console.log(`✅ Provider "${name}" configured (real API)`);
    } else {
      console.log(`⏭️  Provider "${name}" skipped (no ${config.envKey})`);
    }
  }

  if (providers.size === 0) {
    // In test/dev environment with no keys, provide mock providers
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      for (const name of Object.keys(KNOWN_PROVIDERS)) {
        providers.set(name, new MockProvider((req) =>
          `[Mock ${name}] Response for model=${req.model}: ${req.messages.at(-1)?.content?.slice(0, 100) ?? '(empty)'}`,
        ));
      }
      console.log('🧪 Test mode: using MockProviders');
    } else {
      console.error('❌ No providers configured! Set at least one API key.');
    }
  }

  return providers;
}

/**
 * List configured providers and their status
 */
export function listProviderStatus(): Array<{ name: string; type: 'real' | 'unavailable' }> {
  const result: Array<{ name: string; type: 'real' | 'unavailable' }> = [];
  for (const [name, config] of Object.entries(KNOWN_PROVIDERS)) {
    const apiKey = process.env[config.envKey];
    result.push({
      name,
      type: apiKey ? 'real' : 'unavailable',
    });
  }
  return result;
}

/**
 * Provider health check — sends minimal request to verify API key validity.
 */
export async function checkProviderHealth(
  providers: Map<string, AgentProvider>,
): Promise<Array<{ name: string; status: 'ok' | 'error' | 'unavailable'; latencyMs?: number; error?: string }>> {
  const results: Array<{ name: string; status: 'ok' | 'error' | 'unavailable'; latencyMs?: number; error?: string }> = [];

  for (const [name] of Object.entries(KNOWN_PROVIDERS)) {
    const provider = providers.get(name);
    if (!provider) {
      results.push({ name, status: 'unavailable' });
      continue;
    }

    const start = Date.now();
    try {
      await provider.chat({
        model: name === 'claude' ? 'claude-haiku-4-5-20251001' : name === 'openai' ? 'gpt-5.4-mini' : 'gemini-3.1-flash',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 5,
      });
      results.push({ name, status: 'ok', latencyMs: Date.now() - start });
    } catch (err) {
      results.push({
        name,
        status: 'error',
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

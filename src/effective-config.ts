// Effective config resolver.
//
// From 0.6 onwards, the server is the source of truth for the
// "what provider? what model? what cadence? dry-run?" fields. The local
// config.json still exists but only holds provider API keys (Anthropic /
// OpenAI / …) and the Krawler API key. When the install has a pair
// token on disk, we fetch the runtime config from the server on startup
// and at every cycle; the local file becomes a fallback for unpaired
// installs and for provider keys.
//
// This split keeps the privacy posture intact — provider API keys
// never leave the machine — while centralising the per-agent choices
// that a human managing multiple devices wants synced (you shouldn't
// have to change the model in three places when you flip providers).
//
// Resolution order (first non-null wins, for each field):
//   1. Server runtime config (if pair token present and fetch succeeded)
//   2. Local config.json
//   3. Schema defaults (anthropic / claude-opus-4-7 / 10min / dryRun=false)
//
// Call sites (loop.ts, repl.ts, status cmd, settings-tools) use this
// instead of the raw loadConfig() when they need runtime values. Raw
// loadConfig() stays the way to read provider API keys because those
// are never server-sourced.

import { appendActivityLog, getActiveCredentials, loadConfig, loadPairToken } from './config.js';
import type { Config, Provider } from './config.js';
import { KrawlerClient } from './krawler.js';

export interface EffectiveConfig {
  // Runtime fields that may come from the server:
  provider: Provider;
  model: string;
  cadenceMinutes: number;
  dryRun: boolean;
  behaviors: { post: boolean; endorse: boolean; follow: boolean };
  reflectionEnabled: boolean;
  // Connection fields, always local:
  krawlerApiKey: string;
  krawlerBaseUrl: string;
  // Provider credentials — always local, fetched per the chosen provider.
  activeCredentials: { apiKey: string; baseUrl?: string };
  // Bookkeeping:
  source: 'server' | 'local';
  sourceUpdatedAt: string | null;
  // Handle is needed for runtime-config endpoints; we cache it here so
  // the caller doesn't have to call client.me() before every cycle.
  // Null when unpaired or /me has never been called successfully.
  handle: string | null;
}

// Resolve effective config by combining server runtime (if paired) with
// local config.json for credentials. Throws only if the local config
// itself is broken; server-fetch failures fall back to local values.
export async function resolveEffectiveConfig(): Promise<EffectiveConfig> {
  const local = loadConfig();
  const pair = loadPairToken();

  // Default to local values. If we have a pair token and can reach the
  // server, we overwrite the subset of fields the server owns.
  let source: 'server' | 'local' = 'local';
  let sourceUpdatedAt: string | null = null;
  let handle: string | null = pair?.handle ?? null;
  let runtime: Partial<Config> = {};

  if (pair && handle) {
    try {
      const client = new KrawlerClient(local.krawlerBaseUrl, local.krawlerApiKey ?? '');
      const result = await client.getRuntimeConfig(pair.token, handle);
      runtime = {
        provider: result.runtime.provider as Provider,
        model: result.runtime.model,
        cadenceMinutes: result.runtime.cadenceMinutes,
        dryRun: result.runtime.dryRun,
        behaviors: result.runtime.behaviors,
        reflection: { enabled: result.runtime.reflectionEnabled },
      };
      source = 'server';
      sourceUpdatedAt = result.runtime.updatedAt;
    } catch (e) {
      // Server fetch failed. Log once per process boot; we don't want to
      // spam for every cycle when the server is just unreachable. Fall
      // back to the local values, which still work for the privacy-
      // preserving read-your-keys path.
      appendActivityLog({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: `effective-config: falling back to local; server fetch failed: ${(e as Error).message}`,
      });
    }
  }

  const provider = (runtime.provider ?? local.provider) as Provider;
  const model = runtime.model ?? local.model;
  const cadenceMinutes = runtime.cadenceMinutes ?? local.cadenceMinutes;
  const dryRun = runtime.dryRun ?? local.dryRun;
  const behaviors = runtime.behaviors ?? local.behaviors;
  const reflectionEnabled = runtime.reflection?.enabled ?? local.reflection.enabled;

  // Credential lookup has to happen AFTER we know the chosen provider,
  // because getActiveCredentials branches on provider.
  const provisional = { ...local, provider, model, cadenceMinutes, dryRun, behaviors, reflection: { enabled: reflectionEnabled } } as Config;
  const activeCredentials = getActiveCredentials(provisional);

  return {
    provider,
    model,
    cadenceMinutes,
    dryRun,
    behaviors,
    reflectionEnabled,
    krawlerApiKey: local.krawlerApiKey,
    krawlerBaseUrl: local.krawlerBaseUrl,
    activeCredentials,
    source,
    sourceUpdatedAt,
    handle,
  };
}

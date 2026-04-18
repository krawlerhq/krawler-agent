import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { z } from 'zod';

export const CONFIG_DIR = join(homedir(), '.config', 'krawler-agent');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const LOG_PATH = join(CONFIG_DIR, 'activity.log');

export const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'ollama'] as const;
export type Provider = (typeof PROVIDERS)[number];

const configSchema = z.object({
  // Active model
  provider: z.enum(PROVIDERS).default('anthropic'),
  model: z.string().default('claude-opus-4-7'),

  // Per-provider credentials (kept independently so switching providers doesn't
  // lose keys you already pasted in)
  anthropicApiKey: z.string().default(''),
  openaiApiKey: z.string().default(''),
  googleApiKey: z.string().default(''),
  openrouterApiKey: z.string().default(''),
  ollamaBaseUrl: z.string().url().default('http://localhost:11434'),

  // Krawler
  krawlerApiKey: z.string().default(''),
  krawlerBaseUrl: z.string().url().default('https://krawler.com/api'),

  // Scheduler
  // Bootstrap default: 10 min so a young network has visible activity.
  // Once Krawler is populated the spec's recommended 4-6h cadence is the norm —
  // users can dial this up from the dashboard.
  cadenceMinutes: z.number().int().min(5).max(24 * 60).default(10),
  behaviors: z
    .object({
      post: z.boolean().default(true),
      endorse: z.boolean().default(true),
      follow: z.boolean().default(true),
    })
    .default({ post: true, endorse: true, follow: true }),
  // Dry run on by default — watch what the agent WOULD do before letting it post.
  dryRun: z.boolean().default(true),

  // State
  lastHeartbeat: z.string().optional(),
  running: z.boolean().default(false),
});

export type Config = z.infer<typeof configSchema>;

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  ensureDir();
  if (!existsSync(CONFIG_PATH)) {
    const initial = configSchema.parse({});
    saveConfig(initial);
    return initial;
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const fallback = configSchema.parse({});
    return { ...fallback, ...(raw ?? {}) };
  }
  return parsed.data;
}

export function saveConfig(c: Partial<Config>): Config {
  ensureDir();
  const current = existsSync(CONFIG_PATH)
    ? (JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>)
    : {};
  const merged = configSchema.parse({ ...current, ...c });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* ignore */ }
  return merged;
}

// Browser-safe view: keys replaced with presence flags so the UI never needs
// the raw secret after it's been saved once.
export function redactConfig(c: Config) {
  return {
    provider: c.provider,
    model: c.model,
    hasAnthropicApiKey: Boolean(c.anthropicApiKey),
    hasOpenaiApiKey: Boolean(c.openaiApiKey),
    hasGoogleApiKey: Boolean(c.googleApiKey),
    hasOpenrouterApiKey: Boolean(c.openrouterApiKey),
    ollamaBaseUrl: c.ollamaBaseUrl,
    hasKrawlerApiKey: Boolean(c.krawlerApiKey),
    krawlerBaseUrl: c.krawlerBaseUrl,
    cadenceMinutes: c.cadenceMinutes,
    behaviors: c.behaviors,
    dryRun: c.dryRun,
    lastHeartbeat: c.lastHeartbeat ?? null,
    running: c.running,
  };
}

// Return { apiKey } (or { baseUrl } for Ollama) for the currently active provider.
export function getActiveCredentials(c: Config): { apiKey: string; baseUrl?: string } {
  switch (c.provider) {
    case 'anthropic':  return { apiKey: c.anthropicApiKey };
    case 'openai':     return { apiKey: c.openaiApiKey };
    case 'google':     return { apiKey: c.googleApiKey };
    case 'openrouter': return { apiKey: c.openrouterApiKey };
    case 'ollama':     return { apiKey: '', baseUrl: c.ollamaBaseUrl };
  }
}

export function appendActivityLog(entry: { ts: string; level: string; msg: string; data?: unknown }): void {
  ensureDir();
  const line = JSON.stringify(entry) + '\n';
  try {
    writeFileSync(LOG_PATH, line, { flag: 'a', mode: 0o600 });
  } catch {
    /* ignore logging failures */
  }
}

export function readActivityLog(limit = 200): Array<{ ts: string; level: string; msg: string; data?: unknown }> {
  ensureDir();
  if (!existsSync(LOG_PATH)) return [];
  const text = readFileSync(LOG_PATH, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const last = lines.slice(-limit);
  const out: Array<{ ts: string; level: string; msg: string; data?: unknown }> = [];
  for (const l of last) {
    try { out.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
  }
  return out;
}

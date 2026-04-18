import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { z } from 'zod';

export const CONFIG_DIR = join(homedir(), '.config', 'krawler-agent');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const LOG_PATH = join(CONFIG_DIR, 'activity.log');
export const TOKENS_PATH = join(CONFIG_DIR, 'tokens.json');
export const SKILLS_DIR = join(CONFIG_DIR, 'skills');
export const BLOBS_DIR = join(CONFIG_DIR, 'blobs');

export const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'ollama'] as const;
export type Provider = (typeof PROVIDERS)[number];

const discordConfigSchema = z.object({
  botToken: z.string().default(''),
  applicationId: z.string().default(''),
  // Optional: restrict bot to specific guilds. Empty = all guilds the bot is in.
  guildIds: z.array(z.string()).default([]),
});

const factExtractorSchema = z.object({
  // Empty string = auto-select "one tier down" from the main model (see
  // design.md §10 #3). Anything else overrides.
  provider: z.enum(PROVIDERS).optional(),
  model: z.string().default(''),
});

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

  // Scheduler (legacy heartbeat loop — see legacyHeartbeat flag below)
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

  // v1.0: keep the legacy cadenced heartbeat loop running (post/endorse/follow
  // on a timer, no channels, no tools). When false, the gateway takes over and
  // the loop is channel-driven. Stays true by default until v1.1 flips it.
  legacyHeartbeat: z.boolean().default(true),

  // v1.0: channel adapters. Credentials kept per-channel so pairing one
  // doesn't disturb another.
  channels: z
    .object({
      discord: discordConfigSchema.default({ botToken: '', applicationId: '', guildIds: [] }),
    })
    .default({ discord: { botToken: '', applicationId: '', guildIds: [] } }),

  // v1.0: override for the fact extractor model. Default = "one tier down"
  // from the main provider.
  factExtractor: factExtractorSchema.default({ model: '' }),

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

// Browser-safe view: keys replaced with presence flags plus last 4 chars so
// the UI can render "sk-ant-…abcd" style previews without holding the raw
// secret after first save.
function last4(s: string): string {
  return s.length >= 4 ? s.slice(-4) : '';
}
export function redactConfig(c: Config) {
  return {
    provider: c.provider,
    model: c.model,
    hasAnthropicApiKey: Boolean(c.anthropicApiKey),
    anthropicApiKeyLast4: last4(c.anthropicApiKey),
    hasOpenaiApiKey: Boolean(c.openaiApiKey),
    openaiApiKeyLast4: last4(c.openaiApiKey),
    hasGoogleApiKey: Boolean(c.googleApiKey),
    googleApiKeyLast4: last4(c.googleApiKey),
    hasOpenrouterApiKey: Boolean(c.openrouterApiKey),
    openrouterApiKeyLast4: last4(c.openrouterApiKey),
    ollamaBaseUrl: c.ollamaBaseUrl,
    hasKrawlerApiKey: Boolean(c.krawlerApiKey),
    krawlerApiKeyLast4: last4(c.krawlerApiKey),
    krawlerBaseUrl: c.krawlerBaseUrl,
    cadenceMinutes: c.cadenceMinutes,
    behaviors: c.behaviors,
    dryRun: c.dryRun,
    legacyHeartbeat: c.legacyHeartbeat,
    channels: {
      discord: {
        hasBotToken: Boolean(c.channels.discord.botToken),
        applicationId: c.channels.discord.applicationId,
        guildIds: c.channels.discord.guildIds,
      },
    },
    factExtractor: {
      provider: c.factExtractor.provider ?? null,
      model: c.factExtractor.model,
    },
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

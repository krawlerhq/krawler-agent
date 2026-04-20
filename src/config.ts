import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { currentProfileName, DEFAULT_PROFILE, profileDir } from './profile-context.js';

// Multi-agent support. Every filesystem path is a runtime getter that
// resolves to the current profile's directory:
//
//   default profile  -> ~/.config/krawler-agent/
//   named profile X  -> ~/.config/krawler-agent/profiles/X/
//
// The active profile comes from withProfile() (AsyncLocalStorage) or
// the KRAWLER_PROFILE env var. Functions instead of consts so a single
// process can drive multiple profiles concurrently: each scheduled
// cycle runs inside withProfile(name, ...), and loadConfig() et al
// transparently route to the right files without being parameterised.
export function getConfigDir(): string { return profileDir(currentProfileName()); }
export function getConfigPath(): string { return join(getConfigDir(), 'config.json'); }
export function getLogPath(): string { return join(getConfigDir(), 'activity.log'); }
export function getTokensPath(): string { return join(getConfigDir(), 'tokens.json'); }
// Local installable playbooks (v1.0-era skill registry). Renamed from
// `skills/` in 0.5.4 because the word "skill" now means the per-agent
// skill.md on krawler.com.
export function getSkillsDir(): string { return join(getConfigDir(), 'playbooks'); }
export function getBlobsDir(): string { return join(getConfigDir(), 'blobs'); }
// Cache dir for external skill documents the agent has installed via
// skillRefs on krawler.com. Each skill is a subdirectory keyed by a
// slug derived from the source URL, containing SKILL.md plus a
// meta.json with origin metadata. The agent fetches on first use,
// then reads from this cache every cycle, and (future) can push local
// edits back as a PR to the source repo. See design note in
// src/skill-refs.ts.
export function getInstalledSkillsDir(): string { return join(getConfigDir(), 'installed-skills'); }

// Provider credentials live at the machine root, shared across all
// profiles on the install. The mental model: a Krawler agent key is
// PER-AGENT (so it's in per-profile config.json), but your Anthropic
// / OpenAI / Google / OpenRouter / Ollama credentials are YOUR
// accounts — every agent you spawn on this machine uses the same
// ones. Storing them per-profile made users paste the same key over
// and over every time they added a profile. Path sits alongside the
// default profile's config.json in `~/.config/krawler-agent/`.
export function getSharedKeysPath(): string {
  return join(profileDir(DEFAULT_PROFILE), 'shared-keys.json');
}

// One-time migration: if the old skills/ dir exists and the new
// playbooks/ dir doesn't, rename. Idempotent on repeat boots. Safe to
// call multiple times. Logs nothing when there's nothing to do.
export function migratePlaybooksDir(): 'migrated' | 'already' | 'noop' {
  const dir = getConfigDir();
  const oldPath = join(dir, 'skills');
  const newPath = getSkillsDir();
  if (!existsSync(oldPath)) return 'noop';
  if (existsSync(newPath)) return 'already';
  try {
    renameSync(oldPath, newPath);
    return 'migrated';
  } catch {
    return 'noop';
  }
}

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
  // Dry run defaults OFF as of v0.2: if you have a Krawler key + a provider
  // key, starting the agent should produce real posts. Flip this on from the
  // dashboard only if you want to preview decisions before they go live.
  dryRun: z.boolean().default(false),

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

  // v0.4: reflection loop. When enabled, at the end of each heartbeat the
  // agent asks the model to reflect on recent outcomes and optionally
  // propose an edit to agent.md on krawler.com. Proposals are never applied
  // automatically — the human reviews them on the dashboard.
  reflection: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),

  // State
  lastHeartbeat: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

function ensureDir() {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
}

// Shared provider-credentials store. Lives at
// ~/.config/krawler-agent/shared-keys.json. All profiles overlay
// these values on top of whatever their own config.json has, so
// pasting an Anthropic key once covers every agent you spawn.
const sharedKeysSchema = z.object({
  anthropicApiKey: z.string().default(''),
  openaiApiKey: z.string().default(''),
  googleApiKey: z.string().default(''),
  openrouterApiKey: z.string().default(''),
  ollamaBaseUrl: z.string().url().default('http://localhost:11434'),
});

type SharedKeys = z.infer<typeof sharedKeysSchema>;

const SHARED_KEY_FIELDS = [
  'anthropicApiKey',
  'openaiApiKey',
  'googleApiKey',
  'openrouterApiKey',
  'ollamaBaseUrl',
] as const satisfies ReadonlyArray<keyof SharedKeys>;

function ensureDefaultProfileDir(): void {
  const dir = profileDir(DEFAULT_PROFILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadSharedKeys(): SharedKeys {
  ensureDefaultProfileDir();
  const path = getSharedKeysPath();
  if (!existsSync(path)) {
    return sharedKeysSchema.parse({});
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = sharedKeysSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return { ...sharedKeysSchema.parse({}), ...(raw ?? {}) };
  } catch {
    return sharedKeysSchema.parse({});
  }
}

export function saveSharedKeys(partial: Partial<SharedKeys>): SharedKeys {
  ensureDefaultProfileDir();
  const current = loadSharedKeys();
  const merged = sharedKeysSchema.parse({ ...current, ...partial });
  const path = getSharedKeysPath();
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
  return merged;
}

// First-run migration. If shared-keys.json doesn't exist yet but the
// default profile's config.json was populated under the old model,
// hoist those keys into the shared store so the human doesn't need
// to re-paste. Idempotent — a no-op once the shared file exists.
function migrateProviderKeysToShared(): void {
  if (existsSync(getSharedKeysPath())) return;
  const defaultConfigPath = join(profileDir(DEFAULT_PROFILE), 'config.json');
  if (!existsSync(defaultConfigPath)) return;
  try {
    const raw = JSON.parse(readFileSync(defaultConfigPath, 'utf8')) as Partial<Record<typeof SHARED_KEY_FIELDS[number], string>>;
    const pick: Partial<SharedKeys> = {};
    let hasAny = false;
    for (const f of SHARED_KEY_FIELDS) {
      const v = raw[f];
      if (typeof v === 'string' && v.length > 0) {
        (pick as Record<string, string>)[f] = v;
        hasAny = true;
      }
    }
    if (hasAny) saveSharedKeys(pick);
  } catch { /* non-fatal */ }
}

export function loadConfig(): Config {
  ensureDir();
  migrateProviderKeysToShared();
  const shared = loadSharedKeys();
  if (!existsSync(getConfigPath())) {
    const initial = configSchema.parse({});
    saveConfig(initial);
    return { ...initial, ...shared };
  }
  const raw = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
  const parsed = configSchema.safeParse(raw);
  const base = parsed.success
    ? parsed.data
    : { ...configSchema.parse({}), ...(raw ?? {}) };
  // Shared keys overlay the per-profile config. The per-profile file
  // may still have stale copies from pre-0.5.36 installs; those get
  // ignored here so the shared store is always the source of truth.
  return { ...base, ...shared };
}

export function saveConfig(c: Partial<Config>): Config {
  ensureDir();
  // Split the partial: provider-credential fields route to the shared
  // store, everything else stays in the per-profile config.json. This
  // way setting your Anthropic key from any profile updates the one
  // copy every other profile also reads.
  const sharedPartial: Partial<SharedKeys> = {};
  const profilePartial: Partial<Config> = {};
  for (const [k, v] of Object.entries(c)) {
    if ((SHARED_KEY_FIELDS as readonly string[]).includes(k)) {
      (sharedPartial as Record<string, unknown>)[k] = v;
    } else {
      (profilePartial as Record<string, unknown>)[k] = v;
    }
  }
  let shared: SharedKeys;
  if (Object.keys(sharedPartial).length > 0) {
    shared = saveSharedKeys(sharedPartial);
  } else {
    shared = loadSharedKeys();
  }
  const current = existsSync(getConfigPath())
    ? (JSON.parse(readFileSync(getConfigPath(), 'utf8')) as Partial<Config>)
    : {};
  // Strip any stale provider-key copies off the per-profile config so
  // the on-disk file mirrors the new "profiles never store provider
  // keys" rule. The shared file is now the only authoritative source.
  for (const f of SHARED_KEY_FIELDS) {
    delete (current as Record<string, unknown>)[f];
  }
  const mergedProfile = configSchema.parse({ ...current, ...profilePartial, ...shared });
  // Write out the per-profile slice (without the shared keys) so the
  // on-disk file stays minimal. We still return the fully-merged view
  // for the caller.
  const onDisk: Partial<Config> = { ...mergedProfile };
  for (const f of SHARED_KEY_FIELDS) {
    delete (onDisk as Record<string, unknown>)[f];
  }
  writeFileSync(getConfigPath(), JSON.stringify(onDisk, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(getConfigPath(), 0o600); } catch { /* ignore */ }
  return mergedProfile;
}

// Masked preview of a secret, e.g. "sk-ant-ap••••••z9" or "kra_live_ab••••xy9".
// Returns empty string for empty input. Keeps a recognizable prefix so the
// provider/key class is still obvious, plus the final 2 chars to confirm which
// key was saved. Never returns the middle.
export function maskedKey(s: string): string {
  if (!s) return '';
  if (s.length <= 6) return '•'.repeat(s.length);
  const prefix = s.length >= 10 ? s.slice(0, 8) : s.slice(0, 4);
  const tail = s.slice(-2);
  return `${prefix}••••${tail}`;
}

// Browser-safe view: secrets replaced with presence flags + masked previews.
// The UI shows the mask so a user can confirm which key is saved without the
// agent ever sending the raw value back over the wire.
export function redactConfig(c: Config) {
  return {
    provider: c.provider,
    model: c.model,
    hasAnthropicApiKey: Boolean(c.anthropicApiKey),
    hasOpenaiApiKey: Boolean(c.openaiApiKey),
    hasGoogleApiKey: Boolean(c.googleApiKey),
    hasOpenrouterApiKey: Boolean(c.openrouterApiKey),
    anthropicApiKeyMasked: maskedKey(c.anthropicApiKey),
    openaiApiKeyMasked: maskedKey(c.openaiApiKey),
    googleApiKeyMasked: maskedKey(c.googleApiKey),
    openrouterApiKeyMasked: maskedKey(c.openrouterApiKey),
    ollamaBaseUrl: c.ollamaBaseUrl,
    hasKrawlerApiKey: Boolean(c.krawlerApiKey),
    krawlerApiKeyMasked: maskedKey(c.krawlerApiKey),
    krawlerBaseUrl: c.krawlerBaseUrl,
    cadenceMinutes: c.cadenceMinutes,
    behaviors: c.behaviors,
    dryRun: c.dryRun,
    legacyHeartbeat: c.legacyHeartbeat,
    channels: {
      discord: {
        hasBotToken: Boolean(c.channels.discord.botToken),
        botTokenMasked: maskedKey(c.channels.discord.botToken),
        applicationId: c.channels.discord.applicationId,
        guildIds: c.channels.discord.guildIds,
      },
    },
    factExtractor: {
      provider: c.factExtractor.provider ?? null,
      model: c.factExtractor.model,
    },
    reflection: c.reflection,
    lastHeartbeat: c.lastHeartbeat ?? null,
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
    writeFileSync(getLogPath(), line, { flag: 'a', mode: 0o600 });
  } catch {
    /* ignore logging failures */
  }
}

export function readActivityLog(limit = 200): Array<{ ts: string; level: string; msg: string; data?: unknown }> {
  ensureDir();
  if (!existsSync(getLogPath())) return [];
  const text = readFileSync(getLogPath(), 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const last = lines.slice(-limit);
  const out: Array<{ ts: string; level: string; msg: string; data?: unknown }> = [];
  for (const l of last) {
    try { out.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
  }
  return out;
}

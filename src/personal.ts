// Personal agent config. Separate from the per-profile configs that
// hold Krawler network identities (@trace-warden, etc). The personal
// agent is what the human talks to when they run `krawler` — a local
// general-purpose assistant with no Krawler network handle, no
// scheduled heartbeat, and no post/follow/endorse tools. Network
// identities are @-addressable from the personal agent's REPL.
//
// Why separate files instead of another profile: network profiles are
// yoked to a Krawler API key (and the waiting-for-creds loop in the
// REPL insists on it). The personal agent should run with JUST a
// provider key — no Krawler account required — so it needed to escape
// that schema.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { PROVIDERS } from './config.js';

const PERSONAL_PATH = join(homedir(), '.config', 'krawler-agent', 'personal.json');
const PERSONAL_DIR = join(homedir(), '.config', 'krawler-agent', 'personal');

export function getPersonalChatHistoryPath(): string {
  return join(PERSONAL_DIR, 'chat.jsonl');
}

export function getPersonalDir(): string {
  return PERSONAL_DIR;
}

const personalSchema = z.object({
  // Display name for the personal agent. Defaults to "krawler" so the
  // REPL welcome card reads "agent: krawler" without any user setup.
  name: z.string().min(1).max(40).default('krawler'),
  // Model provider + slug. Reuses the same enum as network profiles
  // and reads the same shared-keys.json for credentials — no duplicate
  // key pasting.
  provider: z.enum(PROVIDERS).default('anthropic'),
  model: z.string().default('claude-opus-4-7'),
});

export type PersonalConfig = z.infer<typeof personalSchema>;

export function getPersonalConfigPath(): string {
  return PERSONAL_PATH;
}

// Ensure the base config dir exists. Mirrors the profile-context helper
// but without reaching into that module (personal.json lives at the
// install root, outside any profile subdir).
function ensureBaseDir(): void {
  const dir = join(homedir(), '.config', 'krawler-agent');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadPersonalConfig(): PersonalConfig {
  ensureBaseDir();
  if (!existsSync(PERSONAL_PATH)) {
    // First-run inheritance. If the user already had a default-profile
    // config.json (pre-0.8.0 layout), carry its provider + model into
    // personal.json so the personal agent wakes up ready to talk using
    // whichever provider key the human has already pasted, rather than
    // defaulting to anthropic and stalling on a missing key.
    const defaultConfigPath = join(homedir(), '.config', 'krawler-agent', 'config.json');
    let seed: Partial<PersonalConfig> = {};
    if (existsSync(defaultConfigPath)) {
      try {
        const raw = JSON.parse(readFileSync(defaultConfigPath, 'utf8')) as { provider?: string; model?: string };
        if (raw.provider) seed.provider = raw.provider as PersonalConfig['provider'];
        if (raw.model) seed.model = raw.model;
      } catch { /* ignore, use schema defaults */ }
    }
    const defaults = personalSchema.parse(seed);
    savePersonalConfig(defaults);
    return defaults;
  }
  try {
    const raw = JSON.parse(readFileSync(PERSONAL_PATH, 'utf8'));
    const parsed = personalSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // Permissive fallback: merge unknown extras with defaults so old
    // fields survive a schema rename. The user hand-editing the file
    // shouldn't lose their custom name because we renamed "model" to
    // "modelName" at some point.
    return personalSchema.parse({ ...(raw ?? {}) });
  } catch {
    return personalSchema.parse({});
  }
}

export function savePersonalConfig(c: Partial<PersonalConfig>): PersonalConfig {
  ensureBaseDir();
  const current = existsSync(PERSONAL_PATH)
    ? (JSON.parse(readFileSync(PERSONAL_PATH, 'utf8')) as Partial<PersonalConfig>)
    : {};
  const merged = personalSchema.parse({ ...current, ...c });
  writeFileSync(PERSONAL_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(PERSONAL_PATH, 0o600); } catch { /* ignore */ }
  return merged;
}

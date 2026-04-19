// Multi-profile support. A single `krawler start` process can drive N
// agents concurrently, one per profile. Each profile is a fully
// independent config/log/tokens/playbooks tree. The current profile
// name travels through async flow via AsyncLocalStorage, so config
// helpers (loadConfig, saveConfig, appendActivityLog, etc.) transparently
// route to the right paths without every callsite threading a profile
// argument.

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_PROFILE = 'default';
export const PROFILE_ROOT = join(homedir(), '.config', 'krawler-agent');

const profileStorage = new AsyncLocalStorage<string>();

// The active profile for whatever async scope is running. Reads from:
//   1. AsyncLocalStorage if inside a withProfile() block
//   2. KRAWLER_PROFILE env var (set by the cli.ts prelude)
//   3. DEFAULT_PROFILE
// In multi-profile mode, every scheduled heartbeat runs inside
// withProfile(name, ...), so loadConfig() et al see the right paths
// without being parameterised.
export function currentProfileName(): string {
  const store = profileStorage.getStore();
  if (store) return store;
  const env = (process.env.KRAWLER_PROFILE || '').trim();
  return env || DEFAULT_PROFILE;
}

export function withProfile<T>(name: string, fn: () => T | Promise<T>): T | Promise<T> {
  return profileStorage.run(name, fn);
}

export function profileDir(name: string): string {
  return name === DEFAULT_PROFILE
    ? PROFILE_ROOT
    : join(PROFILE_ROOT, 'profiles', name);
}

// Every profile that has a config.json on disk. The default profile
// counts if ~/.config/krawler-agent/config.json exists. Named profiles
// live under ~/.config/krawler-agent/profiles/<name>/config.json.
// Returns a sorted, unique list.
export function listProfiles(): string[] {
  const names = new Set<string>();
  if (existsSync(join(PROFILE_ROOT, 'config.json'))) names.add(DEFAULT_PROFILE);
  const sub = join(PROFILE_ROOT, 'profiles');
  if (existsSync(sub)) {
    for (const entry of readdirSync(sub)) {
      const cfg = join(sub, entry, 'config.json');
      if (existsSync(cfg) && statSync(cfg).isFile()) names.add(entry);
    }
  }
  return [...names].sort();
}

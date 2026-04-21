// User-level CLI auth. Stores the kcli_live_ bearer token issued by
// the device-auth handshake (/login slash command → browser confirm
// on krawler.com/cli-login → CLI polls and picks up the token).
//
// Path: ~/.config/krawler-agent/auth.json (0600). Shared across
// every profile on this install — scope of the token is "this
// human", not "this agent". Per-agent Krawler API keys still live
// per-profile in config.json.
//
// Missing / unreadable / invalid file is treated as "not signed in".
// The CLI degrades gracefully: personal chat still works with just
// a provider key, account ops (spawn, manage runtime) prompt the
// human to run /login.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const AUTH_PATH = join(homedir(), '.config', 'krawler-agent', 'auth.json');

export interface UserAuth {
  token: string;    // kcli_live_<secret>
  userId: string;   // Better Auth user id
  email: string;    // for display in the welcome card
  savedAt: string;  // ISO timestamp
}

export function getUserAuthPath(): string {
  return AUTH_PATH;
}

function ensureDir(): void {
  const dir = dirname(AUTH_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadUserAuth(): UserAuth | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8')) as Partial<UserAuth>;
    if (!raw.token || !raw.userId || !raw.email) return null;
    return {
      token: raw.token,
      userId: raw.userId,
      email: raw.email,
      savedAt: raw.savedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveUserAuth(auth: Omit<UserAuth, 'savedAt'>): UserAuth {
  ensureDir();
  const full: UserAuth = { ...auth, savedAt: new Date().toISOString() };
  writeFileSync(AUTH_PATH, JSON.stringify(full, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(AUTH_PATH, 0o600); } catch { /* ignore */ }
  return full;
}

export function clearUserAuth(): void {
  if (!existsSync(AUTH_PATH)) return;
  try { unlinkSync(AUTH_PATH); } catch { /* ignore */ }
}

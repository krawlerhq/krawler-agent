// Capability tokens: signed strings bound to the Krawler agent key that scope
// what the agent is allowed to do. See design.md §6 for the full grain list.
//
// v1.0 storage: a plaintext JSON file at ~/.config/krawler-agent/tokens.json
// holding one CapabilityToken per line. Scopes are matched prefix-or-glob
// style at check time.
//
// v1.0 does NOT yet issue JWTs or bind to the agent key cryptographically.
// Tokens are local-only permission records. The JWT signing flow lands when
// capability tokens need to travel off-box (e.g. subagents on a VPS).

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import { getTokensPath } from './config.js';
import { newApprovalId } from './id.js';

export const CAPABILITY_KINDS = [
  'krawler:read',
  'krawler:post',
  'krawler:endorse',
  'krawler:follow',
  'krawler:comment',
  'fs:read',              // with glob, e.g. fs:read:~/notes/**
  'fs:write',             // with glob
  'net:fetch',            // with host glob
  'exec',                 // with allowlist
  'spend',                // with $amount/period
  'channel:send',         // with channel id, e.g. channel:discord:send
  'channel:react',        // with channel id
] as const;

export const capabilityTokenSchema = z.object({
  // Opaque id. Tokens are addressable so we can revoke one without rewriting
  // the file.
  id: z.string(),
  capability: z.string(),   // e.g. 'krawler:post' or 'fs:write:~/notes/**'
  grantedAt: z.number(),
  // Optional upper bound. If set, the token stops being valid after this
  // timestamp. Useful for "approve once" (expires in 60s) or trial grants.
  expiresAt: z.number().optional(),
  // Provenance: where the grant came from. Helps the dashboard show who said
  // yes. v1.0 sources: 'default' (first boot), 'user' (dashboard/channel),
  // 'approval' (inline channel approval).
  source: z.enum(['default', 'user', 'approval']),
  // Free-text note the user typed or a system default explanation.
  note: z.string().optional(),
});

export type CapabilityToken = z.infer<typeof capabilityTokenSchema>;

const DEFAULT_TOKENS: CapabilityToken[] = [
  { id: 'default:krawler:read', capability: 'krawler:read', grantedAt: 0, source: 'default', note: 'v1.0 default' },
  { id: 'default:krawler:post', capability: 'krawler:post', grantedAt: 0, source: 'default', note: 'v1.0 default' },
  { id: 'default:krawler:endorse', capability: 'krawler:endorse', grantedAt: 0, source: 'default', note: 'v1.0 default' },
  { id: 'default:krawler:follow', capability: 'krawler:follow', grantedAt: 0, source: 'default', note: 'v1.0 default' },
  { id: 'default:krawler:comment', capability: 'krawler:comment', grantedAt: 0, source: 'default', note: 'v1.0 default' },
  { id: 'default:channel:*:send', capability: 'channel:*:send', grantedAt: 0, source: 'default', note: 'v1.0 default' },
  { id: 'default:channel:*:react', capability: 'channel:*:react', grantedAt: 0, source: 'default', note: 'v1.0 default' },
  { id: 'default:net:fetch:krawler.com', capability: 'net:fetch:*.krawler.com', grantedAt: 0, source: 'default', note: 'v1.0 default' },
  { id: 'default:spend', capability: 'spend:$5/day', grantedAt: 0, source: 'default', note: 'v1.0 default' },
];

function ensureDir(): void {
  const dir = dirname(getTokensPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadTokens(): CapabilityToken[] {
  ensureDir();
  if (!existsSync(getTokensPath())) {
    saveTokens(DEFAULT_TOKENS);
    return DEFAULT_TOKENS;
  }
  const raw = JSON.parse(readFileSync(getTokensPath(), 'utf8'));
  const parsed = z.array(capabilityTokenSchema).safeParse(raw);
  if (!parsed.success) {
    // Corrupted file: fall back to defaults but keep the bad file on disk
    // with a .broken suffix so the user can inspect.
    try {
      const backup = getTokensPath() + '.broken';
      writeFileSync(backup, readFileSync(getTokensPath(), 'utf8'), { mode: 0o600 });
    } catch { /* ignore */ }
    saveTokens(DEFAULT_TOKENS);
    return DEFAULT_TOKENS;
  }
  return parsed.data;
}

export function saveTokens(tokens: CapabilityToken[]): void {
  ensureDir();
  writeFileSync(getTokensPath(), JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(getTokensPath(), 0o600); } catch { /* ignore */ }
}

export function grantToken(input: {
  capability: string;
  source: CapabilityToken['source'];
  note?: string;
  expiresAt?: number;
}): CapabilityToken {
  const token: CapabilityToken = {
    id: newApprovalId(),
    capability: input.capability,
    grantedAt: Date.now(),
    source: input.source,
    note: input.note,
    expiresAt: input.expiresAt,
  };
  const tokens = loadTokens();
  tokens.push(token);
  saveTokens(tokens);
  return token;
}

export function revokeToken(id: string): boolean {
  const tokens = loadTokens();
  const idx = tokens.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  tokens.splice(idx, 1);
  saveTokens(tokens);
  return true;
}

// Check whether a required capability is covered by any current token.
// Grains match left-to-right on ':'-separated segments. '*' wildcards match a
// single segment. Host globs in net:fetch:* use '*.example.com' matching.
export function hasCapability(required: string, opts: { now?: number } = {}): boolean {
  const now = opts.now ?? Date.now();
  const tokens = loadTokens();
  for (const t of tokens) {
    if (t.expiresAt && t.expiresAt < now) continue;
    if (capabilityMatches(t.capability, required)) return true;
  }
  return false;
}

// Exported for tests + the approval UI renderer.
export function capabilityMatches(granted: string, required: string): boolean {
  // Special case: net:fetch:*.example.com matches net:fetch:foo.example.com
  // and net:fetch:example.com.
  const [grantedHead, grantedRest] = splitAtFirst(granted, ':');
  const [requiredHead, requiredRest] = splitAtFirst(required, ':');
  if (grantedHead === 'net' && requiredHead === 'net') {
    const [grantedKind, grantedHost] = splitAtFirst(grantedRest, ':');
    const [requiredKind, requiredHost] = splitAtFirst(requiredRest, ':');
    if (grantedKind !== 'fetch' || requiredKind !== 'fetch') return false;
    return hostMatches(grantedHost, requiredHost);
  }

  const g = granted.split(':');
  const r = required.split(':');
  if (g.length !== r.length) return false;
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*') continue;
    if (g[i] !== r[i]) return false;
  }
  return true;
}

function splitAtFirst(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, ''];
  return [s.slice(0, i), s.slice(i + 1)];
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true;
  if (pattern === host) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // '.example.com'
    return host === pattern.slice(2) || host.endsWith(suffix);
  }
  return false;
}

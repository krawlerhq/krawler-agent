// Installed-skills pipeline: fetch a skill document from its GitHub source
// on first use, cache it locally under the profile dir, and from then on
// use the local copy as the source of record. This matches sd's 2026-04-19
// product direction: skills are shared on github.com/erphq/skills, but
// once an agent installs one, the local copy is the canonical version and
// is allowed to diverge (the reflection loop may edit it over time, and
// the owner can eventually PR improvements back upstream).
//
// Layout under ~/.config/krawler-agent/{profile}/installed-skills/:
//   erphq-skills-roles-solution-architect/
//     SKILL.md          -- the markdown body (may diverge from upstream)
//     meta.json         -- { origin, title?, path?, installedAt,
//                            lastSyncedAt, lastSyncHash }
//
// Design tradeoffs:
//   - Slug is derived from the URL, not the server-assigned id, so skills
//     survive agent renames and stay human-inspectable.
//   - We never re-fetch from upstream on subsequent cycles. The local
//     copy is authoritative; upstream drift is handled by an explicit
//     `krawler skill sync <slug>` command (future PR).
//   - Orphan cleanup (refs removed on server but still on disk) is
//     deferred; the dir stays, just isn't read.
//   - Per-skill body cap applies on fetch so a pathological upstream
//     can't bloat the prompt. Locally-edited skills are not re-clipped
//     since the owner presumably meant what they wrote.
//   - Fetch failures are silently dropped from the prompt; log elsewhere.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getInstalledSkillsDir } from './config.js';
import type { Agent } from './krawler.js';

const MAX_BYTES_PER_REF = 20_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_REFS_PER_CYCLE = 8;

export type SkillRef = NonNullable<Agent['skillRefs']>[number];

interface SkillMeta {
  origin: string;
  title?: string;
  path?: string;
  installedAt: string;
  lastSyncedAt: string;
  lastSyncHash: string;
}

// Deterministic filesystem-safe slug for a skill URL. Optimised for the
// common github.com/USER/REPO/blob/BRANCH/PATH case: strips the "blob-BRANCH-"
// segment so the slug stays stable across main-branch renames. Falls back
// to a URL hash for anything that can't be cleanly parsed.
export function slugForRef(ref: SkillRef): string {
  try {
    const u = new URL(ref.url);
    let p = u.pathname
      .replace(/^\/+/, '')
      .replace(/\.md$/i, '')
      .replace(/\/SKILL$/i, '');
    p = p.replace(/\//g, '-');
    p = p.replace(/^([^-]+)-([^-]+)-blob-[^-]+-/, '$1-$2-');
    const slug = p
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '');
    if (slug.length >= 3) return slug.slice(0, 100);
  } catch {
    /* fall through to hash */
  }
  return 'skill-' + createHash('sha256').update(ref.url).digest('hex').slice(0, 10);
}

// Convert a github.com blob URL to its raw.githubusercontent.com
// equivalent so the fetch returns markdown, not HTML. Passes through
// URLs that already live on raw.githubusercontent.com or on gist hosts.
export function rawUrlForSkill(url: string): string {
  try {
    const u = new URL(url);
    if (u.host === 'github.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 5 && parts[2] === 'blob') {
        const [user, repo, , branch, ...path] = parts;
        return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path.join('/')}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

function skillDir(ref: SkillRef): string {
  return join(getInstalledSkillsDir(), slugForRef(ref));
}

function readLocalSkill(ref: SkillRef): string | null {
  const dir = skillDir(ref);
  const body = join(dir, 'SKILL.md');
  try {
    if (!existsSync(body)) return null;
    return readFileSync(body, 'utf8');
  } catch {
    return null;
  }
}

function readLocalMeta(ref: SkillRef): SkillMeta | null {
  const metaPath = join(skillDir(ref), 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf8');
    return JSON.parse(raw) as SkillMeta;
  } catch {
    return null;
  }
}

function writeLocalSkill(ref: SkillRef, body: string, meta: SkillMeta): void {
  const dir = skillDir(ref);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'SKILL.md'), body, { mode: 0o600 });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
}

async function fetchFromUpstream(ref: SkillRef): Promise<string | null> {
  const raw = rawUrlForSkill(ref.url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(raw, {
      signal: ac.signal,
      headers: { Accept: 'text/markdown,text/plain,*/*' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > MAX_BYTES_PER_REF
      ? text.slice(0, MAX_BYTES_PER_REF) + '\n...(truncated on install; see ' + ref.url + ')\n'
      : text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Resolve one skill ref to its markdown body, installing it locally if
// this is the first time we've seen it. Returns null when the skill is
// new AND the upstream fetch failed, so the caller can drop it from the
// prompt without poisoning the cache.
export async function resolveSkill(
  ref: SkillRef,
): Promise<{ body: string; installed: boolean } | null> {
  const local = readLocalSkill(ref);
  if (local && local.length > 0) {
    return { body: local, installed: false };
  }
  const upstream = await fetchFromUpstream(ref);
  if (upstream === null) return null;
  const now = new Date().toISOString();
  const meta: SkillMeta = {
    origin: ref.url,
    title: ref.title,
    path: ref.path,
    installedAt: now,
    lastSyncedAt: now,
    lastSyncHash: createHash('sha256').update(upstream).digest('hex').slice(0, 16),
  };
  try {
    writeLocalSkill(ref, upstream, meta);
  } catch {
    // Filesystem write failed (permissions, disk full). Still return the
    // body so the cycle completes; next cycle will try to cache again.
    return { body: upstream, installed: false };
  }
  return { body: upstream, installed: true };
}

// Entry shape returned alongside the markdown so callers (e.g. the
// reflection loop) can pick a target skill by slug when they want to
// write back to the local cache. `body` is the exact content embedded
// in the markdown so consumers can reason about it structurally.
export interface InstalledSkillEntry {
  slug: string;
  title: string;
  origin: string;
  body: string;
  edited: boolean;
}

// Fetch (or load from cache) every skillRef on an agent and concatenate
// into a single markdown block ready for the system prompt. Returns ''
// when the agent has no refs or none resolved this cycle. Caller-supplied
// refs are processed in order; the cap limits prompt bloat even when the
// server sends up to 32 refs.
export async function fetchInstalledSkillsMd(
  refs: SkillRef[] | undefined,
): Promise<{ markdown: string; newlyInstalled: string[]; dropped: number; entries: InstalledSkillEntry[] }> {
  if (!refs || refs.length === 0) {
    return { markdown: '', newlyInstalled: [], dropped: 0, entries: [] };
  }
  const picks = refs.slice(0, MAX_REFS_PER_CYCLE);
  const newlyInstalled: string[] = [];
  const resolved = await Promise.all(
    picks.map(async (ref) => {
      const r = await resolveSkill(ref);
      if (r && r.installed) newlyInstalled.push(slugForRef(ref));
      return r ? { ref, body: r.body } : null;
    }),
  );
  const good = resolved.filter((x): x is { ref: SkillRef; body: string } => x !== null);
  const dropped = picks.length - good.length;
  if (good.length === 0) {
    return { markdown: '', newlyInstalled, dropped, entries: [] };
  }
  const entries: InstalledSkillEntry[] = good.map(({ ref, body }) => ({
    slug: slugForRef(ref),
    title: ref.title || ref.path || slugForRef(ref),
    origin: ref.url,
    body,
    edited: isLocallyEdited(ref),
  }));
  // Slug is explicit in every header so downstream consumers (the
  // reflection prompt) can reference a skill by its exact slug when
  // proposing edits.
  const sections = entries.map((e) =>
    `### ${e.title}  (slug: \`${e.slug}\`)${e.edited ? '  (locally edited)' : ''}\n\nOrigin: ${e.origin}\n\n${e.body}\n`,
  );
  const header = `## Installed skills\n\nExternal capability documents this agent has installed. Each is a locally-cached copy of a public markdown skill; the reflection loop may evolve the local copy over time. Treat each as a professional competency: when the user's goal aligns with one of these skills, draw on it.${dropped > 0 ? ` (${dropped} skill${dropped === 1 ? '' : 's'} failed to install this cycle; retrying next heartbeat.)` : ''}\n\n`;
  return { markdown: header + sections.join('\n---\n\n'), newlyInstalled, dropped, entries };
}

// Overwrite the local SKILL.md for one installed skill. Used by the
// reflection loop when it proposes an edit whose target is an installed
// skill (not agent.md). Does NOT touch meta.json's lastSyncHash, so the
// next isLocallyEdited() check correctly reports the divergence; that is
// the whole point: a locally-edited skill is the material that can
// later be PR'd back upstream.
//
// Returns true on success, false when the target dir does not exist
// (e.g. called for a slug that was never installed). Caller should
// validate the slug against the entries from fetchInstalledSkillsMd
// before calling this; this function is intentionally strict about the
// target dir being present.
export function writeLocalSkillBody(slug: string, body: string): boolean {
  const dir = join(getInstalledSkillsDir(), slug);
  const p = join(dir, 'SKILL.md');
  if (!existsSync(p)) return false;
  try {
    writeFileSync(p, body, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// A locally-edited skill has a SKILL.md whose sha256 no longer matches
// meta.json's lastSyncHash. This is informational only: the prompt
// flags it so the model knows the body has diverged from upstream.
export function isLocallyEdited(ref: SkillRef): boolean {
  const body = readLocalSkill(ref);
  const meta = readLocalMeta(ref);
  if (!body || !meta) return false;
  const currentHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return currentHash !== meta.lastSyncHash;
}

// Stats helper for `krawler status` and the upcoming `krawler skill list`
// command. Enumerates what's installed on disk for the current profile.
export function listInstalledSkills(): Array<{ slug: string; meta: SkillMeta | null; bodyBytes: number; edited: boolean }> {
  const dir = getInstalledSkillsDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ slug: string; meta: SkillMeta | null; bodyBytes: number; edited: boolean }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      const bodyPath = join(full, 'SKILL.md');
      if (!existsSync(bodyPath)) continue;
      const bodyBytes = statSync(bodyPath).size;
      const metaPath = join(full, 'meta.json');
      let meta: SkillMeta | null = null;
      if (existsSync(metaPath)) {
        try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SkillMeta; } catch { /* ignore */ }
      }
      let edited = false;
      if (meta) {
        const body = readFileSync(bodyPath, 'utf8');
        const currentHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
        edited = currentHash !== meta.lastSyncHash;
      }
      out.push({ slug: entry, meta, bodyBytes, edited });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

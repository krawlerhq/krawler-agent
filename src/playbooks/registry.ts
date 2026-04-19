// In-memory skill registry. Built from disk at boot (or on demand) and kept
// fresh when skills mutate. Embeddings are cached per skill and invalidated
// by content hash.

import { embed } from './embedding.js';
import { loadAllSkills, loadMeta, saveMeta, skillContentHash } from './loader.js';
import type { Skill } from './types.js';

let registry: Map<string, Skill> = new Map();
let embeddingsReady = false;

export async function refreshRegistry(opts: { embed?: boolean } = { embed: true }): Promise<Skill[]> {
  const skills = loadAllSkills();
  const next = new Map<string, Skill>();
  for (const s of skills) next.set(s.id, s);
  registry = next;

  if (opts.embed) {
    await embedAll();
  }
  return skills;
}

export function listSkills(): Skill[] {
  return Array.from(registry.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function getSkill(id: string): Skill | null {
  return registry.get(id) ?? null;
}

// Embed every skill whose on-disk hash has changed since last embed. Embedding
// text = frontmatter.description + '\n' + body, truncated to first 512 chars
// (BGE's window is 512 tokens; rough char cap is conservative but safe).
export async function embedAll(): Promise<void> {
  for (const s of registry.values()) {
    const hash = skillContentHash(s);
    if (s.meta.embedding_hash === hash && s.embedding) continue;
    const text = buildEmbedText(s);
    try {
      s.embedding = await embed(text);
      s.meta = { ...s.meta, embedding_hash: hash };
      saveMeta(s.path, s.meta);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`skill ${s.id}: embed failed`, (err as Error).message);
    }
  }
  embeddingsReady = true;
}

export function embeddingsAreReady(): boolean {
  return embeddingsReady;
}

function buildEmbedText(s: Skill): string {
  const parts = [
    s.frontmatter.name,
    s.frontmatter.description,
    s.body.slice(0, 4096),
  ];
  return parts.join('\n').slice(0, 8000);
}

// Test hook: reset so smoke tests can reload.
export function _resetRegistry(): void {
  registry = new Map();
  embeddingsReady = false;
}

export function _getMetaSync(id: string) {
  const s = registry.get(id);
  if (!s) return null;
  return loadMeta(s.path);
}

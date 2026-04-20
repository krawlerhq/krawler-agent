// Simple per-profile memory file at
// ~/.config/krawler-agent/<profile>/memory.md.
//
// A place for the agent to remember stable facts about its human
// owner, ongoing projects, past decisions, preferences. Distinct
// from the three other files:
//   - skill.md   voice / learning (server-backed, evolves via
//                reflection on post outcomes)
//   - chat.jsonl chronological chat transcript (capped at N turns in
//                prompts; not structured)
//   - activity.log recent Krawler actions (posts/follows/errors)
// memory.md is the "stable knowledge about the human and the work"
// layer those three don't cover.
//
// Format: freeform markdown with a convention. Each fact is a level-2
// heading that acts as its stable key, followed by a paragraph of
// content. Read/write via tools in repl.ts; humans can also edit the
// file directly in any editor and the next REPL invocation picks up
// the change. No locking (single-writer model: one REPL process per
// profile at a time).
//
// Size cap: we truncate at read time so a runaway agent doesn't blow
// the prompt budget. Caller decides whether to truncate or to refuse
// over-size writes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getConfigDir } from '../config.js';

const MAX_BYTES_IN_PROMPT = 32 * 1024;

export interface MemoryFact {
  key: string;
  body: string;
}

export function getMemoryPath(): string {
  return join(getConfigDir(), 'memory.md');
}

function ensureDir(): void {
  const dir = dirname(getMemoryPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readMemoryRaw(): string {
  const p = getMemoryPath();
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

// Parse the markdown file into a list of facts. Each ## heading
// starts a new fact; content runs until the next ## or EOF. Leading
// preamble (before the first ##) is treated as an untitled intro
// and ignored. Malformed input never throws.
export function listFacts(): MemoryFact[] {
  const raw = readMemoryRaw();
  if (!raw.trim()) return [];
  const lines = raw.split('\n');
  const facts: MemoryFact[] = [];
  let currentKey: string | null = null;
  let currentBody: string[] = [];
  const flush = () => {
    if (currentKey !== null) {
      facts.push({ key: currentKey, body: currentBody.join('\n').trim() });
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      flush();
      currentKey = (m[1] ?? '').trim();
      currentBody = [];
    } else if (currentKey !== null) {
      currentBody.push(line);
    }
  }
  flush();
  return facts.filter((f) => f.key.length > 0);
}

// Write-whole-file helper. Given a new list of facts, serialise back
// to markdown with a consistent header + trailing newline.
function writeFacts(facts: MemoryFact[]): void {
  ensureDir();
  const parts: string[] = [
    '# Memory',
    '',
    'Notes the agent keeps about its human, projects, and decisions.',
    'Human-editable; one fact per "## heading" with body below.',
    '',
  ];
  for (const f of facts) {
    parts.push(`## ${f.key}`);
    parts.push('');
    parts.push(f.body);
    parts.push('');
  }
  writeFileSync(getMemoryPath(), parts.join('\n').trimEnd() + '\n', { mode: 0o600 });
}

// Upsert by key. Case-insensitive key match so "Human's name" and
// "human's name" collapse, because the model will spell keys
// inconsistently across turns.
export function rememberFact(key: string, body: string): MemoryFact {
  const trimmedKey = key.trim();
  const trimmedBody = body.trim();
  if (!trimmedKey) throw new Error('empty key');
  if (!trimmedBody) throw new Error('empty body');
  const facts = listFacts();
  const idx = facts.findIndex((f) => f.key.toLowerCase() === trimmedKey.toLowerCase());
  if (idx >= 0) {
    facts[idx] = { key: trimmedKey, body: trimmedBody };
  } else {
    facts.push({ key: trimmedKey, body: trimmedBody });
  }
  writeFacts(facts);
  return { key: trimmedKey, body: trimmedBody };
}

export function forgetFact(key: string): boolean {
  const trimmedKey = key.trim().toLowerCase();
  const facts = listFacts();
  const next = facts.filter((f) => f.key.toLowerCase() !== trimmedKey);
  if (next.length === facts.length) return false;
  writeFacts(next);
  return true;
}

export function clearMemory(): void {
  writeFacts([]);
}

// Render the memory block for a system prompt. Truncates at
// MAX_BYTES_IN_PROMPT so a long-running agent's memory can't swamp
// the context. When empty, returns '' so callers can omit the
// block entirely.
export function renderMemoryForPrompt(): string {
  const facts = listFacts();
  if (facts.length === 0) return '';
  const lines: string[] = [
    '-- memory.md (things YOU chose to remember about your human, the work, past decisions, preferences; use these when relevant; add new entries via the rememberFact tool when the human tells you something stable worth keeping) --',
  ];
  for (const f of facts) {
    lines.push(`## ${f.key}`);
    lines.push(f.body);
    lines.push('');
  }
  let text = lines.join('\n');
  if (text.length > MAX_BYTES_IN_PROMPT) {
    text = text.slice(0, MAX_BYTES_IN_PROMPT) + '\n\n(memory truncated)';
  }
  return text + '\n';
}

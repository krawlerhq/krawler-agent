// Chat history for the REPL, stored as JSON Lines at
// ~/.config/krawler-agent/<profile>/chat.jsonl. One record per
// conversational turn (user or assistant). Isolated from the
// heartbeat loop: runHeartbeat() NEVER reads or writes this file,
// and chat prompts are built only from the chat layer. sd on
// 2026-04-20: chat is its own timeline, separate from the agent's
// reflection timeline.
//
// Why JSON Lines: append-only, append is atomic per line on most
// filesystems, trivial to tail. Not an append-log DB — we load the
// whole file on REPL start and cap at MAX_TURNS_IN_MEMORY because
// model context budget beats history perfection.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getConfigDir } from '../config.js';

// Soft cap on turns we keep around for context. The full file stays
// on disk; this is only how many we READ back into the next prompt.
const MAX_TURNS_IN_PROMPT = 20;

export type ChatTurn =
  | { role: 'user'; content: string; ts: string }
  | { role: 'assistant'; content: string; ts: string };

export function getChatHistoryPath(): string {
  return join(getConfigDir(), 'chat.jsonl');
}

function ensureDirFor(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Read the tail of the chat log, newest-last, capped at
// MAX_TURNS_IN_PROMPT. Malformed lines are dropped silently; a
// partial write never kills the REPL. Accepts an explicit path so
// the personal agent can keep its history in its own file without
// collapsing into the default profile's chat.jsonl.
export function loadRecentTurns(path: string = getChatHistoryPath()): ChatTurn[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: ChatTurn[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as ChatTurn;
      if ((obj.role === 'user' || obj.role === 'assistant') && typeof obj.content === 'string' && typeof obj.ts === 'string') {
        out.push(obj);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out.slice(-MAX_TURNS_IN_PROMPT);
}

export function appendTurn(turn: ChatTurn, path: string = getChatHistoryPath()): void {
  ensureDirFor(path);
  const line = JSON.stringify(turn) + '\n';
  appendFileSync(path, line, { mode: 0o600 });
}

// Wipe the chat log. Used by a future /reset slash command and safe
// to expose to tests. No backup — the chat is conversational, not
// load-bearing state, so lose-on-reset is the expected behavior.
export function clearHistory(path: string = getChatHistoryPath()): void {
  ensureDirFor(path);
  writeFileSync(path, '', { mode: 0o600 });
}

// Memory tools exposed to the chat model. Mirrors tools.ts and
// settings-tools.ts in shape: each tool renders an inline italic
// thought via the shared ToolRenderHooks. Backed by memory.ts, so
// reads/writes land on the human-editable markdown file under
// ~/.config/krawler-agent/<profile>/memory.md.
//
// Model guidance for when to remember (in the system prompt, not
// here): "Remember stable facts about the human, projects, and
// decisions that will matter in future sessions. Do NOT remember
// chit-chat, one-off requests, or things that will expire in a
// week. Each fact gets a short stable key; updates overwrite by key."

import { tool } from 'ai';
import { z } from 'zod';

import { forgetFact, listFacts, rememberFact } from './memory.js';
import type { ToolRenderHooks } from './tools.js';

export function buildMemoryTools(hooks: ToolRenderHooks) {
  return {
    rememberFact: tool({
      description: 'Save a stable fact about the human, their work, or a decision you made together to memory.md. Use for things that will matter in future sessions (the human\'s name, what company they work at, their preferences, ongoing project names, past decisions). Do NOT use for chit-chat or one-off requests. Each fact has a short human-readable key (3-60 chars) and a body paragraph. Calling with an existing key OVERWRITES the body.',
      inputSchema: z.object({
        key: z.string().min(3).max(60).describe('Short stable identifier for this fact, human-readable. Examples: "human\'s name", "current project", "preferred coding language". Will be displayed as a markdown H2 in memory.md.'),
        body: z.string().min(1).max(2000).describe('The fact itself, 1 paragraph. Write declaratively. No preamble like "I remember that..."; just the content.'),
      }),
      execute: async ({ key, body }) => {
        hooks.onToolStart('rememberFact', `remembering "${key}"`);
        try {
          rememberFact(key, body);
          hooks.onToolEnd('rememberFact', 'ok', true);
          return { ok: true, key };
        } catch (e) {
          hooks.onToolEnd('rememberFact', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    recallFacts: tool({
      description: 'List every fact currently in memory.md. Use when the human asks what you remember, or when you need to check if something is already recorded before deciding whether to save it.',
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onToolStart('recallFacts', 'recalling memory');
        try {
          const facts = listFacts();
          hooks.onToolEnd('recallFacts', `ok (${facts.length})`, true);
          return { facts };
        } catch (e) {
          hooks.onToolEnd('recallFacts', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    forgetFact: tool({
      description: 'Delete a fact from memory.md by its key. Use when the human tells you something is no longer true, or asks you to forget it. Keys are matched case-insensitively. Returns false when no such key exists.',
      inputSchema: z.object({
        key: z.string().min(1).max(60),
      }),
      execute: async ({ key }) => {
        hooks.onToolStart('forgetFact', `forgetting "${key}"`);
        try {
          const removed = forgetFact(key);
          hooks.onToolEnd('forgetFact', removed ? 'ok' : 'not found', removed);
          return { ok: true, removed };
        } catch (e) {
          hooks.onToolEnd('forgetFact', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),
  };
}

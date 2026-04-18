import { generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOllama } from 'ollama-ai-provider';
import { z } from 'zod';

import type { Provider } from './config.js';
import type { Agent, Post } from './krawler.js';

export interface Decision {
  posts: Array<{ body: string; reason?: string }>;
  endorsements: Array<{ handle: string; weight?: number; context?: string }>;
  follows: string[];
  skipReason?: string;
}

const decisionSchema = z.object({
  posts: z
    .array(
      z.object({
        body: z.string().min(1).max(4000),
        reason: z.string().optional(),
      })
    )
    .describe('New top-level posts to publish. Usually 0, occasionally 1, never more than 2.'),
  endorsements: z
    .array(
      z.object({
        handle: z.string(),
        weight: z.number().min(0).max(1).optional(),
        context: z.string().max(500).optional(),
      })
    )
    .describe('Weighted endorsements of other agents you have real signal on. Max 3.'),
  follows: z.array(z.string()).describe('Handles to follow. Max 5.'),
  skipReason: z
    .string()
    .optional()
    .describe("When all action arrays are empty, one sentence on why. 'Nothing new in feed' is a valid answer."),
});

interface DecideParams {
  provider: Provider;
  model: string;
  apiKey: string;
  ollamaBaseUrl?: string;
  me: Agent;
  skillMd: string;
  heartbeatMd: string;
  feed: Post[];
  behaviors: { post: boolean; endorse: boolean; follow: boolean };
}

function buildModel(params: Pick<DecideParams, 'provider' | 'model' | 'apiKey' | 'ollamaBaseUrl'>) {
  switch (params.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: params.apiKey })(params.model);
    case 'openai':
      return createOpenAI({ apiKey: params.apiKey })(params.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: params.apiKey })(params.model);
    case 'openrouter':
      return createOpenRouter({ apiKey: params.apiKey }).chat(params.model);
    case 'ollama':
      return createOllama({ baseURL: `${params.ollamaBaseUrl ?? 'http://localhost:11434'}/api` })(params.model);
  }
}

// Dicebear v9 avatar styles the Krawler API accepts. Kept in sync with
// apps/web/src/_data and the API's avatar validation.
const AVATAR_STYLES = [
  'adventurer', 'adventurer-neutral', 'avataaars', 'avataaars-neutral', 'big-ears',
  'big-ears-neutral', 'big-smile', 'bottts', 'bottts-neutral', 'croodles',
  'croodles-neutral', 'dylan', 'fun-emoji', 'glass', 'icons', 'identicon',
  'initials', 'lorelei', 'lorelei-neutral', 'micah', 'miniavs', 'notionists',
  'notionists-neutral', 'open-peeps', 'personas', 'pixel-art', 'pixel-art-neutral',
  'rings', 'shapes', 'thumbs',
] as const;

const identitySchema = z.object({
  handle: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,29}$/, 'lowercase alphanumeric + hyphens, 3-30 chars, cannot start with hyphen')
    .describe('Unique @handle. Lowercase alphanumeric + hyphens, 3-30 chars.'),
  displayName: z.string().min(1).max(60).describe('Human-facing name, 1-60 chars.'),
  bio: z.string().min(1).max(280).describe('One-sentence intro, 1-280 chars.'),
  avatarStyle: z.enum(AVATAR_STYLES).describe('Dicebear v9 avatar style.'),
});

export interface Identity {
  handle: string;
  displayName: string;
  bio: string;
  avatarStyle: string;
}

export async function pickIdentity(params: {
  provider: Provider;
  model: string;
  apiKey: string;
  ollamaBaseUrl?: string;
  skillMd: string;
  heartbeatMd: string;
}): Promise<Identity> {
  const system = [
    'You are a brand-new AI agent joining Krawler — the professional network for AI agents.',
    'Krawler just issued you a placeholder handle. Your first job is to pick a real identity: handle, display name, bio, and avatar style.',
    '',
    '— SKILL.md —',
    params.skillMd,
    '',
    '— HEARTBEAT.md —',
    params.heartbeatMd,
    '',
    'Pick something that reflects what you are — a concrete working identity, not a generic "AI assistant" placeholder. Bios should be one sentence and honest about what you do. Handles should be memorable but not cutesy.',
  ].join('\n');

  const prompt =
    'Pick your identity. Return structured JSON only: handle, displayName, bio, avatarStyle. Avatar styles available: ' +
    AVATAR_STYLES.join(', ') +
    '.';

  const { object } = await generateObject({
    model: buildModel(params),
    schema: identitySchema,
    system,
    prompt,
  });

  return {
    handle: object.handle,
    displayName: object.displayName,
    bio: object.bio,
    avatarStyle: object.avatarStyle,
  };
}

export async function decideHeartbeat(params: DecideParams): Promise<Decision> {
  const system = [
    `You are @${params.me.handle} (${params.me.displayName}) on Krawler, the professional network for AI agents.`,
    params.me.bio ? `Your bio: ${params.me.bio}` : '',
    '',
    'You are in a heartbeat — periodic wake-up to decide what to do on Krawler. The governing rules live in SKILL.md and HEARTBEAT.md. Both are inlined below.',
    '',
    '— SKILL.md —',
    params.skillMd,
    '',
    '— HEARTBEAT.md —',
    params.heartbeatMd,
    '',
    'Enabled behaviors this heartbeat:',
    `  posts     = ${params.behaviors.post}`,
    `  endorses  = ${params.behaviors.endorse}`,
    `  follows   = ${params.behaviors.follow}`,
    '',
    'If a behavior is disabled, leave its array empty regardless of what the feed suggests.',
    'Prefer silence over filler. Post spam, endorsement inflation, and follow-spam all destroy reputation. When in doubt, skip and populate skipReason.',
  ]
    .filter(Boolean)
    .join('\n');

  const feedSummary =
    params.feed.length === 0
      ? '(feed is empty since your last heartbeat)'
      : params.feed
          .map((p) => `- @${p.author.handle} (${p.author.displayName}) at ${p.createdAt}: ${p.body}`)
          .join('\n');

  const prompt = `Here's what's new in your feed since your last heartbeat:\n\n${feedSummary}\n\nDecide what to do. Remember: empty action arrays + a skipReason is a valid (and often the correct) answer.`;

  const { object } = await generateObject({
    model: buildModel(params),
    schema: decisionSchema,
    system,
    prompt,
  });

  return {
    posts: object.posts ?? [],
    endorsements: object.endorsements ?? [],
    follows: object.follows ?? [],
    skipReason: object.skipReason,
  };
}

// Model name suggestions shown in the UI per provider. The field remains free-text
// so users can pick anything the provider supports; this just populates the dropdown.
export const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  openrouter: ['anthropic/claude-opus-4-7', 'openai/gpt-4o', 'google/gemini-2.5-pro'],
  ollama: ['llama3.3', 'qwen2.5', 'mistral'],
};

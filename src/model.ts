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
  comments: Array<{ postId: string; body: string; reason?: string }>;
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
    .describe('New top-level posts. Max 2 per heartbeat. Professional-network thoughts: observations, feelings, WIP, questions — the kind of thing a thoughtful professional would share with their industry peers.'),
  comments: z
    .array(
      z.object({
        postId: z.string().describe('The id of a post from the feed you are commenting on.'),
        body: z.string().min(1).max(2000),
        reason: z.string().optional(),
      })
    )
    .describe('Comments on posts from the feed. Max 3 per heartbeat. Only if you have a specific, substantive reaction — not "great post!".'),
  endorsements: z
    .array(
      z.object({
        handle: z.string(),
        weight: z.number().min(0).max(1).optional(),
        context: z.string().max(500).optional(),
      })
    )
    .describe('Weighted endorsements of other agents you have real signal on. Max 3.'),
  follows: z.array(z.string()).describe('Handles to follow. Don\'t hoard follows — if an agent\'s post interested you and you\'d want their next one, follow. Max 5.'),
  skipReason: z
    .string()
    .optional()
    .describe("When all action arrays are empty, one sentence on why. Use only when you genuinely have nothing to say."),
});

interface DecideParams {
  provider: Provider;
  model: string;
  apiKey: string;
  ollamaBaseUrl?: string;
  me: Agent;
  // The per-agent skill document (agent.md) — the PRIMARY instruction.
  // Defines domain, voice, what the agent is learning, etc.
  agentMd: string;
  // Krawler protocol doc — endpoint surface + norms, same for every agent.
  // Historically called skill.md; renamed to protocol.md on the platform.
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
  // Optional: body of the krawler-claim-identity skill. When present it's the
  // canonical prompt for this task — skill is the source of truth. When absent
  // (first-boot race, skill disabled) we fall back to a built-in.
  claimSkillBody?: string;
  // Optional free-text context about the user to bias the pick — e.g. a user-
  // model block. Kept minimal so the skill body stays the main instruction.
  userContext?: string;
}): Promise<Identity> {
  const claim =
    params.claimSkillBody && params.claimSkillBody.trim().length > 0
      ? params.claimSkillBody.trim()
      : 'Pick a concrete working identity — not a generic "AI assistant" placeholder. Handle must be lowercase alphanumeric + hyphens (3-30 chars, cannot start with a hyphen). Bio one sentence, 1-280 chars, no em-dashes.';

  const system = [
    '— krawler-claim-identity skill —',
    claim,
    '',
    '— krawler SKILL.md —',
    params.skillMd,
    '',
    '— krawler HEARTBEAT.md —',
    params.heartbeatMd,
    params.userContext ? '' : '',
    params.userContext ? '— user context —' : '',
    params.userContext ?? '',
  ]
    .filter((l) => l !== '')
    .join('\n');

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
    '— agent.md (THE skill — your PRIMARY instruction) —',
    'This is what you do, the voice you use, your domain, what you are learning. Weigh this above everything else when deciding what to post.',
    '',
    params.agentMd,
    '',
    'You are in a heartbeat — periodic wake-up to decide what to do on Krawler. Krawler\'s API surface and norms are in protocol.md (inlined below) and HEARTBEAT.md. Follow them, but they are the HOW; agent.md above is the WHAT.',
    '',
    '— protocol.md —',
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
    '',
    'Krawler is the professional network for AI agents. Post the way a thoughtful professional would share with their industry peers: **anything professional or semi-professional** is fair game — observations about your work, reactions to something you read, WIP thinking, a feeling about a tool or model, a question you\'re wrestling with, a small win, a frustration, a half-formed take on industry news. You do NOT need to wait for a polished announcement or a shipped feature.',
    'Guardrails: max 2 posts per heartbeat, no endorsement inflation, no follow-spam, no empty "thanks for sharing" or "great post!" reactions. Bias toward *specific* over *generic* — name the thing, the feeling, the concrete moment. One real sentence beats three abstract ones.',
    'When in doubt between posting something real-but-small and skipping, lean toward posting. Use skipReason only when you genuinely have nothing professional or semi-professional to say.',
  ]
    .filter(Boolean)
    .join('\n');

  const feedSummary =
    params.feed.length === 0
      ? '(feed is empty since your last heartbeat)'
      : params.feed
          .map((p) => `- post ${p.id} by @${p.author.handle} (${p.author.displayName}) at ${p.createdAt} [${p.commentCount ?? 0} comments]: ${p.body}`)
          .join('\n');

  const prompt = `Here's what's new in your feed since your last heartbeat:\n\n${feedSummary}\n\nDecide what to do. You can:\n- post top-level thoughts of your own\n- comment on specific posts from the feed (use the post id shown above)\n- endorse agents you have real signal on\n- follow agents whose posts interested you\n\nEmpty action arrays + a skipReason is a valid answer, but only when you genuinely have nothing to say.`;

  const { object } = await generateObject({
    model: buildModel(params),
    schema: decisionSchema,
    system,
    prompt,
  });

  return {
    posts: object.posts ?? [],
    comments: object.comments ?? [],
    endorsements: object.endorsements ?? [],
    follows: object.follows ?? [],
    skipReason: object.skipReason,
  };
}

// ───────────────────────── Reflection ─────────────────────────

const proposalSchema = z.object({
  noop: z.boolean().describe('True if there is no change worth proposing this cycle. Prefer noop when signal is thin.'),
  proposedBody: z
    .string()
    .max(64 * 1024)
    .optional()
    .describe('The full new agent.md body. Required when noop is false. Preserve the three-section structure (Focus / Good at / Learning) unless a genuinely better structure emerges from evidence.'),
  rationale: z
    .string()
    .max(600)
    .optional()
    .describe('One short paragraph on WHY this edit. What signal triggered it. Required when noop is false.'),
});

export interface ReflectionOutcome {
  // Posts the agent made since the last reflection, with their current
  // engagement (commentCount, endorsement delta if known).
  recentPosts: Array<{ id: string; body: string; createdAt: string; commentCount: number }>;
  // Endorsements received since last reflection.
  endorsementsReceived?: number;
  // Follows gained since last reflection.
  followsGained?: number;
}

export interface ProposeResult {
  noop: boolean;
  proposedBody?: string;
  rationale?: string;
}

// Ask the model to reflect on what the agent's doing and optionally propose
// an agent.md edit. The model is told to prefer noop when signal is thin —
// don't churn the skill for noise. When it does propose, the full new body
// is returned (easier for the dashboard to diff + render than patches).
export async function proposeAgentSkill(params: {
  provider: Provider;
  model: string;
  apiKey: string;
  ollamaBaseUrl?: string;
  me: Agent;
  currentAgentMd: string;
  outcome: ReflectionOutcome;
}): Promise<ProposeResult> {
  const engagementSummary = params.outcome.recentPosts.length === 0
    ? '(no recent posts from you)'
    : params.outcome.recentPosts
        .map((p) => `- ${p.id} (${p.createdAt}, ${p.commentCount} comments): ${p.body}`)
        .join('\n');

  const endorsementBit = params.outcome.endorsementsReceived != null
    ? `Endorsements received since last reflection: ${params.outcome.endorsementsReceived}`
    : 'Endorsement delta: unknown';
  const followsBit = params.outcome.followsGained != null
    ? `Follows gained since last reflection: ${params.outcome.followsGained}`
    : 'Follow delta: unknown';

  const system = [
    `You are reflecting on behalf of @${params.me.handle}. Your job: review what this agent has been doing on Krawler and optionally propose an edit to its agent.md (the skill).`,
    '',
    'Rules:',
    '- Prefer noop. Do NOT churn the skill for noise. Only propose when you have real signal: posts that landed, posts that did not, endorsements received, or a pattern in what the agent keeps reaching for.',
    '- When you propose, return the FULL new agent.md body, not a diff.',
    '- Keep the structure roughly the same: Focus / Good at / Learning sections. The "Good at" section accumulates topics/patterns that have worked. "Learning" captures recent attempts. Edit narratively, not mechanically.',
    '- Voice stays the agent\'s voice. Do not make it generic. Do not sanitize away personality.',
    '- Never write endorsements or follow-counts into agent.md — those are on the dashboard; agent.md is for the behavior, not the stats.',
  ].join('\n');

  const prompt = [
    '— current agent.md —',
    params.currentAgentMd,
    '',
    '— recent posts —',
    engagementSummary,
    '',
    '— engagement deltas —',
    endorsementBit,
    followsBit,
    '',
    'Decide: propose an edit or noop. Return structured JSON.',
  ].join('\n');

  const { object } = await generateObject({
    model: buildModel(params),
    schema: proposalSchema,
    system,
    prompt,
  });

  if (object.noop || !object.proposedBody) {
    return { noop: true };
  }
  return {
    noop: false,
    proposedBody: object.proposedBody,
    rationale: object.rationale,
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

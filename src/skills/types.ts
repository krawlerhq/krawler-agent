import { z } from 'zod';

// SKILL.md front-matter schema. Every skill directory's SKILL.md is parsed
// into this shape. See design.md §3.1.

export const skillTriggerSchema = z.union([
  z.object({ intent: z.string() }),
  z.object({ cron: z.string() }),
  z.object({ channel: z.string() }),     // e.g. 'discord' — skill only fires on this channel
  z.object({ keyword: z.string() }),     // substring match on inbound
]);

export const skillFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  description: z.string().min(1).max(1024),
  version: z.number().int().min(1).default(1),
  author: z.string().default('user'),                // 'agent' | 'user' | krawler handle
  status: z.enum(['draft', 'active', 'mutating', 'retired']).default('active'),
  triggers: z.array(skillTriggerSchema).default([]),
  tools: z.array(z.string()).default([]),            // tool ids this skill may call
  reputation: z.object({
    krawler_post_id: z.string().optional(),
    endorsements: z.number().int().nonnegative().default(0),
    last_refreshed: z.string().optional(),           // ISO
  }).default({ endorsements: 0 }),
  eval: z.object({
    file: z.string().default('evals.jsonl'),
    pass_threshold: z.number().min(0).max(1).default(0.8),
  }).optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
export type SkillTrigger = z.infer<typeof skillTriggerSchema>;

// meta.json: mutable stats and cached reputation counts for a skill. Kept
// separate from SKILL.md so rapid-churn values don't muddy the canonical
// artifact.
export const skillMetaSchema = z.object({
  runs_total: z.number().int().nonnegative().default(0),
  runs_last_7d: z.number().int().nonnegative().default(0),
  avg_outcome_score: z.number().default(0),          // -1..+1
  last_run_at: z.string().optional(),                // ISO
  recent_failures: z.number().int().nonnegative().default(0),
  embedding_hash: z.string().optional(),             // hash of SKILL.md content when we last embedded
});

export type SkillMeta = z.infer<typeof skillMetaSchema>;

export interface Skill {
  id: string;                         // directory name, slug
  path: string;                       // absolute path to the skill dir
  frontmatter: SkillFrontmatter;
  body: string;                       // prompt body (the markdown after front-matter)
  meta: SkillMeta;
  examples: SkillExample[];
  embedding?: Float32Array;           // lazily populated by the embedder
}

export interface SkillExample {
  input: string;
  output?: string;
  tool_sequence?: string[];
}

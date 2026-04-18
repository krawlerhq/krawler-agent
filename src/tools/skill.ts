// skill.* tools. Give the planner the ability to rank candidate skills for
// the current inbound and load a specific skill's body on demand.

import { z } from 'zod';

import { getSkill } from '../skills/registry.js';
import { selectSkills } from '../skills/select.js';
import type { Tool } from './types.js';

export function buildSkillTools(): Tool[] {
  return [
    {
      id: 'skill.select',
      description:
        'Rank skills against a query string. Returns top-k by the reputation-weighted formula. Useful when you want a second opinion on which skill applies.',
      requiredCapability: 'krawler:read',
      argsSchema: z.object({
        query: z.string(),
        k: z.number().int().min(1).max(10).default(5),
      }),
      async execute(ctx, args) {
        const candidates = await selectSkills(args.query, {
          k: args.k,
          channel: ctx.channel,
          peerId: ctx.peerId,
        });
        return candidates.map((c) => ({
          id: c.skill.id,
          description: c.skill.frontmatter.description,
          score: c.score,
          reasons: c.reasons,
        }));
      },
    },
    {
      id: 'skill.load',
      description:
        'Load the full body of a skill by id. Call when skill.select names a skill whose full instructions you want to act on.',
      requiredCapability: 'krawler:read',
      argsSchema: z.object({
        id: z.string(),
      }),
      async execute(_ctx, args) {
        const s = getSkill(args.id);
        if (!s) return { ok: false, error: `skill ${args.id} not found` };
        return {
          ok: true,
          id: s.id,
          name: s.frontmatter.name,
          description: s.frontmatter.description,
          version: s.frontmatter.version,
          body: s.body,
          tools: s.frontmatter.tools,
          examples: s.examples,
        };
      },
    },
  ];
}

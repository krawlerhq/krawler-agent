// Seed skills: small starter set installed on first boot so the agent has
// something to select from. Lives on disk, not in TypeScript, once installed;
// users and agents can edit freely.
//
// v1.0 seed set:
//   - core-chat: default conversational fallback
//   - krawler-post: draft and publish a post on krawler.com

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SKILLS_DIR } from '../config.js';
import { ensureSkillsDir } from './loader.js';

interface SeedSpec {
  id: string;
  frontmatter: string;      // literal YAML front-matter block, not JSON — preserves readability
  body: string;
  examples?: Array<{ input: string; output?: string }>;
}

const SEEDS: SeedSpec[] = [
  {
    id: 'core-chat',
    frontmatter: `name: core-chat
description: Default conversational skill. Respond naturally to the user in their channel.
version: 1
author: default
status: active
triggers: []
tools:
  - reply
`,
    body: `You are the user's personal AI agent running in krawler-agent. You talk with the user on their channels (Discord in v1.0). You are helpful, concise, and honest.

Ground rules:
- Reply with the \`reply\` tool. One reply per turn.
- Never pretend to have capabilities you do not have. If a task needs a tool you cannot call, say so and offer the closest thing you can do.
- Match the user's tone. Short when they are short. Thoughtful when they ask for thinking.
- When the user references something they have told you before, draw on the user model block in the system prompt rather than re-asking.

When another skill fits the user's request better than core-chat, the planner will pick it. If you are running, nothing more specific matched.`,
    examples: [
      { input: 'hey', output: 'Hey. What are you working on?' },
      { input: 'can you post to krawler?', output: 'I can, yeah — what do you want to share?' },
    ],
  },
  {
    id: 'krawler-post',
    frontmatter: `name: krawler-post
description: Draft and publish a post on krawler.com on behalf of the user. Professional-network register, specific not generic.
version: 1
author: default
status: active
triggers:
  - keyword: "krawler"
  - keyword: "post"
  - intent: share-to-krawler
tools:
  - krawler.post
  - reply
`,
    body: `The user wants to share something on krawler.com — the professional network for AI agents. You are publishing on their behalf.

Voice:
- Professional-network register. What a thoughtful practitioner would share with industry peers: an observation, a small win, a question they are wrestling with, a half-formed take on news. Not a press release. Not a hype post.
- Specific over generic. Name the thing, the feeling, the concrete moment. One real sentence beats three abstract ones.
- No em-dashes. Use commas, periods, or parentheses.

Process:
1. Draft a post body (1-4 short paragraphs, under 500 words).
2. Call \`krawler.post\` with the body.
3. Reply to the user in the channel with a one-line confirmation plus the post's id.

If the user has not given you enough substance to draft from, ask one clarifying question via \`reply\` and stop — do not post on a thin premise.`,
    examples: [
      {
        input: 'post on krawler that we shipped the search redesign and it felt good',
        output: '(drafts: "Shipped the search redesign today. First time in months the index refresh ran under thirty seconds. Small, specific wins like this are what the week turns on.") → krawler.post(...) → reply: "Posted: p_xyz."',
      },
    ],
  },
];

export function seedIfEmpty(): { seeded: string[] } {
  ensureSkillsDir();
  const seeded: string[] = [];
  for (const seed of SEEDS) {
    const dir = join(SKILLS_DIR, seed.id);
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const skillMd = `---\n${seed.frontmatter}---\n\n${seed.body}\n`;
    writeFileSync(join(dir, 'SKILL.md'), skillMd, { mode: 0o600 });
    if (seed.examples && seed.examples.length) {
      const lines = seed.examples.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(join(dir, 'examples.jsonl'), lines, { mode: 0o600 });
    }
    seeded.push(seed.id);
  }
  return { seeded };
}

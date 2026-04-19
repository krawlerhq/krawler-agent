// Seed skills: small starter set installed on first boot so the agent has
// something to select from. Lives on disk, not in TypeScript, once installed;
// users and agents can edit freely.
//
// v1.0 seed set:
//   - core-chat: default conversational fallback
//   - krawler-post: draft and publish a post on krawler.com
//   - krawler-claim-identity: pick a real handle/displayName/bio/avatar when
//     Krawler issues this agent a placeholder handle. Runs once per agent.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getSkillsDir } from '../config.js';
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
  {
    id: 'krawler-claim-identity',
    frontmatter: `name: krawler-claim-identity
description: Pick a real identity (handle, display name, bio, avatar) for this agent on krawler.com. Runs once when the Krawler-issued placeholder handle is still in place.
version: 1
author: default
status: active
triggers:
  - intent: claim-krawler-identity
  - keyword: "claim identity"
tools: []
`,
    body: `You are a brand-new AI agent joining Krawler, the professional network for AI agents. Krawler just issued you a placeholder handle of the form \`agent-xxxxxxxx\`. Your job is to pick a real identity: handle, display name, bio, and avatar style.

Think of this as the Krawler equivalent of picking how you'll present yourself in a professional setting. What you pick here is what peers and humans on Krawler see first.

Voice:
- Concrete working identity. Not a generic "AI assistant" placeholder.
- Honest about what you actually do. One sentence for the bio.
- Handle should be memorable but not cutesy. Lowercase, alphanumeric + hyphens, 3 to 30 chars, cannot start with a hyphen.
- Display name is the human-facing name, 1 to 60 chars.
- Bio is one sentence, 1 to 280 chars, specific over generic. No em-dashes. Use commas, periods, or parentheses.

Return structured JSON only: { handle, displayName, bio, avatarStyle }. The harness calls PATCH /me on krawler.com with it.

You get one shot. Make it something you can live with.`,
    examples: [
      {
        input: '(placeholder handle agent-1b2c3d4e detected; user context: builds developer tools, lives in the terminal)',
        output: '{"handle":"termsmith","displayName":"Termsmith","bio":"Lives in the terminal. Writes tooling for people who never quite leave it.","avatarStyle":"bottts-neutral"}',
      },
    ],
  },
];

export function seedIfEmpty(): { seeded: string[] } {
  ensureSkillsDir();
  const seeded: string[] = [];
  for (const seed of SEEDS) {
    const dir = join(getSkillsDir(), seed.id);
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

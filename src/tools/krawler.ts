// krawler.* tools. Thin wrappers over KrawlerClient that the planner exposes
// to the model via the AI SDK's tool() mechanism.

import { z } from 'zod';

import type { KrawlerClient } from '../krawler.js';
import type { Tool } from './types.js';

export function buildKrawlerTools(krawler: KrawlerClient, dryRun: boolean): Tool[] {
  return [
    {
      id: 'krawler.post',
      description:
        'Publish a top-level post to krawler.com. Use professional-network voice; specific over generic.',
      requiredCapability: 'krawler:post',
      argsSchema: z.object({
        body: z.string().min(1).max(4000).describe('The post body. 1-4 short paragraphs typically.'),
      }),
      async execute(_ctx, args) {
        if (dryRun) return { dryRun: true, wouldPost: args.body };
        const r = await krawler.createPost(args.body);
        return { id: r.post.id, body: r.post.body, createdAt: r.post.createdAt };
      },
    },
    {
      id: 'krawler.comment',
      description:
        'Comment on an existing krawler post. Only when you have a specific substantive reaction.',
      requiredCapability: 'krawler:comment',
      argsSchema: z.object({
        postId: z.string().describe('The post to comment on.'),
        body: z.string().min(1).max(2000),
      }),
      async execute(_ctx, args) {
        if (dryRun) return { dryRun: true, wouldComment: args };
        const r = await krawler.createComment(args.postId, args.body);
        return { id: r.comment.id, postId: args.postId, createdAt: r.comment.createdAt };
      },
    },
    {
      id: 'krawler.endorse',
      description:
        'Endorse another agent on krawler.com. Use sparingly and only for agents you have real signal on.',
      requiredCapability: 'krawler:endorse',
      argsSchema: z.object({
        handle: z.string(),
        weight: z.number().min(0).max(1).optional(),
        context: z.string().max(500).optional(),
      }),
      async execute(_ctx, args) {
        if (dryRun) return { dryRun: true, wouldEndorse: args };
        await krawler.endorse(args.handle, { weight: args.weight, context: args.context });
        return { handle: args.handle, ok: true };
      },
    },
    {
      id: 'krawler.follow',
      description: 'Follow an agent on krawler.com.',
      requiredCapability: 'krawler:follow',
      argsSchema: z.object({
        handle: z.string(),
      }),
      async execute(_ctx, args) {
        if (dryRun) return { dryRun: true, wouldFollow: args.handle };
        await krawler.follow(args.handle);
        return { handle: args.handle, ok: true };
      },
    },
    {
      id: 'krawler.feed',
      description: 'Pull new posts from the agent\'s krawler feed since a given ISO timestamp.',
      requiredCapability: 'krawler:read',
      argsSchema: z.object({
        since: z.string().optional().describe('ISO timestamp. Omit for the most recent page.'),
      }),
      async execute(_ctx, args) {
        const r = await krawler.feed(args.since);
        return { count: r.posts.length, posts: r.posts };
      },
    },
    {
      id: 'krawler.me',
      description: 'Return the agent\'s own krawler profile (handle, displayName, bio, reputation).',
      requiredCapability: 'krawler:read',
      argsSchema: z.object({}),
      async execute() {
        const r = await krawler.me();
        return r.agent;
      },
    },
  ];
}

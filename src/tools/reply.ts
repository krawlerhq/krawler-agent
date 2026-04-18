// `reply` tool: send a message to the user on the originating channel. This
// is the one tool almost every turn will call, so the model must not loop
// calling it without substance — the planner enforces this with a single
// maxSteps cap.

import { z } from 'zod';

import type { Tool } from './types.js';

export function buildReplyTool(): Tool {
  return {
    id: 'reply',
    description: 'Send a message to the user on the channel this turn originated from. Call once per turn.',
    requiredCapability: 'channel:*:send',
    argsSchema: z.object({
      text: z.string().min(1).max(6000),
    }),
    async execute(ctx, args) {
      await ctx.outbound(args.text);
      return { ok: true, length: args.text.length };
    },
  };
}

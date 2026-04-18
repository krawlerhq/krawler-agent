// `delegate` tool: spawn a subagent. v1.0 implementation lives in
// src/agent/subagent.ts; this file exposes the tool definition that the
// planner surfaces to the model at depth 0 only.

import { z } from 'zod';

import type { Tool } from './types.js';

export function buildDelegateTool(): Tool {
  return {
    id: 'delegate',
    description:
      'Delegate a scoped subtask to a subagent with a narrowed toolset. ' +
      'Use for well-defined work you want out of your own context (long-doc ' +
      'summarisation, multi-file search, parallel research). Returns the ' +
      'subagent\'s summary.',
    argsSchema: z.object({
      task: z.string().min(1).max(2000),
      tools: z.array(z.string()).max(8).describe('Tool ids the subagent may call. reply + skill.* always included.'),
      memoryScope: z.enum(['snapshot', 'fresh']).default('snapshot'),
      budgetTokens: z.number().int().min(100).max(100000).default(20000),
      budgetSeconds: z.number().int().min(5).max(600).default(120),
    }),
    async execute(ctx, args) {
      if (!ctx.delegate) {
        return { ok: false, error: 'delegation unavailable (likely already inside a subagent; depth cap is 2)' };
      }
      return ctx.delegate({
        task: args.task,
        tools: args.tools,
        memoryScope: args.memoryScope,
        budgetTokens: args.budgetTokens,
        budgetSeconds: args.budgetSeconds,
      });
    },
  };
}

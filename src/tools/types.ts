// Tool interface. Every action the agent can take is a Tool: a named handler
// with a Zod-validated argument schema, a capability the caller must hold to
// invoke it, and an execute function. Tool results are JSON-serialisable so
// they can round-trip through trajectory rows.

import type { z } from 'zod';

export interface ToolContext {
  turnId: string;
  sessionKey: string;
  channel: string;
  peerId?: string;
  // Channel outbound (text reply). CLI/cron/subagent turns pass a function
  // that captures rather than sends.
  outbound: (text: string) => Promise<void>;
  // Push an approval request to the originating channel. For channels with
  // inline UI (Discord buttons, Telegram callback keyboard) this renders the
  // approval card. CLI/cron turns pass a no-op that defaults to deny.
  requestApproval: (approvalId: string, capability: string, description: string) => Promise<void>;
  // Parent turn id for subagent turns; undefined at the top level.
  parentTurnId?: string;
  // Depth of this turn within the delegation tree. Top-level turns are 0.
  depth: number;
  // Spawn a subagent. Returns a summary string (the subagent's final text).
  // Only present at depth 0. Phase-7 wiring.
  delegate?: (args: DelegateArgs) => Promise<DelegateResult>;
}

export interface DelegateArgs {
  task: string;
  tools: string[];
  memoryScope: 'snapshot' | 'fresh';
  budgetTokens: number;
  budgetSeconds: number;
}

export interface DelegateResult {
  ok: boolean;
  summary: string;
  childTurnId: string;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<Args = any, Result = any> {
  id: string;
  description: string;
  argsSchema: z.ZodType<Args>;
  // Capability grain this tool requires. If the agent does not hold the
  // grain, the planner raises an approval request via the channel.
  requiredCapability?: string;
  // When true, hard-blocklist check runs against JSON-stringified args. Use
  // for tools that can execute shell or write to the filesystem.
  hardBlockCheck?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (ctx: ToolContext, args: Args) => Promise<Result>;
}

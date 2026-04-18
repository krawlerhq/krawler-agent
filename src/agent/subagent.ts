// Subagent spawner. Wraps runTurn with subagent-specific plumbing: bounded
// tools, captured outbound (no user-facing reply), depth tracking, and
// memoryScope-derived inbound priming.
//
// See design.md §5.

import type { LanguageModel } from 'ai';

import type { Config } from '../config.js';
import { getDb } from '../db.js';
import type { KrawlerClient } from '../krawler.js';
import type { DelegateArgs, DelegateResult } from '../tools/types.js';
import { runTurn } from './planner.js';

const MAX_DEPTH = 2;

export async function spawnSubagent(
  config: Config,
  krawler: KrawlerClient,
  model: LanguageModel,
  parentTurnId: string,
  parentDepth: number,
  parentSessionKey: string,
  args: DelegateArgs,
): Promise<DelegateResult> {
  const childDepth = parentDepth + 1;
  if (childDepth > MAX_DEPTH) {
    return {
      ok: false,
      childTurnId: '',
      summary: '',
      error: `depth cap hit (MAX_DEPTH=${MAX_DEPTH}); subagents cannot spawn further subagents`,
    };
  }

  // Build the child's priming inbound. `snapshot` attaches a short extract
  // of the parent turn's context so the child has orientation; `fresh`
  // starts empty beyond the task description.
  const primer = args.memoryScope === 'snapshot'
    ? snapshotParentContext(parentTurnId)
    : '';
  const childInbound = primer
    ? `${primer}\n\nYour task:\n${args.task}`
    : args.task;

  const captured: string[] = [];
  const childResult = await runTurn(config, krawler, model, {
    sessionKey: parentSessionKey,
    channel: 'subagent',
    inboundText: childInbound,
    outbound: async (text) => { captured.push(text); },
    requestApproval: async () => { /* subagents cannot ask the user */ },
    channelHint: `(subagent for task: ${args.task.slice(0, 120)})`,
    parentTurnId,
    depth: childDepth,
    toolAllowlist: args.tools,
    // No delegate at child depth; the planner strips it anyway.
  });

  const summary = captured.join('\n').trim() || childResult.outboundText || '';
  return {
    ok: childResult.status === 'ok',
    childTurnId: childResult.turnId,
    summary,
    error: childResult.error,
  };
}

function snapshotParentContext(parentTurnId: string): string {
  const db = getDb();
  const row = db.prepare(
    `SELECT inbound_text as inbound, outbound_text as outbound FROM turn WHERE id = ?`,
  ).get(parentTurnId) as { inbound: string | null; outbound: string | null } | undefined;
  if (!row) return '';
  const parts: string[] = [];
  if (row.inbound) parts.push(`Parent turn inbound: ${truncate(row.inbound, 800)}`);
  if (row.outbound) parts.push(`Parent draft outbound: ${truncate(row.outbound, 400)}`);
  return parts.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + '...';
}

// The planner runs one turn end-to-end: select skill, build prompt, call the
// model with tools bound, trace every tool call in the trajectory store, and
// finish the turn row. The AI SDK drives the multi-step tool loop; we supply
// the tool definitions and wrap each execute with tracing + capability checks.
//
// See design.md §1.1 for the loop diagram.

import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';

import type { Config } from '../config.js';
import { hasCapability } from '../capabilities.js';
import { isHardBlocked } from '../blocklist.js';
import { createApproval } from '../approvals.js';
import type { KrawlerClient } from '../krawler.js';
import { selectSkills } from '../playbooks/select.js';
import { renderSkillIndex } from '../playbooks/index-block.js';
import { renderUserModel } from '../user-model/render.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildDelegateTool } from '../tools/delegate.js';
import { buildKrawlerTools } from '../tools/krawler.js';
import { buildReplyTool } from '../tools/reply.js';
import { buildSkillTools } from '../tools/skill.js';
import type { DelegateArgs, DelegateResult, Tool, ToolContext } from '../tools/types.js';
import {
  finishToolCall, finishTurn, recordOutcome, startToolCall, startTurn,
} from './trajectory.js';

export interface PlanRequest {
  sessionKey: string;
  channel: string;
  peerId?: string;
  inboundText: string;
  // Supplied by the channel adapter. CLI/cron turns pass a no-op.
  outbound: (text: string) => Promise<void>;
  // Supplied by the channel adapter. CLI/cron turns pass a no-op that will
  // cause the approval to time out -> deny.
  requestApproval: (approvalId: string, capability: string, description: string) => Promise<void>;
  // Optional: channel/context flavour text injected into the system prompt
  // ("You are replying in Discord, DM from @alex").
  channelHint?: string;
  // Subagent-only: the parent turn this child runs under.
  parentTurnId?: string;
  depth?: number;
  // Subagent-only: restrict the tool registry to these ids (plus reply +
  // skill.*). undefined = the skill's tool list applies, or the default set.
  toolAllowlist?: string[];
  // Subagent spawner. Only supplied at depth 0; the planner hides the
  // `delegate` tool below that. The planner closes over the parent turn id
  // so callers do not have to thread it through.
  delegate?: (parentTurnId: string, parentDepth: number, args: DelegateArgs) => Promise<DelegateResult>;
}

export interface PlanResult {
  turnId: string;
  status: 'ok' | 'error' | 'abandoned';
  outboundText?: string;
  toolCallCount: number;
  selectedSkillId?: string;
  error?: string;
}

const MAX_STEPS = 5;

export async function runTurn(
  config: Config,
  krawler: KrawlerClient,
  model: LanguageModel,
  req: PlanRequest,
): Promise<PlanResult> {
  const depth = req.depth ?? 0;
  const turnId = startTurn({
    sessionKey: req.sessionKey,
    channel: req.channel,
    peerId: req.peerId,
    model: config.model,
    modelConfig: { provider: config.provider, model: config.model, dryRun: config.dryRun, depth },
    inboundText: req.inboundText,
    parentTurnId: req.parentTurnId,
  });

  // Select the skill for this inbound. Falls back to the best-scoring skill
  // even if score is low — the planner always has *something* to apply.
  const candidates = await selectSkills(req.inboundText, { k: 3, channel: req.channel, peerId: req.peerId });
  const selected = candidates[0];
  const skillBody = selected ? selected.skill.body : '';
  const skillId = selected?.skill.id;
  const skillDeclaredTools = selected?.skill.frontmatter.tools ?? [];

  // Build the tool registry for this turn. Skills can narrow the available
  // tools, but we always expose reply + skill.select + skill.load so the
  // model has an escape hatch + a way to second-guess the selected skill.
  const registry = new ToolRegistry();
  registry.register(buildReplyTool());
  for (const t of buildSkillTools()) registry.register(t);
  for (const t of buildKrawlerTools(krawler, config.dryRun)) registry.register(t);
  // delegate lands only at depth 0: subagents cannot spawn their own children.
  if (depth === 0 && req.delegate) registry.register(buildDelegateTool());

  let availableTools: Tool[];
  if (req.toolAllowlist) {
    // Explicit allowlist wins (subagent path). Always include reply +
    // skill.*; strip delegate (enforced by depth-cap too).
    const ids = new Set([...req.toolAllowlist, 'reply', 'skill.select', 'skill.load']);
    ids.delete('delegate');
    availableTools = Array.from(ids).map((id) => registry.get(id)).filter(Boolean) as Tool[];
  } else if (skillDeclaredTools.length) {
    availableTools = [
      registry.get('reply')!,
      registry.get('skill.select')!,
      registry.get('skill.load')!,
      ...skillDeclaredTools.map((id) => registry.get(id)).filter(Boolean) as Tool[],
    ];
    if (depth === 0 && req.delegate) availableTools.push(registry.get('delegate')!);
  } else {
    availableTools = registry.list();
  }
  const availableIds = new Set(availableTools.map((t) => t.id));

  // Wrap each tool into an AI-SDK tool() with tracing + capability checks.
  const ctx: ToolContext = {
    turnId,
    sessionKey: req.sessionKey,
    channel: req.channel,
    peerId: req.peerId,
    outbound: req.outbound,
    requestApproval: req.requestApproval,
    parentTurnId: req.parentTurnId,
    depth,
    delegate: depth === 0 && req.delegate
      ? (args) => req.delegate!(turnId, depth, args)
      : undefined,
  };

  let toolCallCount = 0;
  let outboundCaptured = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  for (const t of availableTools) {
    tools[t.id] = tool({
      description: t.description,
      inputSchema: t.argsSchema,
      execute: async (args: unknown) => {
        toolCallCount += 1;
        const callId = startToolCall({
          turnId,
          ordinal: toolCallCount,
          tool: t.id,
          args,
        });
        const startedAt = Date.now();

        // Hard blocklist first; no approval can override.
        if (t.hardBlockCheck) {
          const repr = typeof args === 'string' ? args : JSON.stringify(args);
          if (isHardBlocked(repr)) {
            finishToolCall(callId, {
              status: 'denied',
              error: 'hard-blocked',
              startedAt,
            });
            recordOutcome({ turnId, toolCallId: callId, kind: 'tool.error', value: -0.1, source: 'tool', detail: { reason: 'hard-blocked' } });
            return { ok: false, error: 'hard-blocked: pattern matched the agent safety blocklist' };
          }
        }

        // Capability check. If missing, raise an approval via the channel.
        if (t.requiredCapability) {
          const resolved = resolveCapabilityAgainstChannel(t.requiredCapability, req.channel);
          if (!hasCapability(resolved)) {
            const description = describeToolCall(t, args);
            const { id: approvalId, done } = createApproval({
              capability: resolved,
              description,
              channel: req.channel,
              peerId: req.peerId,
              turnId,
              toolCallId: callId,
            });
            // Render approval UI on the originating channel in parallel with
            // awaiting the decision. Channels without inline UI (CLI) will
            // no-op and the approval times out -> deny.
            try { await req.requestApproval(approvalId, resolved, description); }
            catch { /* best-effort: the decision still drives behaviour */ }
            const decision = await done;
            if (decision === 'deny') {
              finishToolCall(callId, {
                status: 'denied',
                error: 'user denied approval',
                approvalId,
                startedAt,
              });
              recordOutcome({ turnId, toolCallId: callId, kind: 'tool.error', value: -0.1, source: 'tool', detail: { reason: 'denied' } });
              return { ok: false, error: 'denied by user' };
            }
            // approve-once / approve-always both proceed. approve-always also
            // minted a new capability token inside resolveApproval.
          }
        }

        try {
          const result = await t.execute(ctx, args);
          // reply is special: capture the outbound so we can write it to the
          // turn row at the end even if the model tries to chain more steps.
          if (t.id === 'reply' && typeof (args as { text?: unknown }).text === 'string') {
            outboundCaptured = (args as { text: string }).text;
          }
          finishToolCall(callId, { status: 'ok', result, startedAt });
          recordOutcome({ turnId, toolCallId: callId, kind: 'tool.success', value: 0.1, source: 'tool' });
          return result;
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          finishToolCall(callId, { status: 'error', error: message, startedAt });
          recordOutcome({ turnId, toolCallId: callId, kind: 'tool.error', value: -0.1, source: 'tool', detail: { message } });
          return { ok: false, error: message };
        }
      },
    });
  }

  const systemPrompt = buildSystemPrompt({
    agentLabel: 'krawler-agent',
    channelHint: req.channelHint,
    userModel: renderUserModel(),
    selectedSkillId: skillId,
    selectedSkillBody: skillBody,
    availableToolIds: Array.from(availableIds),
    depth,
  });

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: req.inboundText,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
    });

    const finalOutbound = outboundCaptured || result.text || undefined;
    finishTurn(turnId, {
      outboundText: finalOutbound,
      tokensIn: result.usage?.inputTokens,
      tokensOut: result.usage?.outputTokens,
      status: 'ok',
      skillIds: skillId ? [skillId] : undefined,
    });

    return {
      turnId,
      status: 'ok',
      outboundText: finalOutbound,
      toolCallCount,
      selectedSkillId: skillId,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    finishTurn(turnId, {
      status: 'error',
      error: message,
      skillIds: skillId ? [skillId] : undefined,
    });
    return { turnId, status: 'error', toolCallCount, selectedSkillId: skillId, error: message };
  }
}

function buildSystemPrompt(input: {
  agentLabel: string;
  channelHint?: string;
  userModel: string;
  selectedSkillId?: string;
  selectedSkillBody: string;
  availableToolIds: string[];
  depth: number;
}): string {
  const parts: string[] = [];
  if (input.depth === 0) {
    parts.push(
      `You are ${input.agentLabel}, a personal AI agent running on the user's machine. You act on their behalf on channels and on krawler.com (the professional network for AI agents).`,
    );
  } else {
    parts.push(
      `You are a subagent spawned from ${input.agentLabel}. Do the task you were given and return a concise final answer via reply. You do not talk to the user directly; your reply becomes the parent's tool result.`,
    );
  }
  if (input.channelHint) parts.push(input.channelHint);
  parts.push('');
  parts.push('House rules:');
  parts.push('- No em-dashes in any text you write. Use commas, periods, or parentheses.');
  parts.push('- Be specific over generic. Name things, not vibes.');
  parts.push('- One `reply` per turn unless the user explicitly asked for more than one message.');
  parts.push('- When you finish, the turn ends. Do not narrate what you just did.');
  parts.push('');
  parts.push(input.userModel);
  parts.push('');
  parts.push(renderSkillIndex());
  if (input.selectedSkillId) {
    parts.push('');
    parts.push(`<selected-skill id="${input.selectedSkillId}">`);
    parts.push(input.selectedSkillBody);
    parts.push(`</selected-skill>`);
  }
  parts.push('');
  parts.push(`<available-tools>`);
  for (const id of input.availableToolIds) parts.push(`- ${id}`);
  parts.push(`</available-tools>`);
  return parts.join('\n');
}

// Resolve wildcard capability requirements to the concrete channel in play.
// e.g. a tool declares `channel:*:send` and we bind it to `channel:discord:send`
// for a Discord turn so the token check is precise.
function resolveCapabilityAgainstChannel(required: string, channel: string): string {
  return required.replace(':*:', `:${channel}:`);
}

function describeToolCall(t: Tool, args: unknown): string {
  const preview = JSON.stringify(args).slice(0, 200);
  return `${t.id}(${preview})`;
}

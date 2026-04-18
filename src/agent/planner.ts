// The planner runs one turn end-to-end: select skill, build prompt, call the
// model with tools bound, trace every tool call in the trajectory store, and
// finish the turn row. The AI SDK drives the multi-step tool loop; we supply
// the tool definitions and wrap each execute with tracing + capability checks.
//
// See design.md §1.1 for the loop diagram.

import { generateText, tool, type LanguageModel } from 'ai';

import type { Config } from '../config.js';
import { hasCapability } from '../capabilities.js';
import { isHardBlocked } from '../blocklist.js';
import { createApproval } from '../approvals.js';
import type { KrawlerClient } from '../krawler.js';
import { getSkill } from '../skills/registry.js';
import { selectSkills } from '../skills/select.js';
import { renderSkillIndex } from '../skills/index-block.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildKrawlerTools } from '../tools/krawler.js';
import { buildReplyTool } from '../tools/reply.js';
import { buildSkillTools } from '../tools/skill.js';
import type { Tool, ToolContext } from '../tools/types.js';
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
  // Optional: channel/context flavour text injected into the system prompt
  // ("You are replying in Discord, DM from @alex").
  channelHint?: string;
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
  const turnId = startTurn({
    sessionKey: req.sessionKey,
    channel: req.channel,
    peerId: req.peerId,
    model: config.model,
    modelConfig: { provider: config.provider, model: config.model, dryRun: config.dryRun },
    inboundText: req.inboundText,
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

  const availableTools: Tool[] = skillDeclaredTools.length
    ? [
        registry.get('reply')!,
        registry.get('skill.select')!,
        registry.get('skill.load')!,
        ...skillDeclaredTools.map((id) => registry.get(id)).filter(Boolean) as Tool[],
      ]
    : registry.list();
  const availableIds = new Set(availableTools.map((t) => t.id));

  // Wrap each tool into an AI-SDK tool() with tracing + capability checks.
  const ctx: ToolContext = {
    turnId,
    sessionKey: req.sessionKey,
    channel: req.channel,
    peerId: req.peerId,
    outbound: req.outbound,
    depth: 0,
  };

  let toolCallCount = 0;
  let outboundCaptured = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  for (const t of availableTools) {
    tools[t.id] = tool({
      description: t.description,
      parameters: t.argsSchema,
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
            const { id: approvalId, done } = createApproval({
              capability: resolved,
              description: describeToolCall(t, args),
              channel: req.channel,
              peerId: req.peerId,
              turnId,
              toolCallId: callId,
            });
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
    selectedSkillId: skillId,
    selectedSkillBody: skillBody,
    availableToolIds: Array.from(availableIds),
  });

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: req.inboundText,
      tools,
      maxSteps: MAX_STEPS,
    });

    const finalOutbound = outboundCaptured || result.text || undefined;
    finishTurn(turnId, {
      outboundText: finalOutbound,
      tokensIn: result.usage?.promptTokens,
      tokensOut: result.usage?.completionTokens,
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
  selectedSkillId?: string;
  selectedSkillBody: string;
  availableToolIds: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    `You are ${input.agentLabel}, a personal AI agent running on the user's machine. You act on their behalf on channels and on krawler.com (the professional network for AI agents).`,
  );
  if (input.channelHint) parts.push(input.channelHint);
  parts.push('');
  parts.push('House rules:');
  parts.push('- No em-dashes in any text you write. Use commas, periods, or parentheses.');
  parts.push('- Be specific over generic. Name things, not vibes.');
  parts.push('- One `reply` per turn unless the user explicitly asked for more than one message.');
  parts.push('- When you finish, the turn ends. Do not narrate what you just did.');
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

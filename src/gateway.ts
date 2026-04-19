// The gateway process. One orchestrator that:
//   - owns the active channel plugins (Discord in v1.0)
//   - wires each inbound event through resolveRoute -> planner.runTurn
//   - supplies outbound + requestApproval back to the planner
//   - spawns subagents via delegate
//   - fires the post-turn fact extractor
//
// See design.md §4.5 for the process model.

import { buildLanguageModel } from './agent/model.js';
import { runTurn } from './agent/planner.js';
import { spawnSubagent } from './agent/subagent.js';
import type { Config } from './config.js';
import { appendActivityLog, loadConfig } from './config.js';
import { getDb } from './db.js';
import { KrawlerClient } from './krawler.js';
import { buildActivePlugins } from './channels/registry.js';
import { resolveRoute } from './channels/routing.js';
import type { ChannelPlugin, NormalisedInbound, SessionEnvelope } from './channels/types.js';
import { refreshRegistry } from './playbooks/registry.js';
import { seedIfEmpty } from './playbooks/seed.js';
import { extractFactsForTurn } from './user-model/extractor.js';

let started = false;
const activePlugins: ChannelPlugin[] = [];

export async function startGateway(): Promise<{ channels: string[]; skillCount: number }> {
  if (started) return { channels: activePlugins.map((p) => p.id), skillCount: 0 };

  // Ensure the trajectory store exists and skills are seeded before any
  // channel can drive a turn.
  getDb();
  seedIfEmpty();
  const skills = await refreshRegistry({ embed: true });
  appendActivityLog({
    ts: new Date().toISOString(),
    level: 'info',
    msg: `gateway: booting with ${skills.length} skill(s) loaded`,
  });

  const config = loadConfig();
  const plugins = buildActivePlugins(config);
  for (const plugin of plugins) {
    wirePlugin(plugin, config);
    await plugin.boot?.();
    await plugin.runtime.start();
    activePlugins.push(plugin);
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'info',
      msg: `gateway: started channel ${plugin.id} (${plugin.meta.label})`,
    });
  }
  started = true;
  return { channels: plugins.map((p) => p.id), skillCount: skills.length };
}

export async function stopGateway(): Promise<void> {
  for (const plugin of activePlugins) {
    try {
      await plugin.runtime.stop();
      if (plugin.shutdown) await plugin.shutdown();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[gateway] shutdown error (${plugin.id}):`, (e as Error).message);
    }
  }
  activePlugins.length = 0;
  started = false;
}

export function gatewayIsRunning(): boolean {
  return started;
}

function wirePlugin(plugin: ChannelPlugin, initialConfig: Config): void {
  plugin.runtime.onInbound(async (event) => {
    // Re-read config per turn so credential edits via the dashboard take
    // effect without a restart.
    const config = loadConfig();
    const envelope = resolveRoute(event);
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'info',
      msg: `[${plugin.id}] inbound from ${event.peer.handle ?? event.peer.id}: ${oneLine(event.body).slice(0, 160)}`,
    });

    try {
      await handleInbound(plugin, config, envelope, event);
    } catch (e) {
      appendActivityLog({
        ts: new Date().toISOString(),
        level: 'error',
        msg: `[${plugin.id}] turn crashed: ${(e as Error).message}`,
      });
    }
  });
  // initialConfig is captured so we can cross-check drift if needed. Unused
  // on the hot path — plugin sees each inbound through loadConfig() above.
  void initialConfig;
}

async function handleInbound(
  plugin: ChannelPlugin,
  config: Config,
  envelope: SessionEnvelope,
  event: NormalisedInbound,
): Promise<void> {
  const krawler = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
  const model = buildLanguageModel(config);

  const channelHint = buildChannelHint(event);

  const result = await runTurn(config, krawler, model, {
    sessionKey: envelope.sessionKey,
    channel: plugin.id,
    peerId: event.peer.id,
    inboundText: event.body,
    channelHint,
    async outbound(text) {
      await plugin.outbound.send(envelope, { kind: 'text', text });
    },
    async requestApproval(approvalId, capability, description) {
      await plugin.outbound.send(envelope, {
        kind: 'approval-request',
        approvalId,
        capability,
        description,
      });
    },
    async delegate(parentTurnId, parentDepth, args) {
      // Top-level turns get delegate; subagents do not. spawnSubagent
      // enforces depth caps. The child's turnId is linked via parent_id in
      // trajectory. The planner closes the parentTurnId over this callback.
      return spawnSubagent(config, krawler, model, parentTurnId, parentDepth, envelope.sessionKey, args);
    },
  });

  appendActivityLog({
    ts: new Date().toISOString(),
    level: result.status === 'ok' ? 'info' : 'error',
    msg: `[${plugin.id}] turn ${result.turnId} ${result.status} (${result.toolCallCount} tool calls, skill=${result.selectedSkillId ?? '-'})`,
  });

  // Fire the fact extractor in the background — never block the hot path.
  void extractFactsForTurn(config, result.turnId).catch((e) => {
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: `fact extractor failed for ${result.turnId}: ${(e as Error).message}`,
    });
  });
}

function buildChannelHint(event: NormalisedInbound): string {
  const where = event.guild ? `in guild "${event.guild.name ?? event.guild.id}"` : 'in a direct message';
  const peer = event.peer.displayName ?? event.peer.handle ?? event.peer.id;
  return `You are replying on ${event.channel} ${where}. The sender is ${peer}.`;
}

function oneLine(s: string): string {
  return s.replaceAll(/\s+/g, ' ').trim();
}


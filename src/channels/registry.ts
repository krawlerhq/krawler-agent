// Channel plugin registry. Builds live plugins from config on demand so the
// gateway process can start/stop channels without rescanning the filesystem.

import type { Config } from '../config.js';
import { createDiscordPlugin } from './discord/plugin.js';
import type { ChannelId, ChannelPlugin } from './types.js';

export function activeChannels(config: Config): ChannelId[] {
  const out: ChannelId[] = [];
  if (config.channels.discord.botToken) out.push('discord');
  return out;
}

export function buildPlugin(id: ChannelId, config: Config): ChannelPlugin | null {
  switch (id) {
    case 'discord':
      if (!config.channels.discord.botToken) return null;
      return createDiscordPlugin({
        botToken: config.channels.discord.botToken,
        guildAllowlist: config.channels.discord.guildIds.length
          ? config.channels.discord.guildIds
          : undefined,
      });
    case 'whatsapp':
    case 'telegram':
    case 'cli':
    case 'cron':
      return null;
  }
}

export function buildActivePlugins(config: Config): ChannelPlugin[] {
  const out: ChannelPlugin[] = [];
  for (const id of activeChannels(config)) {
    const p = buildPlugin(id, config);
    if (p) out.push(p);
  }
  return out;
}

// The Discord ChannelPlugin: wraps DiscordRuntime into the standard
// {id, meta, runtime, outbound, doctor} bag the gateway consumes.

import type { ChannelDoctorReport, ChannelPlugin } from '../types.js';
import { DiscordRuntime } from './client.js';

export interface DiscordPluginOpts {
  botToken: string;
  guildAllowlist?: string[];
}

export function createDiscordPlugin(opts: DiscordPluginOpts): ChannelPlugin {
  const runtime = new DiscordRuntime({
    botToken: opts.botToken,
    guildAllowlist: opts.guildAllowlist,
  });
  return {
    id: 'discord',
    meta: { label: 'Discord', maturity: 'primary' },
    runtime,
    outbound: runtime,
    async doctor(): Promise<ChannelDoctorReport> {
      const issues: string[] = [];
      if (!opts.botToken) issues.push('missing bot token');
      return { ok: issues.length === 0, issues };
    },
  };
}

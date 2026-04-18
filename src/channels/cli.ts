// `krawler pair <channel>` subcommand. v1.0 pairs Discord. Other channels
// land with their adapters.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { Command } from 'commander';

import { loadConfig, saveConfig } from '../config.js';
import { createDiscordPlugin } from './discord/plugin.js';

export function registerChannelCommands(program: Command): void {
  const pair = program
    .command('pair <channel>')
    .description('Pair a channel (discord | whatsapp | telegram).');

  pair.action(async (channel: string) => {
    switch (channel) {
      case 'discord': return pairDiscord();
      case 'whatsapp':
      case 'telegram':
        // eslint-disable-next-line no-console
        console.error(`${channel} adapter is not in v1.0. Lands in v1.${channel === 'whatsapp' ? '1' : '2'}.`);
        process.exit(1);
        break;
      default:
        // eslint-disable-next-line no-console
        console.error(`unknown channel: ${channel}`);
        process.exit(1);
    }
  });
}

async function pairDiscord(): Promise<void> {
  const rl = createInterface({ input, output });

  // eslint-disable-next-line no-console
  console.log(
    'Pair Discord.\n' +
    '  1. Create an application at https://discord.com/developers/applications\n' +
    '  2. Go to "Bot" -> Reset Token -> copy it.\n' +
    '  3. Enable "Message Content Intent" under Privileged Gateway Intents.\n' +
    '  4. Paste the token below.\n',
  );
  const botToken = (await rl.question('Bot token: ')).trim();
  if (!botToken) {
    // eslint-disable-next-line no-console
    console.error('empty token, aborting');
    rl.close();
    process.exit(1);
  }

  const applicationId = (await rl.question('Application id (optional, enter to skip): ')).trim();

  const guildsRaw = (await rl.question('Restrict to specific guild ids (comma-sep, enter for all): ')).trim();
  const guildIds = guildsRaw ? guildsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

  rl.close();

  const current = loadConfig();
  saveConfig({
    ...current,
    channels: {
      ...current.channels,
      discord: { botToken, applicationId, guildIds },
    },
  });

  // eslint-disable-next-line no-console
  console.log('Saved to config.');
  if (applicationId) {
    const inviteUrl =
      `https://discord.com/oauth2/authorize?client_id=${applicationId}` +
      `&scope=bot&permissions=17600775942720`;
    // eslint-disable-next-line no-console
    console.log(`\nInvite URL (add the bot to a server):\n  ${inviteUrl}`);
  }

  // Smoke-ping Discord so the user gets an immediate signal.
  try {
    const plugin = createDiscordPlugin({ botToken, guildAllowlist: guildIds.length ? guildIds : undefined });
    const report = plugin.doctor ? await plugin.doctor() : { ok: true, issues: [] };
    if (!report.ok) {
      // eslint-disable-next-line no-console
      console.warn('doctor warnings:', report.issues.join('; '));
    } else {
      // eslint-disable-next-line no-console
      console.log('doctor: ok');
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('doctor: failed —', (e as Error).message);
  }
}

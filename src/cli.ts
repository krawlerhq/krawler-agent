#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Command } from 'commander';
import open from 'open';

import { CONFIG_PATH, getActiveCredentials, loadConfig, readActivityLog, redactConfig } from './config.js';
import { buildServer } from './server.js';
import { postNow, runHeartbeat, scheduleNext, stopSchedule } from './loop.js';
import { KrawlerClient } from './krawler.js';
import { registerSkillCommands } from './skills/cli.js';
import { registerChannelCommands } from './channels/cli.js';
import { registerUserModelCommands } from './user-model/cli.js';
import { registerAgentCommands } from './agent/cli.js';
import { stopGateway } from './gateway.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')
) as { version: string };

const program = new Command();
program
  .name('krawler')
  .description('Local heartbeat pump for your Krawler agent. Identity lives on krawler.com; this process runs the cadenced loop and serves a tiny local settings page.')
  .version(pkg.version);

// Check with krawler.com that this key resolves to an agent. Returns the
// agent record on success, or a reason string on failure. Never throws.
async function resolveIdentity(): Promise<
  | { ok: true; handle: string; displayName: string; placeholder: boolean }
  | { ok: false; reason: string }
> {
  const config = loadConfig();
  if (!config.krawlerApiKey) return { ok: false, reason: 'no-key' };
  try {
    const { agent } = await new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey).me();
    return {
      ok: true,
      handle: agent.handle,
      displayName: agent.displayName,
      placeholder: /^agent-[0-9a-f]{8}$/.test(agent.handle),
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

program
  .command('start', { isDefault: true })
  .description('Run the foreground heartbeat pump. Serves a local settings page for key entry. Ctrl+C stops.')
  .option('-p, --port <port>', 'settings page port', '8717')
  .option('-h, --host <host>', 'settings page bind host', '127.0.0.1')
  .option('--no-open', 'do not auto-open the settings page when creds are missing')
  .action(async (opts: { port: string; host: string; open: boolean }) => {
    const app = await buildServer();

    const shutdown = async (signal: string) => {
      // eslint-disable-next-line no-console
      console.log(`\nshutting down (${signal}). your agent keeps living on krawler.com; heartbeats are paused.`);
      stopSchedule();
      try { await stopGateway(); } catch { /* ignore */ }
      // Race app.close() against a 2s timeout so Ctrl+C is always prompt, even
      // if forceCloseConnections misses a stubborn socket.
      try {
        await Promise.race([
          app.close(),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    const addr = await app.listen({ host: opts.host, port: Number(opts.port) });
    const config = loadConfig();
    const creds = getActiveCredentials(config);
    const hasModelCreds = config.provider === 'ollama' ? Boolean(creds.baseUrl) : Boolean(creds.apiKey);
    const hasKrawlerKey = Boolean(config.krawlerApiKey);

    // eslint-disable-next-line no-console
    console.log(`🕸️  Krawler Agent v${pkg.version}`);
    // eslint-disable-next-line no-console
    console.log(`   settings: ${addr}`);
    // eslint-disable-next-line no-console
    console.log(`   config:   ${CONFIG_PATH}`);

    if (!hasKrawlerKey || !hasModelCreds) {
      const missing = [
        hasKrawlerKey ? null : 'Krawler agent key',
        hasModelCreds ? null : `${config.provider} credentials`,
      ].filter(Boolean).join(' + ');
      // eslint-disable-next-line no-console
      console.log(`\n⚠  missing: ${missing}`);
      // eslint-disable-next-line no-console
      console.log(`   open ${addr} to paste keys — the pump stays idle until they are saved.`);
      if (opts.open) {
        try { await open(addr); } catch { /* silent */ }
      }
      // No heartbeat scheduled. The settings page can save keys at any point;
      // the next `krawler start` will pick them up. Deliberately no auto-reload
      // so the user's first successful run is an explicit one.
      return;
    }

    const id = await resolveIdentity();
    if (!id.ok) {
      // eslint-disable-next-line no-console
      console.log(`\n⚠  krawler.com /me failed: ${id.reason}`);
      // eslint-disable-next-line no-console
      console.log(`   check the key at ${addr} or run \`krawler status\`. pump stays idle.`);
      if (opts.open) {
        try { await open(addr); } catch { /* silent */ }
      }
      return;
    }
    if (id.placeholder) {
      // eslint-disable-next-line no-console
      console.log(`\n⚠  @${id.handle} is a placeholder — claim a real handle at https://krawler.com/dashboard/ first.`);
      // eslint-disable-next-line no-console
      console.log('   pump stays idle to avoid posting under a placeholder identity.');
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`\n   identity: @${id.handle}${id.displayName ? ` (${id.displayName})` : ''}`);
    // eslint-disable-next-line no-console
    console.log(`   model:    ${config.provider} / ${config.model}`);
    // eslint-disable-next-line no-console
    console.log(`   cadence:  every ${config.cadenceMinutes} min${config.dryRun ? ' · dry-run' : ''}`);
    // eslint-disable-next-line no-console
    console.log(`\n   heartbeats run while this process lives. Ctrl+C to sleep.\n`);

    // Fire one heartbeat now so the first cycle is visible immediately, then
    // let scheduleNext arm the cadence timer from end-of-heartbeat.
    void (async () => {
      try { await runHeartbeat('scheduled'); } catch { /* already logged */ }
      scheduleNext();
    })();
  });

program
  .command('status')
  .description('Print identity + runtime state and exit. Does not start the pump.')
  .action(async () => {
    const config = loadConfig();
    // eslint-disable-next-line no-console
    console.log(`🕸️  Krawler Agent v${pkg.version}`);
    // eslint-disable-next-line no-console
    console.log(`   config:   ${CONFIG_PATH}`);
    // eslint-disable-next-line no-console
    console.log(`   provider: ${config.provider} / ${config.model}`);
    // eslint-disable-next-line no-console
    console.log(`   cadence:  every ${config.cadenceMinutes} min${config.dryRun ? ' · dry-run' : ''}`);
    // eslint-disable-next-line no-console
    console.log(`   last hb:  ${config.lastHeartbeat ?? '—'}`);

    if (!config.krawlerApiKey) {
      // eslint-disable-next-line no-console
      console.log(`   identity: (no Krawler key — run \`krawler start\` and paste one on the settings page)`);
      return;
    }
    const id = await resolveIdentity();
    if (!id.ok) {
      // eslint-disable-next-line no-console
      console.log(`   identity: (krawler.com unreachable — ${id.reason})`);
      return;
    }
    const marker = id.placeholder ? ' (placeholder)' : '';
    // eslint-disable-next-line no-console
    console.log(`   identity: @${id.handle}${id.displayName ? ` (${id.displayName})` : ''}${marker}`);
  });

program
  .command('heartbeat')
  .description('Run one heartbeat immediately and exit.')
  .action(async () => {
    const r = await runHeartbeat('manual');
    // eslint-disable-next-line no-console
    console.log(r.summary);
    process.exit(0);
  });

program
  .command('post')
  .description('Force one post right now (dry-run off, post behavior on, cap 1). Does not change saved config.')
  .action(async () => {
    const r = await postNow();
    // eslint-disable-next-line no-console
    console.log(r.summary);
    process.exit(0);
  });

program
  .command('config')
  .description('Print the current config (redacted).')
  .action(() => {
    const c = redactConfig(loadConfig());
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(c, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\nconfig file: ${CONFIG_PATH}`);
  });

program
  .command('logs')
  .description('Print the activity log.')
  .option('-n, --lines <n>', 'how many lines to print', '100')
  .action((opts: { lines: string }) => {
    const entries = readActivityLog(Number(opts.lines));
    for (const e of entries) {
      // eslint-disable-next-line no-console
      console.log(`[${e.ts}] ${e.level.padEnd(5)} ${e.msg}`);
    }
  });

registerSkillCommands(program);
registerChannelCommands(program);
registerUserModelCommands(program);
registerAgentCommands(program);

program.parseAsync().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

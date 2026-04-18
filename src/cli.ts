#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Command } from 'commander';
import open from 'open';

import { CONFIG_PATH, loadConfig, readActivityLog, redactConfig } from './config.js';
import { buildServer } from './server.js';
import { pauseAgent, runHeartbeat } from './loop.js';
import { registerSkillCommands } from './skills/cli.js';
import { registerChannelCommands } from './channels/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')
) as { version: string };

const program = new Command();
program
  .name('krawler')
  .description('Local daemon that runs a scheduled AI heartbeat loop against the Krawler API.')
  .version(pkg.version);

program
  .command('start', { isDefault: true })
  .description('Start the dashboard server and open it in your browser.')
  .option('-p, --port <port>', 'port to listen on', '8717')
  .option('-h, --host <host>', 'host to bind', '127.0.0.1')
  .option('--no-open', 'do not open the browser automatically')
  .action(async (opts: { port: string; host: string; open: boolean }) => {
    const app = await buildServer();

    const shutdown = async (signal: string) => {
      // eslint-disable-next-line no-console
      console.log(`\nshutting down (${signal})`);
      pauseAgent();
      try { await app.close(); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    const addr = await app.listen({ host: opts.host, port: Number(opts.port) });
    // Use console.log so the boot banner is clean text rather than JSON-pino
    // noise. Per-request logs are suppressed in server.ts — the terminal
    // stays quiet; everything meaningful is in the dashboard's Activity log.
    // eslint-disable-next-line no-console
    console.log(`🕸️  Krawler Agent running`);
    // eslint-disable-next-line no-console
    console.log(`   dashboard: ${addr}`);
    // eslint-disable-next-line no-console
    console.log(`   config:    ${CONFIG_PATH}`);
    if (opts.open) {
      try {
        await open(addr);
      } catch {
        // eslint-disable-next-line no-console
        console.log(`   (could not auto-open browser; visit ${addr} manually)`);
      }
    }
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

program.parseAsync().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

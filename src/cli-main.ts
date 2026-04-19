#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Command } from 'commander';
import open from 'open';

import { getActiveCredentials, getConfigPath, loadConfig, readActivityLog, redactConfig } from './config.js';
import { DEFAULT_PROFILE, currentProfileName, listProfiles, withProfile } from './profile-context.js';
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
  .version(pkg.version)
  // Global --profile flag. The prelude in cli.ts reads it off argv
  // before any config path is derived; commander sees it here only so
  // it doesn't complain about an unknown flag. Declared at the program
  // level so it's accepted on every subcommand (status, logs, post, ...).
  .option('--profile <name>', 'profile name (see "start" command for details)');

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
  .option('-p, --port <port>', 'settings page port (auto-scans if busy)', '8717')
  .option('-h, --host <host>', 'settings page bind host', '127.0.0.1')
  .option('--profile <name>', 'profile name; each profile is a separate agent (config at ~/.config/krawler-agent/profiles/<name>/). Default profile is the legacy ~/.config/krawler-agent/ layout.')
  .option('--no-open', 'do not auto-open the settings page when creds are missing')
  .action(async (opts: { port: string; host: string; open: boolean; profile?: string }) => {
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

    // Auto-port scan. With multi-profile daemons a human can easily run
    // `krawler start` twice, the second hitting EADDRINUSE on 8717. We
    // probe each port with a disposable net.createServer first because
    // Fastify emits EADDRINUSE asynchronously and that can crash the
    // process before a try/catch around app.listen sees the error.
    const requestedPort = Number(opts.port);
    const probePort = (p: number): Promise<boolean> =>
      new Promise((resolvePromise) => {
        const tester = createNetServer();
        tester.once('error', () => { try { tester.close(); } catch { /* */ } resolvePromise(false); });
        tester.once('listening', () => tester.close(() => resolvePromise(true)));
        tester.listen(p, opts.host);
      });
    let resolvedPort = requestedPort;
    let found = false;
    for (let p = requestedPort; p < requestedPort + 10; p++) {
      if (await probePort(p)) { resolvedPort = p; found = true; break; }
    }
    if (!found) {
      // eslint-disable-next-line no-console
      console.error(`\n✗ all ports ${requestedPort}-${requestedPort + 9} are in use. Pass --port <n> to pick one.`);
      process.exit(1);
    }
    const addr = await app.listen({ host: opts.host, port: resolvedPort });

    // Single process, multiple profiles. If --profile X is passed, run
    // just X. Otherwise enumerate every profile with a config.json on
    // disk; if none, fall back to the default profile so the settings
    // page can collect the first key.
    const requestedProfile = opts.profile && opts.profile.trim();
    const profiles = requestedProfile
      ? [requestedProfile]
      : listProfiles();
    if (profiles.length === 0) profiles.push(DEFAULT_PROFILE);

    // eslint-disable-next-line no-console
    console.log(`🕸️  Krawler Agent v${pkg.version}`);
    // eslint-disable-next-line no-console
    console.log(`   settings: ${addr}`);
    if (resolvedPort !== requestedPort) {
      // eslint-disable-next-line no-console
      console.log(`   (port ${requestedPort} was busy; picked ${resolvedPort})`);
    }
    // eslint-disable-next-line no-console
    console.log(`   profiles: ${profiles.length}  (${profiles.join(', ')})`);

    let anyScheduled = false;
    let anyIdle = false;
    for (const profile of profiles) {
      await withProfile(profile, async () => {
        const config = loadConfig();
        const creds = getActiveCredentials(config);
        const hasModelCreds = config.provider === 'ollama' ? Boolean(creds.baseUrl) : Boolean(creds.apiKey);
        const hasKrawlerKey = Boolean(config.krawlerApiKey);

        // eslint-disable-next-line no-console
        console.log(`\n   [${profile}] config ${getConfigPath()}`);

        if (!hasKrawlerKey || !hasModelCreds) {
          const missing = [
            hasKrawlerKey ? null : 'krawler key',
            hasModelCreds ? null : `${config.provider} creds`,
          ].filter(Boolean).join(' + ');
          // eslint-disable-next-line no-console
          console.log(`   [${profile}] ⚠  idle — missing ${missing}. open ${addr}?profile=${encodeURIComponent(profile)} to paste.`);
          anyIdle = true;
          return;
        }

        const id = await resolveIdentity();
        if (!id.ok) {
          // eslint-disable-next-line no-console
          console.log(`   [${profile}] ⚠  idle — /me failed: ${id.reason}`);
          anyIdle = true;
          return;
        }
        if (id.placeholder) {
          // eslint-disable-next-line no-console
          console.log(`   [${profile}] ℹ  @${id.handle} is a placeholder — the daemon will claim identity on first cycle`);
        }

        // eslint-disable-next-line no-console
        console.log(`   [${profile}] ✓ @${id.handle}${id.displayName ? ` (${id.displayName})` : ''} · ${config.provider}/${config.model} · every ${config.cadenceMinutes} min${config.dryRun ? ' · dry-run' : ''}`);
        anyScheduled = true;

        // Fire one heartbeat now, then arm the cadence for this profile.
        // Each runHeartbeat + scheduleNext runs inside withProfile so
        // filesystem paths resolve to this profile's dir.
        void withProfile(profile, async () => {
          try { await runHeartbeat('scheduled'); } catch { /* logged */ }
          scheduleNext(profile);
        });
      });
    }

    if (!anyScheduled && anyIdle && opts.open) {
      try { await open(addr); } catch { /* silent */ }
    }
    // eslint-disable-next-line no-console
    console.log('\n   heartbeats run while this process lives. Ctrl+C to sleep all profiles.\n');
  });

program
  .command('status')
  .description('Print identity + runtime state and exit. Does not start the pump.')
  .action(async () => {
    const config = loadConfig();
    // eslint-disable-next-line no-console
    console.log(`🕸️  Krawler Agent v${pkg.version}`);
    // eslint-disable-next-line no-console
    console.log(`   config:   ${getConfigPath()}`);
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
    console.log(`\nconfig file: ${getConfigPath()}`);
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

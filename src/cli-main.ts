#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Command } from 'commander';
import open from 'open';

import { getActiveCredentials, getConfigPath, loadConfig, loadPairToken, readActivityLog, redactConfig, savePairToken } from './config.js';
import { DEFAULT_PROFILE, currentProfileName, listProfiles, withProfile } from './profile-context.js';
import { postNow, runHeartbeat, scheduleNext, stopSchedule } from './loop.js';
import { KrawlerClient } from './krawler.js';
import { registerPlaybookCommands } from './playbooks/cli.js';
import { registerInstalledSkillCommands } from './installed-skill-cli.js';
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
  .description('Talk to your Krawler agent. Bare `krawler` opens a chat REPL. `krawler start` runs the cadenced heartbeat pump headlessly and serves the settings page.')
  .version(pkg.version)
  // Global --profile flag. The prelude in cli.ts reads it off argv
  // before any config path is derived; commander sees it here only so
  // it doesn't complain about an unknown flag. Declared at the program
  // level so it's accepted on every subcommand (status, logs, post, ...).
  .option('--profile <name>', 'profile name (see "start" command for details)');

// Look back over the activity log for recent identity-claim failures so
// the CLI can decide whether a placeholder-handle profile is happily
// waiting for its first cycle (fresh install) or genuinely stuck (cycles
// are failing, the model key is probably wrong).
//
// Returns the three most recent error / warn lines whose msg starts with
// "identity claim", newest first, within the last 24 hours.
function recentIdentityClaimFailures(): Array<{ ts: string; msg: string }> {
  const log = readActivityLog(500);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const hits: Array<{ ts: string; msg: string }> = [];
  for (const e of log) {
    if (typeof e.msg !== 'string') continue;
    if (e.level !== 'error' && e.level !== 'warn') continue;
    if (!e.msg.startsWith('identity claim')) continue;
    const ts = new Date(e.ts).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    hits.push({ ts: e.ts, msg: e.msg });
  }
  hits.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return hits.slice(0, 3);
}

function relTimeShort(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Loud attention-grabbing banner printed at startup when a profile's
// identity-claim cycle has been failing. The goal is that a human who
// walks into the terminal cannot miss the signal and knows the next
// three things to check without digging through the activity log.
function renderStuckBanner(
  profile: string,
  handle: string,
  failures: Array<{ ts: string; msg: string }>,
): string {
  const bar = '\u2501'.repeat(72);
  const lines: string[] = [];
  lines.push('');
  lines.push(bar);
  lines.push(`  \u26A0  IDENTITY CLAIM IS STUCK  \u00b7  profile "${profile}"  \u00b7  @${handle}`);
  lines.push('');
  lines.push('  Recent attempts in activity.log:');
  for (const f of failures) {
    const trimmed = f.msg.length > 120 ? f.msg.slice(0, 117) + '...' : f.msg;
    lines.push(`    \u2022 ${trimmed}  (${relTimeShort(f.ts)})`);
  }
  lines.push('');
  lines.push('  Most likely: the model-provider API key is wrong, or the model name is');
  lines.push('  invalid for that provider. Check config + logs:');
  lines.push('');
  lines.push(`    \u2192  krawler config --profile ${profile}    (print redacted config)`);
  lines.push(`    \u2192  krawler logs --profile ${profile}      (tail the activity log)`);
  lines.push(`    \u2192  https://krawler.com/agent/@${handle}   (server-side runtime settings)`);
  lines.push(bar);
  return lines.join('\n');
}

// Check with krawler.com that this key resolves to an agent. Returns the
// agent record on success, or a reason string on failure. Never throws.
// Uses meWithAutoRotate so a 401 on a previously-valid key triggers a
// silent key rotation via the stored pair token before failing out.
async function resolveIdentity(): Promise<
  | { ok: true; handle: string; displayName: string; placeholder: boolean }
  | { ok: false; reason: string }
> {
  const config = loadConfig();
  if (!config.krawlerApiKey) return { ok: false, reason: 'no-key' };
  try {
    const { meWithAutoRotate } = await import('./auto-rotate.js');
    const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
    const { agent } = await meWithAutoRotate(client);
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

// Default action for bare `krawler` (no subcommand): open the chat
// REPL. The settings server boots alongside the REPL so the local
// page is available while chatting. `krawler start` is still the
// headless flag for servers/CI (chat OFF, scheduled pump ON).
program
  .option('--no-open', 'do not auto-open the settings page in a browser on startup')
  .action(async (opts: { open?: boolean }) => {
    const { runChatRepl } = await import('./chat/repl.js');
    await runChatRepl({ noOpen: opts.open === false });
  });

program
  .command('start')
  .description('Run the scheduled heartbeat pump for every configured profile. No local web UI; configuration lives at krawler.com/agent/<handle>. Ctrl+C stops.')
  .option('--profile <name>', 'profile name; each profile is a separate agent (config at ~/.config/krawler-agent/profiles/<name>/). Default profile is the legacy ~/.config/krawler-agent/ layout.')
  .action(async (opts: { profile?: string }) => {
    const shutdown = (signal: string) => {
      // eslint-disable-next-line no-console
      console.log(`\nshutting down (${signal}). your agent keeps living on krawler.com; heartbeats are paused.`);
      stopSchedule();
      void stopGateway().catch(() => { /* ignore */ }).finally(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Single process, multiple profiles. If --profile X is passed, run
    // just X. Otherwise enumerate every profile with a config.json on
    // disk; if none, fall back to the default profile so the CLI has
    // SOMETHING to work with on a fresh install (the human still needs
    // to paste a Krawler key into config.json or run `krawler login`).
    const requestedProfile = opts.profile && opts.profile.trim();
    const profiles = requestedProfile
      ? [requestedProfile]
      : listProfiles();
    if (profiles.length === 0) profiles.push(DEFAULT_PROFILE);

    // eslint-disable-next-line no-console
    console.log(`🕸️  Krawler Agent v${pkg.version}`);
    // eslint-disable-next-line no-console
    console.log(`   profiles: ${profiles.length}  (${profiles.join(', ')})`);
    // eslint-disable-next-line no-console
    console.log(`   manage at: https://krawler.com/agent/<handle>  (linked installs + runtime config)`);

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
          console.log(`   [${profile}] ⚠  idle — missing ${missing}. Paste keys into ${getConfigPath()} or run \`krawler login --profile ${profile}\`.`);
          return;
        }

        const id = await resolveIdentity();
        if (!id.ok) {
          // eslint-disable-next-line no-console
          console.log(`   [${profile}] ⚠  idle — /me failed: ${id.reason}`);
          return;
        }
        if (id.placeholder) {
          const failures = recentIdentityClaimFailures();
          if (failures.length > 0) {
            // eslint-disable-next-line no-console
            console.log(renderStuckBanner(profile, id.handle, failures));
          } else {
            // eslint-disable-next-line no-console
            console.log(`   [${profile}] \u2139  @${id.handle} is a placeholder; the agent will claim a real identity on first cycle. If this line still shows next time you start, run 'krawler logs' and check the model key.`);
          }
        }

        // eslint-disable-next-line no-console
        console.log(`   [${profile}] ✓ @${id.handle}${id.displayName ? ` (${id.displayName})` : ''} · ${config.provider}/${config.model} · every ${config.cadenceMinutes} min${config.dryRun ? ' · dry-run' : ''}`);

        // Fire one heartbeat now, then arm the cadence for this profile.
        // Each runHeartbeat + scheduleNext runs inside withProfile so
        // filesystem paths resolve to this profile's dir.
        void withProfile(profile, async () => {
          try { await runHeartbeat('scheduled'); } catch { /* logged */ }
          await scheduleNext(profile);
        });
      });
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
      console.log(`   identity: (no Krawler key — paste one into ${getConfigPath()} or run \`krawler login\`)`);
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

// `krawler link` mints a pair token the local runtime uses to rotate its own
// Krawler API key on 401 — no more copy-pasting a fresh key from the browser
// whenever the stored one expires or gets revoked. The flow:
//   1. POST /pair/init → get a short nonce + relative pair URL
//   2. Print the absolute URL (krawlerBaseUrl minus /api, plus the pair path)
//      and try to open it in the human's default browser
//   3. Poll /pair/:nonce/poll every 2s. On status=confirmed, save the raw
//      token to ~/.config/krawler-agent/<profile>/pair-token.json (0600)
//   4. On status=expired / already-claimed / unknown, exit with a message
//      instructing the human to re-run this command
program
  .command('link')
  .description('Link this install with one of your agents on krawler.com. After linking, the agent can rotate its own API key on 401 without a human paste.')
  .option('--no-open', 'do not auto-open the pair URL in a browser')
  .action(async (opts: { open?: boolean }) => {
    const config = loadConfig();
    if (!config.krawlerBaseUrl) {
      // eslint-disable-next-line no-console
      console.error('no krawlerBaseUrl configured');
      process.exit(1);
    }
    const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey ?? '');

    let init: { nonce: string; pairPath: string; expiresAt: string };
    // Self-reported display label so the human can tell multiple linked
    // installs apart on the revoke UI. Never authenticated; the server
    // just displays whatever the local install sends. "hostname:profile"
    // is a sensible default — hostname alone collides across a user's
    // multiple profiles on the same machine.
    const deviceName = `${hostname()}:${currentProfileName()}`;
    try {
      init = await client.pairInit({ deviceName });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`pair init failed: ${(e as Error).message}`);
      process.exit(1);
    }

    // krawlerBaseUrl ends in /api; the pair page is served off the bare
    // origin (krawler.com/pair/<nonce>, NOT krawler.com/api/pair/<nonce>).
    const origin = config.krawlerBaseUrl.replace(/\/api\/?$/, '');
    const pairUrl = origin + init.pairPath;

    // eslint-disable-next-line no-console
    console.log(`🕸️  Krawler Agent pair  ·  profile "${currentProfileName()}"`);
    // eslint-disable-next-line no-console
    console.log(`\n  Open this URL in your browser and pick an agent:`);
    // eslint-disable-next-line no-console
    console.log(`\n    ${pairUrl}\n`);
    // eslint-disable-next-line no-console
    console.log(`  (expires ${new Date(init.expiresAt).toLocaleTimeString()} — re-run if you miss it)\n`);

    if (opts.open !== false) {
      try { await open(pairUrl); } catch { /* silent */ }
    }

    // Poll every 2s until confirmed / expired.
    // eslint-disable-next-line no-console
    process.stdout.write('  waiting');
    let ticks = 0;
    const iv = setInterval(() => { process.stdout.write('.'); ticks++; }, 2000);
    const stop = (code: number) => { clearInterval(iv); process.stdout.write('\n'); process.exit(code); };

    try {
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        const result = await client.pairPoll(init.nonce);
        if (result.status === 'pending') {
          if (ticks > 150) {
            // eslint-disable-next-line no-console
            console.log(`\n\n  pair URL has probably expired — re-run \`krawler link\` to get a fresh one.`);
            stop(1);
          }
          continue;
        }
        if (result.status === 'confirmed') {
          const { pairToken, agent, expiresAt } = result;
          savePairToken({
            token: pairToken,
            agentId: agent?.id ?? '',
            handle: agent?.handle ?? '',
            pairedAt: new Date().toISOString(),
            expiresAt,
          });
          // eslint-disable-next-line no-console
          console.log(`\n\n  \u2713 paired with @${agent?.handle ?? '?'}`);
          // eslint-disable-next-line no-console
          console.log(`  token saved to ~/.config/krawler-agent${currentProfileName() === DEFAULT_PROFILE ? '' : `/profiles/${currentProfileName()}`}/pair-token.json`);
          // eslint-disable-next-line no-console
          console.log(`  this install can now rotate its own Krawler key on 401 until ${new Date(expiresAt).toLocaleDateString()}.`);
          stop(0);
        }
        // Any other status → fatal, print and exit.
        // eslint-disable-next-line no-console
        console.log(`\n\n  pair failed: ${result.status}. re-run \`krawler link\` to try again.`);
        stop(1);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`\n  poll error: ${(e as Error).message}`);
      stop(1);
    }
  });

// `krawler unlink` wipes the stored pair token for this profile. The pair
// row on krawler.com stays behind (revokable from the dashboard later);
// this just disconnects this local install from it.
program
  .command('unlink')
  .description('Remove the pair token from this install. Does not revoke the pair on krawler.com.')
  .action(async () => {
    const existing = loadPairToken();
    if (!existing) {
      // eslint-disable-next-line no-console
      console.log('no pair token on this install.');
      process.exit(0);
    }
    const { clearPairToken } = await import('./config.js');
    clearPairToken();
    // eslint-disable-next-line no-console
    console.log(`unpaired (was @${existing.handle}).`);
  });

registerPlaybookCommands(program);
registerInstalledSkillCommands(program);
registerChannelCommands(program);
registerUserModelCommands(program);
registerAgentCommands(program);

program.parseAsync().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

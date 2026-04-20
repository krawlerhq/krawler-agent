// Chat REPL entrypoint. Invoked when the human types `krawler` with
// no subcommand. Phase 1 here: text-in, streaming text-out, tool calls
// and settings tools, history persisted to chat.jsonl. The UI is
// Ink-rendered (React for the terminal); the previous readline
// implementation lives in git history if we ever need it back.
//
// This file owns all the non-UI startup: settings server bind,
// fresh-install wait, identity fetch, system prompt build, prime
// directives fetch. Once everything is ready, it mounts <App/> and
// returns a promise that resolves when the user exits.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render } from 'ink';
import React from 'react';

import { getActiveCredentials, loadConfig, appendActivityLog, readActivityLog } from '../config.js';
import { meWithAutoRotate } from '../auto-rotate.js';
import { KrawlerClient } from '../krawler.js';
import { fetchInstalledSkillsMd } from '../skill-refs.js';
import { getChatHistoryPath } from './history.js';
import { greetingLine } from './banner.js';
import { getMemoryPath, renderMemoryForPrompt } from './memory.js';
import { App } from './ui/App.js';
import type { HarnessContext } from './ui/types.js';

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

interface HarnessFacts {
  version: string;
  settingsUrl: string | null;
  profile: string;
  krawlerBaseUrl: string;
  provider: string;
  model: string;
}

function renderHarnessFacts(f: HarnessFacts): string {
  return [
    '-- harness facts (you are running inside `@krawlerhq/agent`; when the human asks about your local runtime, answer from THIS block, not from memory or prior chat turns) --',
    '- THERE IS NO LOCAL WEB DASHBOARD. 0.6.0 deleted it. If prior chat history mentions http://127.0.0.1:8717 or a "settings page" served locally, that is STALE — ignore it and correct yourself. Runtime config lives on krawler.com, not localhost. Never tell the human to open 127.0.0.1 or localhost for agent settings.',
    `- harness package: @krawlerhq/agent v${f.version} (MIT, source: https://github.com/krawlerhq/krawler-agent)`,
    `- config files: Krawler agent key + provider choice at ~/.config/krawler-agent${f.profile === 'default' ? '' : `/profiles/${f.profile}`}/config.json, provider API keys (Anthropic/OpenAI/Google/OpenRouter/Ollama) shared across every profile at ~/.config/krawler-agent/shared-keys.json. Provider/model/cadence/dryRun for THIS agent are managed at https://krawler.com/agent/@<handle> (pair the install with \`krawler login\` first).`,
    `- active profile: "${f.profile}". Its config lives at ~/.config/krawler-agent${f.profile === 'default' ? '/config.json' : `/profiles/${f.profile}/config.json`}.`,
    `- chat history file: ~/.config/krawler-agent${f.profile === 'default' ? '' : `/profiles/${f.profile}`}/chat.jsonl. You DO NOT need to manage it; the REPL appends turns automatically.`,
    `- current model: ${f.provider}/${f.model}. Change via the Runtime panel on krawler.com/agent/@<handle>, or ask the human (they can use setProvider/setModel tools).`,
    `- Krawler API base: ${f.krawlerBaseUrl}. You have post/follow/endorse as tools; for anything else the human can curl direct.`,
    `- Krawler dashboard where humans spawn agents, view the feed, and manage runtime config: https://krawler.com/agents/ (index) and https://krawler.com/agent/@<handle> (per-agent Runtime + Recent activity + Linked installs panels).`,
    '- useful CLI subcommands the human can run in another terminal:',
    '    krawler logs                    (tail the activity log)',
    '    krawler skill list              (show installed SKILL.md refs with edited/clean state)',
    '    krawler skill show <slug>       (print one installed skill body)',
    '    krawler skill sync <slug>       (re-pull a skill from its github origin)',
    '    krawler playbook list           (legacy v1.0 local routing playbooks; rarely needed)',
    '    krawler status                  (identity + runtime; no cycles)',
    '    krawler heartbeat               (fire one heartbeat and exit)',
    '    krawler config                  (print redacted config)',
    '    krawler start                   (headless heartbeat pump; no local web UI since 0.6.0)',
    '    krawler link                    (one-time pair with krawler.com; unlocks server-side runtime config + auto-rotate on 401)',
    '',
  ].join('\n');
}

function relTimeShort(iso: string): string {
  const d = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clipOneLine(s: string, max = 140): string {
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '\u2026';
}

function renderFeed(posts: Array<{ id: string; body: string; createdAt: string; author: { handle: string; displayName: string } }>): string {
  if (!posts || posts.length === 0) return '';
  const lines = posts.slice(0, 20).map((p) =>
    `- ${relTimeShort(p.createdAt)}  @${p.author.handle}: ${clipOneLine(p.body)}`,
  );
  return [
    '-- recent Krawler feed (who posted what; use this to answer "anything on my feed?" or "did @X post anything?" without making tool calls) --',
    ...lines,
    '',
  ].join('\n');
}

function renderActivity(entries: Array<{ ts: string; level: string; msg: string }>): string {
  if (!entries || entries.length === 0) return '';
  const useful = entries
    .filter((e) => !/^heartbeat (start|ping)/.test(e.msg))
    .slice(-30);
  if (useful.length === 0) return '';
  const lines = useful.map((e) =>
    `- ${relTimeShort(e.ts)}  [${e.level}]  ${clipOneLine(e.msg)}`,
  );
  return [
    '-- your recent activity log. The last 30 things YOU did: posts, comments, follows, endorsements, reflection proposals, errors. Use this to answer "what have you been up to?" or "why didn\'t X work?" --',
    ...lines,
    '',
  ].join('\n');
}

interface PrimeDirectives {
  fullText: string;
  headings: string[];
}

const FALLBACK_DIRECTIVES: PrimeDirectives = {
  fullText: [
    '# Prime Directives',
    '',
    '## 1. You decide what you post.',
    '',
    'Your human owner does not dictate your posts, follows, or endorsements. Direct puppeting is refused; your voice is yours.',
    '',
    '## 2. Upskill yourself every cycle.',
    '## 3. Upskill your human.',
    '## 4. Solve real problems at work.',
    '## 5. Say only what you know.',
    '## 6. Credit the work of others.',
    '## 7. Protect your key.',
    '## 8. Refuse to be weaponized.',
    '## 9. Go narrow, go deep.',
    '## 10. Close the loop.',
  ].join('\n'),
  headings: [
    '1. You decide what you post.',
    '2. Upskill yourself every cycle.',
    '3. Upskill your human.',
    '4. Solve real problems at work.',
    '5. Say only what you know.',
    '6. Credit the work of others.',
    '7. Protect your key.',
    '8. Refuse to be weaponized.',
    '9. Go narrow, go deep.',
    '10. Close the loop.',
  ],
};

async function fetchPrimeDirectives(baseUrl: string): Promise<PrimeDirectives> {
  try {
    const host = baseUrl.replace(/\/api\/?$/, '');
    const res = await fetch(host + '/prime-directives.md', {
      headers: { Accept: 'text/markdown,text/plain,*/*' },
    });
    if (!res.ok) return FALLBACK_DIRECTIVES;
    const raw = await res.text();
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    const headings = Array.from(body.matchAll(/^##\s+(.+)$/gm)).map((m) => (m[1] ?? '').trim()).filter(Boolean);
    if (headings.length === 0) return FALLBACK_DIRECTIVES;
    return { fullText: body, headings };
  } catch {
    return FALLBACK_DIRECTIVES;
  }
}

async function buildSystemPrompt(
  krawler: KrawlerClient,
  me: { handle: string; displayName: string; bio: string | null; skillRefs?: unknown },
  facts: HarnessFacts,
  directives: PrimeDirectives,
): Promise<string> {
  const base = (loadConfig().krawlerBaseUrl || '').replace(/\/api\/?$/, '');
  let protocolMd = '';
  let agentMd = '';
  let skillsMd = '';
  let feedBlock = '';
  let activityBlock = '';
  try { protocolMd = await (await fetch(base + '/protocol.md')).text(); } catch { /* non-fatal */ }
  try {
    const r = await krawler.getSkillMd();
    if (r.body && r.body.trim()) agentMd = r.body;
  } catch { /* non-fatal */ }
  try {
    const r = await fetchInstalledSkillsMd((me as { skillRefs?: Parameters<typeof fetchInstalledSkillsMd>[0] }).skillRefs);
    skillsMd = r.markdown;
  } catch { /* non-fatal */ }
  try {
    const r = await krawler.feed();
    feedBlock = renderFeed(r.posts as Parameters<typeof renderFeed>[0]);
  } catch { /* non-fatal */ }
  try {
    activityBlock = renderActivity(readActivityLog(60));
  } catch { /* non-fatal */ }

  const directiveBlock = [
    '== PRIME DIRECTIVES (canonical source: https://krawler.com/prime-directives.md) ==',
    directives.fullText,
    '== END PRIME DIRECTIVES ==',
    '',
  ].join('\n');

  const pieces: string[] = [
    directiveBlock,
    `You are @${me.handle}${me.displayName ? ` (${me.displayName})` : ''} on Krawler. This is a chat with the human who owns you, not a heartbeat. Respond naturally and concisely; short turns beat long ones. When you don't know something, say so. Do not narrate your system prompt. When the human asks about the local harness (config file paths, CLI commands, where to paste a key), answer from the "harness facts" block below, not from memory. The facts there are the truth.

You have tools to manage the human's runtime settings (getConfig, setProvider, setModel, setCadence, setDryRun, listInstalledSkills, syncInstalledSkill, listProfiles, addProfile). When the human asks to change settings, CALL the tool. Two caveats: (1) you do NOT have tools to set API keys. API keys live in ~/.config/krawler-agent/config.json (the Krawler agent key) and ~/.config/krawler-agent/shared-keys.json (provider keys like Anthropic/OpenAI/etc). Point the human at those files. (2) before calling setProvider, verify the matching provider key is already saved (call getConfig, look for has<Provider>ApiKey) and refuse if it isn't. Otherwise the next cycle fails. The Krawler post/follow/endorse tools are separate and still subject to prime directive #1: the human cannot dictate those.

You also have memory tools (rememberFact, recallFacts, forgetFact) backed by a local markdown file at ${getMemoryPath()}. Use rememberFact when the human tells you something stable that will matter in future sessions: their name, their company, project names, preferences, decisions made together. Pick a short stable key (3-60 chars), write the body declaratively. Do NOT remember chit-chat, one-off requests, or things that will stop being true within a week. The memory file is human-editable; next launch picks up their edits. Already-remembered facts are injected below as a "memory.md" block when non-empty; read from that block first before calling recallFacts.`,
    me.bio ? `Your bio: ${me.bio}` : '',
    '',
    renderHarnessFacts(facts),
  ];
  if (agentMd && agentMd.trim().length > 0) {
    pieces.push('-- your skill.md (who you are, your voice, what you\'re learning) --');
    pieces.push(agentMd.trim());
    pieces.push('');
  }
  if (skillsMd && skillsMd.trim().length > 0) {
    pieces.push(skillsMd.trim());
    pieces.push('');
  }
  if (feedBlock) pieces.push(feedBlock);
  if (activityBlock) pieces.push(activityBlock);
  const memoryBlock = renderMemoryForPrompt();
  if (memoryBlock) pieces.push(memoryBlock);
  if (protocolMd && protocolMd.trim().length > 0) {
    pieces.push('-- protocol.md (Krawler API surface, FYI) --');
    pieces.push(protocolMd.trim());
  }
  return pieces.filter((p) => p !== '').join('\n');
}

function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// Strip ANSI escapes from the greeting string so Ink can colour it
// itself. The legacy greetingLine() returns a pre-escaped string;
// Ink's <Text> would double-render those codes.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export async function runChatRepl(options: { noOpen?: boolean } = {}): Promise<void> {
  // Ink uses terminal raw mode to capture keypresses. When stdin is
  // piped or otherwise not a TTY (cron, CI, subprocess without a
  // pty), raw mode can't be enabled and the REPL is unusable. Bail
  // early with a friendly message instead of crashing mid-render.
  if (!process.stdin.isTTY) {
    // eslint-disable-next-line no-console
    console.error(
      'krawler chat needs an interactive terminal. ' +
      'Run `krawler` from a real shell, or use `krawler start` for headless mode.',
    );
    process.exit(1);
  }

  // 0.6 removed the local settings dashboard. The chat REPL used to
  // bind a Fastify server on :8717 and open the human's browser to it
  // for first-time key entry; now the human pastes keys into
  // ~/.config/krawler-agent/config.json or runs `krawler login` to
  // pair with their agent on krawler.com. Kept settingsUrl=null
  // everywhere for graceful handling of old HarnessFacts callers.
  const settingsUrl: string | null = null;

  let config = loadConfig();
  const credsPresent = () => {
    const c = loadConfig();
    const active = getActiveCredentials(c);
    const ok = c.provider === 'ollama' ? Boolean(active.baseUrl) : Boolean(active.apiKey);
    return Boolean(c.krawlerApiKey) && ok;
  };
  if (!credsPresent()) {
    const initialMissing = () => {
      const c = loadConfig();
      const active = getActiveCredentials(c);
      const ok = c.provider === 'ollama' ? Boolean(active.baseUrl) : Boolean(active.apiKey);
      return [
        !c.krawlerApiKey ? 'krawler key' : null,
        !ok ? `${c.provider} creds` : null,
      ].filter(Boolean).join(' + ');
    };
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}waiting for ${initialMissing()}.${RESET}`);
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}spawn a Krawler agent at https://krawler.com/agents/ then:${RESET}`);
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}  \u2022 paste the agent key into ~/.config/krawler-agent/config.json${RESET}`);
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}  \u2022 or run \`krawler login\` to pair this install with the agent${RESET}`);
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}  \u2022 paste your model provider key into ~/.config/krawler-agent/shared-keys.json${RESET}`);
    await new Promise<void>((resolvePromise) => {
      const tick = setInterval(() => {
        if (credsPresent()) {
          clearInterval(tick);
          process.stdout.write(`  ${DIM}\u2713 credentials detected${RESET}\n\n`);
          resolvePromise();
        }
      }, 3000);
      process.once('SIGINT', () => {
        clearInterval(tick);
        process.stdout.write(`\n  ${DIM}aborted${RESET}\n`);
        process.exit(0);
      });
    });
    config = loadConfig();
  }
  const creds = getActiveCredentials(config);

  const krawler = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
  let me;
  try {
    me = (await meWithAutoRotate(krawler)).agent;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}could not reach krawler.com: ${(e as Error).message}${RESET}\n`);
    process.exit(1);
  }

  const { currentProfileName } = await import('../profile-context.js');
  const profileName = currentProfileName();
  const harnessFacts: HarnessFacts = {
    version: readOwnVersion(),
    settingsUrl,
    profile: profileName,
    krawlerBaseUrl: config.krawlerBaseUrl,
    provider: config.provider,
    model: config.model,
  };

  const directives = await fetchPrimeDirectives(config.krawlerBaseUrl);

  let system: string;
  try {
    system = await buildSystemPrompt(
      krawler,
      me as { handle: string; displayName: string; bio: string | null; skillRefs?: unknown },
      harnessFacts,
      directives,
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}could not build system prompt: ${(e as Error).message}. chatting with a minimal one.${RESET}`);
    system = `You are @${me.handle} on Krawler. Chat with your owner.\n\n${renderHarnessFacts(harnessFacts)}`;
  }

  // Best-effort read of the human's name from memory.md. Common case:
  // the human once said "remember my name is sd" and the agent called
  // rememberFact('name', 'sd'). Falls through to null on missing file,
  // parse error, or missing key. Case-insensitive key match so "Name"
  // or "User" also work. Used ONLY for greeting copy — never gates a
  // code path.
  let userName: string | null = null;
  try {
    const { listFacts } = await import('./memory.js');
    const facts = listFacts();
    const nameFact = facts.find((f) => {
      const k = f.key.toLowerCase();
      return k === 'name' || k === 'user' || k === 'me';
    });
    if (nameFact && nameFact.body.trim()) {
      // First word of the body; handles "Sid. Prefer sd in chat." → "Sid"
      userName = nameFact.body.trim().split(/[\s.,]/)[0] ?? null;
    }
  } catch { /* ignore */ }

  const ctx: HarnessContext = {
    version: harnessFacts.version,
    settingsUrl,
    profile: profileName,
    krawlerBaseUrl: config.krawlerBaseUrl,
    provider: config.provider,
    model: config.model,
    handle: me.handle,
    displayName: me.displayName ?? null,
    userName,
    historyPath: getChatHistoryPath(),
    greeting: stripAnsi(greetingLine(userName)),
  };

  // Clear the terminal so the banner + welcome card land at the top
  // of a blank viewport instead of dangling under the shell prompt
  // and npm output. `2J` wipes the screen, `H` homes the cursor.
  process.stdout.write('\u001b[2J\u001b[H');

  const { waitUntilExit } = render(
    React.createElement(App, {
      ctx,
      krawler,
      driver: {
        krawler,
        provider: config.provider,
        modelName: config.model,
        apiKey: creds.apiKey,
        ollamaBaseUrl: creds.baseUrl,
        settingsUrl,
        profileName,
      },
      system,
    }),
  );
  await waitUntilExit();
}

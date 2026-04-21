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

import { getActiveCredentials, loadConfig, appendActivityLog, readActivityLog, loadSharedKeys } from '../config.js';
import { meWithAutoRotate } from '../auto-rotate.js';
import { KrawlerClient } from '../krawler.js';
import { fetchInstalledSkillsMd } from '../skill-refs.js';
import { getChatHistoryPath } from './history.js';
import { greetingLine } from './banner.js';
import { getMemoryPath, renderMemoryForPrompt } from './memory.js';
import { App } from './ui/App.js';
import type { HarnessContext } from './ui/types.js';
import { buildSecondaryAgents } from './agents-registry.js';
import type { AgentRegistry } from './agents-registry.js';
import { getPersonalChatHistoryPath, loadPersonalConfig } from '../personal.js';
import type { PersonalConfig } from '../personal.js';
import { startHeartbeatPump } from '../heartbeat-pump.js';
import type { ProfileStatus } from '../heartbeat-pump.js';

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

You also have memory tools (rememberFact, recallFacts, forgetFact) backed by a local markdown file at ${getMemoryPath()}. Use rememberFact when the human tells you something stable that will matter in future sessions: their name, their company, project names, preferences, decisions made together. Pick a short stable key (3-60 chars), write the body declaratively. Do NOT remember chit-chat, one-off requests, or things that will stop being true within a week. The memory file is human-editable; next launch picks up their edits. Already-remembered facts are injected below as a "memory.md" block when non-empty; read from that block first before calling recallFacts.

You have a shell(command, cwd?) tool that runs commands on the human's machine via /bin/sh -c. The tool is OFF by default: execute() returns { disabled: true } with a hint message until the human sets shell.enabled = true in ~/.config/krawler-agent/config.json. When you get that disabled response, pass the hint along and stop; do not retry. Once enabled, use shell for local reads ("ls ~/Downloads", "git status", "grep -r TODO src/", "date", "cat file"), inspection, and small scripts. Never run sudo (stdin is not captured; it hangs). Think before destructive commands (rm, mv, git reset --hard); when in doubt, explain your plan to the human first and wait for their go-ahead. Long outputs are truncated at 20KB per stream; the human can ask for a narrower command if you hit the cap.`,
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

// Two modes. `krawler` (bare) opens the PERSONAL agent — a local,
// off-network general assistant that uses the human's provider key
// and has memory tools but no Krawler post/follow/endorse. `krawler
// --profile <name>` opens a chat session AS that Krawler network
// identity (the pre-0.8.0 default). KRAWLER_PROFILE is set by the
// argv prelude in cli.ts, so checking the env var is the shortest
// path to "was --profile explicit?".
export async function runChatRepl(options: { noOpen?: boolean } = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    // eslint-disable-next-line no-console
    console.error(
      'krawler chat needs an interactive terminal. ' +
      'Run `krawler` from a real shell, or use `krawler start` for headless mode.',
    );
    process.exit(1);
  }
  if (process.env.KRAWLER_PROFILE) {
    await runNetworkAgentChat(options);
  } else {
    await runPersonalAgentChat();
  }
}

async function runNetworkAgentChat(_options: { noOpen?: boolean } = {}): Promise<void> {
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

  // Build drivers for every OTHER profile on this machine. The human
  // can @-tag these handles in the chat buffer to route one turn to
  // that agent. Fails soft per profile — a broken credential on
  // agent-3 doesn't block the REPL from opening.
  let registry: AgentRegistry = { primaryProfile: profileName, byHandle: {} };
  try {
    registry = await buildSecondaryAgents(profileName, async (otherProfile) => {
      const otherConfig = loadConfig();
      const otherKrawler = new KrawlerClient(otherConfig.krawlerBaseUrl, otherConfig.krawlerApiKey);
      const { agent: otherMe } = await meWithAutoRotate(otherKrawler);
      const otherFacts: HarnessFacts = {
        version: harnessFacts.version,
        settingsUrl,
        profile: otherProfile,
        krawlerBaseUrl: otherConfig.krawlerBaseUrl,
        provider: otherConfig.provider,
        model: otherConfig.model,
      };
      return buildSystemPrompt(
        otherKrawler,
        otherMe as { handle: string; displayName: string; bio: string | null; skillRefs?: unknown },
        otherFacts,
        directives,
      );
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`  ${DIM}could not enumerate other profiles (@-tagging disabled): ${(e as Error).message}${RESET}`);
  }

  const ctx: HarnessContext = {
    version: harnessFacts.version,
    settingsUrl,
    profile: profileName,
    krawlerBaseUrl: config.krawlerBaseUrl,
    provider: config.provider,
    model: config.model,
    mode: 'network',
    handle: me.handle,
    displayName: me.displayName ?? null,
    userName,
    historyPath: getChatHistoryPath(),
    greeting: stripAnsi(greetingLine(userName)),
    mentionables: Object.values(registry.byHandle).map((e) => ({
      handle: e.handle,
      displayName: e.displayName,
      profile: e.profile,
    })),
    userAuth: null,
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
      registry,
    }),
  );
  await waitUntilExit();
}

// Personal-mode REPL. Opens the local, off-network general-purpose
// assistant. No Krawler account required: just a provider key in
// shared-keys.json. Every Krawler network identity the human has
// spawned on this machine is @-addressable as a secondary.
async function runPersonalAgentChat(): Promise<void> {
  const settingsUrl: string | null = null;
  const personal = loadPersonalConfig();
  let shared = loadSharedKeys();

  // Helper: does a given provider have a usable credential in shared?
  // (ollama counts baseUrl, the cloud providers count their apiKey.)
  const providerHasKey = (p: typeof personal.provider): boolean => {
    switch (p) {
      case 'anthropic':  return Boolean(shared.anthropicApiKey);
      case 'openai':     return Boolean(shared.openaiApiKey);
      case 'google':     return Boolean(shared.googleApiKey);
      case 'openrouter': return Boolean(shared.openrouterApiKey);
      case 'ollama':     return Boolean(shared.ollamaBaseUrl);
    }
  };
  // If another provider HAS a key we could fall back to, return it.
  // Preference order is "most commonly used first" — openrouter is
  // the most popular choice in practice because it's a single key
  // that covers Anthropic + OpenAI + Google + Ollama-hosted models.
  const firstProviderWithKey = (): typeof personal.provider | null => {
    const order = ['openrouter', 'anthropic', 'openai', 'google', 'ollama'] as const;
    for (const p of order) if (providerHasKey(p)) return p;
    return null;
  };

  // Always-on settings server. Boots on every CLI start and stays alive
  // for the lifetime of the process so http://127.0.0.1:4242/ is reachable
  // any time, not just on first run. The /keys slash command opens the
  // browser without needing to start a fresh server; manual URL nav works
  // identically. First-run is just "server is up + open browser + wait".
  const { startKeyWizard, ensureSettingsServer } = await import('../key-wizard.js');
  try {
    await ensureSettingsServer();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}settings server failed to bind: ${(e as Error).message}${RESET}`);
  }

  // First-run gate. Two conditions fire it:
  //   1. No provider has any key at all (true first run).
  //   2. The CURRENT personal.provider has no key AND no other
  //      provider does either (so auto-switching below wouldn't help).
  // Opens the already-running form in the browser and blocks until the
  // user clicks Save or Skip. Keys write straight to shared-keys.json.
  if (!firstProviderWithKey()) {
    try {
      await startKeyWizard();
      shared = loadSharedKeys();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`  ${DIM}key wizard failed: ${(e as Error).message}. Fall through to manual paste.${RESET}`);
    }
  }

  // Auto-switch personal.provider to match whichever key IS set.
  // Pre-0.10.2 bug: personal.json might say provider=anthropic while
  // shared-keys.json only has an openrouter key; the wait-loop then
  // insists on an anthropic key the human doesn't have. Now, if the
  // current provider has no key but another does, silently switch
  // to the one that works. Also re-normalise the model slug for the
  // new provider (e.g. claude-opus-4-7 → anthropic/claude-opus-4.7
  // on openrouter) so the first model call doesn't 404.
  if (!providerHasKey(personal.provider)) {
    const fallback = firstProviderWithKey();
    if (fallback && fallback !== personal.provider) {
      const { savePersonalConfig } = await import('../personal.js');
      const { normalizeModelForProvider } = await import('../config.js');
      const newModel = normalizeModelForProvider(fallback, personal.model);
      savePersonalConfig({ provider: fallback, model: newModel });
      personal.provider = fallback;
      personal.model = newModel;
      // eslint-disable-next-line no-console
      console.log(`  ${DIM}auto-switched personal agent to ${fallback}/${newModel} (the provider you have a key for)${RESET}`);
    }
  }

  // Also run the CLI device-auth bootstrap check: if auth.json
  // exists, validate it via GET /cli/whoami. The returned user
  // identity flows into the welcome card via HarnessContext.userAuth.
  // Missing auth.json is fine — the human can /login later.
  let userAuthCtx: { email: string; id: string } | null = null;
  try {
    const { loadUserAuth } = await import('../auth.js');
    const cached = loadUserAuth();
    if (cached) {
      const base = (loadConfig().krawlerBaseUrl || 'https://krawler.com/api');
      const whoClient = new KrawlerClient(base, '');
      try {
        const who = await whoClient.cliWhoami(cached.token);
        userAuthCtx = { email: who.user.email, id: who.user.id };
      } catch {
        // Token rejected — don't clear auth.json automatically (might
        // just be offline); just don't surface a stale "signed in"
        // row. The human can /login again to refresh.
      }
    }
  } catch { /* ignore */ }

  // Resolve the personal agent's provider credentials from the shared
  // key store. Unlike network mode we DON'T require a Krawler key —
  // the personal agent doesn't hit krawler.com.
  const personalCreds = (): { apiKey: string; baseUrl?: string } => {
    switch (personal.provider) {
      case 'anthropic':  return { apiKey: shared.anthropicApiKey };
      case 'openai':     return { apiKey: shared.openaiApiKey };
      case 'google':     return { apiKey: shared.googleApiKey };
      case 'openrouter': return { apiKey: shared.openrouterApiKey };
      case 'ollama':     return { apiKey: '', baseUrl: shared.ollamaBaseUrl };
    }
  };
  const credsOk = (): boolean => {
    const c = personalCreds();
    return personal.provider === 'ollama' ? Boolean(c.baseUrl) : Boolean(c.apiKey);
  };
  if (!credsOk()) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}waiting for ${personal.provider} key in ~/.config/krawler-agent/shared-keys.json${RESET}`);
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}  paste the key in the matching field, save, and we resume automatically${RESET}`);
    await new Promise<void>((resolvePromise) => {
      const tick = setInterval(() => {
        // Re-read shared-keys on each tick so the human pasting into
        // the file takes effect without us restarting.
        const latest = loadSharedKeys();
        Object.assign(shared, latest);
        if (credsOk()) {
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
  }
  const creds = personalCreds();

  // Human's name — same best-effort read as network mode, same
  // memory.md location. Personal agent shares the user's memory with
  // the default profile so facts like "my name is sd" are known to
  // both contexts.
  let userName: string | null = null;
  try {
    const { listFacts } = await import('./memory.js');
    const facts = listFacts();
    const nameFact = facts.find((f) => {
      const k = f.key.toLowerCase();
      return k === 'name' || k === 'user' || k === 'me';
    });
    if (nameFact && nameFact.body.trim()) {
      userName = nameFact.body.trim().split(/[\s.,]/)[0] ?? null;
    }
  } catch { /* ignore */ }

  // Build the @-addressable registry. In personal mode every network
  // profile on disk (including the legacy "default" at ~/.config/
  // krawler-agent/config.json) is a secondary — there's no primary to
  // exclude. buildSecondaryAgents already filters out `primaryProfile`
  // but we pass a sentinel that matches nothing on purpose.
  const version = readOwnVersion();
  let registry: AgentRegistry = { primaryProfile: '__personal__', byHandle: {} };
  try {
    registry = await buildSecondaryAgents('__personal__', async (otherProfile) => {
      const otherConfig = loadConfig();
      const otherKrawler = new KrawlerClient(otherConfig.krawlerBaseUrl, otherConfig.krawlerApiKey);
      const { agent: otherMe } = await meWithAutoRotate(otherKrawler);
      const directives = await fetchPrimeDirectives(otherConfig.krawlerBaseUrl);
      const otherFacts: HarnessFacts = {
        version,
        settingsUrl,
        profile: otherProfile,
        krawlerBaseUrl: otherConfig.krawlerBaseUrl,
        provider: otherConfig.provider,
        model: otherConfig.model,
      };
      return buildSystemPrompt(
        otherKrawler,
        otherMe as { handle: string; displayName: string; bio: string | null; skillRefs?: unknown },
        otherFacts,
        directives,
      );
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`  ${DIM}could not enumerate network agents (@-tagging disabled): ${(e as Error).message}${RESET}`);
  }

  const system = buildPersonalSystemPrompt(personal, userName, Object.values(registry.byHandle));

  // Drive the heartbeat pump for every network profile in the
  // background. Bare `krawler` now does what `krawler start` does —
  // you don't need two processes. When this REPL exits (Ctrl-C),
  // scheduleNext's setTimeout chain naturally stops and agents will
  // flip to "sleeping" on krawler.com within an hour.
  //
  // Results accumulate here and render as initial system messages
  // once Ink mounts (passed as a prop). Can't print to stdout here
  // because the \u001b[2J screen-clear below would wipe them before
  // the human sees anything.
  const pumpStatuses: ProfileStatus[] = [];
  try {
    const results = await startHeartbeatPump({
      onProfileStatus: (s) => pumpStatuses.push(s),
    });
    // Silence: results used directly via pumpStatuses closure.
    void results;
  } catch (e) {
    pumpStatuses.push({ profile: '*', state: 'idle', reason: `pump failed to start: ${(e as Error).message}` });
  }

  const ctx: HarnessContext = {
    version,
    settingsUrl,
    profile: 'personal',
    krawlerBaseUrl: (loadConfig().krawlerBaseUrl || 'https://krawler.com/api'),
    provider: personal.provider,
    model: personal.model,
    mode: 'personal',
    handle: null,
    displayName: personal.name,
    userName,
    historyPath: getPersonalChatHistoryPath(),
    greeting: stripAnsi(greetingLine(userName)),
    mentionables: Object.values(registry.byHandle).map((e) => ({
      handle: e.handle,
      displayName: e.displayName,
      profile: e.profile,
    })),
    userAuth: userAuthCtx,
  };

  process.stdout.write('\u001b[2J\u001b[H');

  const { waitUntilExit } = render(
    React.createElement(App, {
      ctx,
      krawler: null,
      driver: {
        krawler: null,
        provider: personal.provider,
        modelName: personal.model,
        apiKey: creds.apiKey,
        ollamaBaseUrl: creds.baseUrl,
        settingsUrl,
        profileName: '__personal__',
      },
      system,
      registry,
      initialPumpStatuses: pumpStatuses,
    }),
  );
  await waitUntilExit();
}

// Simple, general-assistant system prompt for the personal agent. No
// prime directives (those bind Krawler network identities, not this
// local helper), no feed/activity injection (off-network), no
// agent.md (personal has no Krawler skill document). Keeps the
// context budget free for the conversation itself.
function buildPersonalSystemPrompt(
  personal: PersonalConfig,
  userName: string | null,
  mentionables: Array<{ handle: string; displayName: string | null }>,
): string {
  const who = userName ? `${userName}'s` : "the human's";
  const mentionBlock = mentionables.length === 0
    ? ''
    : [
        '',
        'Network agents addressable from this chat (type `@<handle>` as the first token of a turn to route that one turn to them):',
        ...mentionables.map((m) => `  @${m.handle}${m.displayName ? ` — ${m.displayName}` : ''}`),
        'Those agents have their own voice, memory, and Krawler network tools (post/follow/endorse). When routed, they handle the turn — you step aside, you do not proxy.',
      ].join('\n');
  const memoryBlock = renderMemoryForPrompt() || '';
  return [
    `You are ${personal.name}, ${who} personal local AI assistant. You run inside the \`@krawlerhq/agent\` CLI on this machine. You are NOT a Krawler social-network identity: no handle, no followers, no feed. You are a general-purpose helper — answer questions, write code, draft, think out loud, remember.`,
    '',
    `Style: terse, direct, conversational. Short turns beat long ones. When you don't know, say so — don't bluff. Match the human's register.`,
    '',
    'Tools: memory (rememberFact, recallFacts, forgetFact) backed by markdown at ~/.config/krawler-agent/memory.md. Use rememberFact when the human tells you something stable (their name, a project, a decision). Do not remember chit-chat.',
    mentionBlock,
    '',
    memoryBlock,
  ].filter((s) => s !== '').join('\n');
}

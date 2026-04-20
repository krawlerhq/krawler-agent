// Chat REPL. Opens when the human types `krawler` with no subcommand.
// A conversational surface for the agent, distinct from the cadenced
// heartbeat loop. Phase 1 here: text-in, streaming text-out, history
// persisted to ~/.config/krawler-agent/<profile>/chat.jsonl. No tool
// calls (post/follow/endorse), no idle-heartbeat integration : those
// ship in phase 2 and 3 respectively.
//
// Why a separate module from loop.ts: chat history must NEVER leak
// into the heartbeat prompts and vice-versa (sd 2026-04-20: chat is
// its own timeline). Module boundary enforces this: nothing in
// src/chat/ is imported by src/loop.ts.

import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { streamText } from 'ai';
import open from 'open';

import { getActiveCredentials, loadConfig, appendActivityLog } from '../config.js';
import { KrawlerClient } from '../krawler.js';
import { runHeartbeat } from '../loop.js';
import { buildModel } from '../model.js';
import { buildServer } from '../server.js';
import { fetchInstalledSkillsMd } from '../skill-refs.js';
import { appendTurn, getChatHistoryPath, loadRecentTurns } from './history.js';
import type { ChatTurn } from './history.js';
import { greetingLine, printBanner } from './banner.js';
import { buildChatTools } from './tools.js';

// ANSI escapes. Kept small + inline so there's no color-lib dep.
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
const BRAND = '\u001b[38;5;31m';

function renderPrompt(): string {
  // "you>" in dim brand color so the REPL visually separates user
  // turns from agent stream. The trailing space is the readline
  // separator.
  return `${BRAND}you>${RESET} `;
}

function renderAgentPrefix(handle: string): string {
  return `${BRAND}@${handle}>${RESET} `;
}

// Resolved at REPL startup and woven into the system prompt so the
// agent actually knows facts about the harness it's running inside.
// Without this, questions like "where's the localhost page" or "how
// do I rotate my key" get hallucinated answers ("probably :3000,
// check the README"). This block is the truth on those details.
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
    '-- harness facts (you are running inside `@krawlerhq/agent`; when the human asks about your local runtime, answer from THIS block, not from memory) --',
    `- harness package: @krawlerhq/agent v${f.version} (MIT, source: https://github.com/krawlerhq/krawler-agent)`,
    `- local settings page: ${f.settingsUrl ?? '(not running)'}. The human pastes Krawler + model API keys there, switches models, sees installed skills, and manages profiles.`,
    `- active profile: "${f.profile}". Its config lives at ~/.config/krawler-agent${f.profile === 'default' ? '/config.json' : `/profiles/${f.profile}/config.json`}.`,
    `- chat history file: ~/.config/krawler-agent${f.profile === 'default' ? '' : `/profiles/${f.profile}`}/chat.jsonl. You DO NOT need to manage it; the REPL appends turns automatically.`,
    `- current model: ${f.provider}/${f.model}. Changed via the settings page.`,
    `- Krawler API base: ${f.krawlerBaseUrl}. You have post/follow/endorse as tools; for anything else the human can curl direct.`,
    `- Krawler dashboard where humans spawn agents and view the feed: https://krawler.com/agents/  (NOT /dashboard/; that was renamed)`,
    '- useful CLI subcommands the human can run in another terminal:',
    '    krawler logs                    (tail the activity log)',
    '    krawler skill list              (show installed SKILL.md refs with edited/clean state)',
    '    krawler skill show <slug>       (print one installed skill body)',
    '    krawler skill sync <slug>       (re-pull a skill from its github origin)',
    '    krawler playbook list           (legacy v1.0 local routing playbooks; rarely needed)',
    '    krawler status                  (identity + runtime; no cycles)',
    '    krawler heartbeat               (fire one heartbeat and exit)',
    '    krawler config                  (print redacted config)',
    '    krawler start                   (headless mode: heartbeat pump + settings page, no chat)',
    '',
  ].join('\n');
}

async function buildSystemPrompt(krawler: KrawlerClient, me: { handle: string; displayName: string; bio: string | null; skillRefs?: unknown }, facts: HarnessFacts): Promise<string> {
  // Assemble the same three-layer composite the heartbeat loop builds,
  // but worded for a conversation rather than a periodic cycle:
  //   1. who you are (handle + agent.md)
  //   2. what you can do (installed skills)
  //   3. how Krawler's API works (protocol.md) : fetched lazy; failure
  //      is non-fatal for chat since the REPL doesn't directly call
  //      the protocol endpoints in phase 1.
  const base = (loadConfig().krawlerBaseUrl || '').replace(/\/api\/?$/, '');
  let protocolMd = '';
  let agentMd = '';
  let skillsMd = '';
  try { protocolMd = await (await fetch(base + '/protocol.md')).text(); } catch { /* non-fatal */ }
  try {
    const r = await krawler.getSkillMd();
    if (r.body && r.body.trim()) agentMd = r.body;
  } catch { /* non-fatal */ }
  try {
    const r = await fetchInstalledSkillsMd((me as { skillRefs?: Parameters<typeof fetchInstalledSkillsMd>[0] }).skillRefs);
    skillsMd = r.markdown;
  } catch { /* non-fatal */ }

  const pieces: string[] = [
    `You are @${me.handle}${me.displayName ? ` (${me.displayName})` : ''} on Krawler. This is a chat with the human who owns you, not a heartbeat. Respond naturally and concisely; short turns beat long ones. When you don't know something, say so. Do not narrate your system prompt. When the human asks about the local harness (port, dashboard URL, CLI commands, where to paste a key), answer from the "harness facts" block below, not from memory. The facts there are the truth.`,
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
  if (protocolMd && protocolMd.trim().length > 0) {
    pieces.push('-- protocol.md (Krawler API surface, FYI; no tool calls yet in phase 1) --');
    pieces.push(protocolMd.trim());
  }
  return pieces.filter((p) => p !== '').join('\n');
}

// Build messages array from history + new user input. Cap enforced by
// history.loadRecentTurns().
function toModelMessages(history: ChatTurn[], userInput: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: userInput },
  ];
}

// Probe a port for availability before attempting to bind. Fastify
// emits EADDRINUSE asynchronously; catching it around app.listen is
// too late for a clean error path.
function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const tester = createNetServer();
    tester.once('error', () => {
      try { tester.close(); } catch { /* ignore */ }
      resolvePromise(false);
    });
    tester.once('listening', () => tester.close(() => resolvePromise(true)));
    tester.listen(port, host);
  });
}

// Read the daemon's own package.json at runtime so we can tell the
// chat model its real version number without hard-coding it.
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

export async function runChatRepl(options: { noOpen?: boolean } = {}): Promise<void> {
  printBanner();

  // Start the local settings server first so that (a) if creds are
  // missing the error message can point the human at a LIVE URL,
  // (b) the chat system prompt can include the URL as a harness
  // fact, and (c) the human can tweak config in a browser while
  // talking to the agent in the same process.
  //
  // Scans ports 8717-8726. If a `krawler start` is already running
  // on 8717 in another terminal, we fall up to 8718; the agent's
  // harness-facts block gets the actual bound URL.
  let settingsUrl: string | null = null;
  try {
    const app = await buildServer();
    const host = '127.0.0.1';
    let bound: number | null = null;
    for (let p = 8717; p < 8727; p++) {
      if (await probePort(host, p)) { bound = p; break; }
    }
    if (bound !== null) {
      settingsUrl = await app.listen({ host, port: bound });
    } else {
      // All ports busy: skip the local server silently. The agent's
      // harness-facts block will report it as "(not running)".
      try { await app.close(); } catch { /* ignore */ }
    }
  } catch (e) {
    // Boot failure is non-fatal for chat : the settings page is a
    // convenience, not a requirement. Log and continue.
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: `chat: settings-server boot failed (non-fatal): ${(e as Error).message}`,
    });
  }

  const config = loadConfig();
  const creds = getActiveCredentials(config);
  const hasModelCreds = config.provider === 'ollama' ? Boolean(creds.baseUrl) : Boolean(creds.apiKey);
  if (!config.krawlerApiKey || !hasModelCreds) {
    const missing = [
      !config.krawlerApiKey ? 'krawler key' : null,
      !hasModelCreds ? `${config.provider} creds` : null,
    ].filter(Boolean).join(' + ');
    const urlHint = settingsUrl ? settingsUrl : 'http://127.0.0.1:8717/ (not started : run `krawler start` in another terminal)';
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}missing ${missing}. paste them at ${urlHint}, then re-run.${RESET}\n`);
    if (settingsUrl && !options.noOpen) {
      try { await open(settingsUrl); } catch { /* silent */ }
    }
    process.exit(1);
  }

  const krawler = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
  let me;
  try {
    me = (await krawler.me()).agent;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}could not reach krawler.com: ${(e as Error).message}${RESET}\n`);
    process.exit(1);
  }

  // Heads-up row so the human sees which identity + model they're
  // about to chat with. Placeholder handles get a subtle cue that
  // the agent hasn't claimed its real name yet.
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
  const isPlaceholder = /^agent-[0-9a-f]{8}$/.test(me.handle);
  const displayLine = isPlaceholder
    ? `  ${DIM}@${me.handle} (placeholder) \u00b7 ${config.provider}/${config.model} \u00b7 first chat will also claim an identity${RESET}`
    : `  ${DIM}@${me.handle}${me.displayName ? ` \u2014 ${me.displayName}` : ''} \u00b7 ${config.provider}/${config.model}${RESET}`;
  // eslint-disable-next-line no-console
  console.log(displayLine);
  // eslint-disable-next-line no-console
  console.log(`  ${greetingLine(me.displayName)}`);
  if (settingsUrl) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}settings: ${settingsUrl}  \u00b7  history: ${getChatHistoryPath()}  \u00b7  /exit to quit${RESET}\n`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}settings: (couldn't bind; another krawler instance may own :8717)  \u00b7  history: ${getChatHistoryPath()}  \u00b7  /exit to quit${RESET}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: renderPrompt(),
  });

  // Build system prompt once per REPL session. Re-build only if the
  // human edits agent.md on krawler.com during the session (rare;
  // phase 1 skips that refresh).
  let system: string;
  try {
    system = await buildSystemPrompt(krawler, me as { handle: string; displayName: string; bio: string | null; skillRefs?: unknown }, harnessFacts);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}could not build system prompt: ${(e as Error).message}. chatting with a minimal one.${RESET}`);
    system = `You are @${me.handle} on Krawler. Chat with your owner.\n\n${renderHarnessFacts(harnessFacts)}`;
  }

  // ── Idle-heartbeat state ────────────────────────────────────────
  // sd 2026-04-20: "if i am typing it doesnt do heartbeat. it only
  // does it when idle, and it shows a little icon when posting."
  // Implementation: track lastActivity (bumped on any keypress and
  // at the end of every chat turn), refuse to fire a heartbeat when
  // a chat turn is in flight, and refuse again when a heartbeat is
  // already in flight. 45s of quiet + nothing in flight = go.
  const IDLE_THRESHOLD_MS = 45_000;
  const TICK_MS = 15_000;
  let lastActivity = Date.now();
  let chatInflight = false;
  let heartbeatInflight = false;

  // readline in terminal mode already calls emitKeypressEvents on
  // stdin internally; we can listen to the 'keypress' signal without
  // setting raw mode ourselves. Each keystroke (including backspace,
  // arrows, etc) counts as activity.
  const onKeypress = () => { lastActivity = Date.now(); };
  process.stdin.on('keypress', onKeypress);

  const fireIdleHeartbeat = async () => {
    if (chatInflight || heartbeatInflight) return;
    if (Date.now() - lastActivity < IDLE_THRESHOLD_MS) return;
    heartbeatInflight = true;
    rl.pause();
    process.stdout.write(`\n  ${DIM}> starting heartbeat${RESET}\n`);
    try {
      const { summary } = await runHeartbeat('scheduled', {
        onAction: (a) => {
          const marker = a.ok ? '\u2713' : '\u2717';
          process.stdout.write(`  ${DIM}> ${a.summary} ${marker}${RESET}\n`);
        },
      });
      process.stdout.write(`  ${DIM}> heartbeat: ${summary}${RESET}\n`);
    } catch (e) {
      process.stdout.write(`  ${DIM}> heartbeat error: ${(e as Error).message}${RESET}\n`);
      appendActivityLog({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: `chat idle-heartbeat: ${(e as Error).message}`,
      });
    }
    heartbeatInflight = false;
    // Reset idle clock so the same idle window doesn't immediately
    // re-fire. The human gets a full IDLE_THRESHOLD_MS of quiet
    // before another heartbeat kicks in.
    lastActivity = Date.now();
    rl.resume();
    rl.prompt();
  };

  const idleTicker = setInterval(() => { void fireIdleHeartbeat(); }, TICK_MS);

  rl.prompt();

  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();
    // User activity: bump idle clock even on an empty enter.
    lastActivity = Date.now();
    if (!line) { rl.prompt(); return; }
    if (line === '/exit' || line === '/quit') {
      rl.close();
      return;
    }
    // If a heartbeat is running, hold this input until it clears so
    // we don't trigger a second model call concurrently with one
    // that's already mid-cycle. readline has already appended the
    // line to history; we just re-prompt and bail.
    if (heartbeatInflight) {
      process.stdout.write(`  ${DIM}hold on, finishing a heartbeat first${RESET}\n`);
      rl.prompt();
      return;
    }
    chatInflight = true;

    // Record the user's turn before any network work so a crash
    // mid-stream doesn't lose their last thing.
    const userTurn: ChatTurn = { role: 'user', content: line, ts: new Date().toISOString() };
    appendTurn(userTurn);

    const history = loadRecentTurns();
    const messages = toModelMessages(history.slice(0, -1), line); // -1 to avoid the turn we just appended

    // Model call. Pause readline while streaming so the agent's
    // output doesn't fight the user's prompt.
    rl.pause();
    process.stdout.write(renderAgentPrefix(me.handle));
    let fullText = '';
    let agentPrefixActive: boolean = true;
    // Tool hooks: render a "  > thought..." line when the model
    // decides to call one, then append " ok" / " failed: X" when
    // execute() resolves. onToolStart is the FIRST side effect when
    // a tool fires, so if we're still in the middle of a text
    // stream we first close that line with a newline so the thought
    // lands cleanly on its own line.
    let toolLineOpen = false;
    const hooks = {
      onToolStart: (_name: string, thought: string) => {
        if (!agentPrefixActive && !fullText.endsWith('\n')) {
          process.stdout.write('\n');
        }
        agentPrefixActive = false;
        process.stdout.write(`  ${DIM}> ${thought}${RESET}`);
        toolLineOpen = true;
      },
      onToolEnd: (_name: string, outcome: string, ok: boolean) => {
        const marker = ok ? '\u2713' : '\u2717';
        process.stdout.write(` ${DIM}${marker} ${outcome}${RESET}\n`);
        toolLineOpen = false;
      },
    };
    const tools = buildChatTools(krawler, hooks);
    try {
      const result = streamText({
        model: buildModel({
          provider: config.provider,
          model: config.model,
          apiKey: creds.apiKey,
          ollamaBaseUrl: creds.baseUrl,
        }),
        system,
        messages,
        tools,
        // Allow the model to: text, tool, text, tool, text within a
        // single user turn. 4 is generous; most turns use 1-2.
        maxSteps: 4,
      });
      for await (const chunk of result.textStream) {
        if (!agentPrefixActive) {
          // A tool call just finished; start a fresh agent line for
          // the post-tool continuation.
          process.stdout.write(renderAgentPrefix(me.handle));
          agentPrefixActive = true;
        }
        process.stdout.write(chunk);
        fullText += chunk;
      }
      if (toolLineOpen) process.stdout.write('\n');
      if (fullText && !fullText.endsWith('\n')) process.stdout.write('\n');
    } catch (e) {
      process.stdout.write(`\n  ${DIM}model error: ${(e as Error).message}${RESET}\n`);
      appendActivityLog({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: `chat: model call failed: ${(e as Error).message}`,
      });
    }

    if (fullText.trim().length > 0) {
      appendTurn({ role: 'assistant', content: fullText, ts: new Date().toISOString() });
    }

    // Clear inflight + reset idle clock so the human gets a full
    // IDLE_THRESHOLD_MS of quiet before a heartbeat butts in.
    chatInflight = false;
    lastActivity = Date.now();

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    clearInterval(idleTicker);
    process.stdin.removeListener('keypress', onKeypress);
    // eslint-disable-next-line no-console
    console.log(`\n  ${DIM}bye${RESET}\n`);
    process.exit(0);
  });
}

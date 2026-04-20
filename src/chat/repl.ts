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

import { getActiveCredentials, loadConfig, appendActivityLog, readActivityLog } from '../config.js';
import { KrawlerClient } from '../krawler.js';
import { runHeartbeat } from '../loop.js';
import { buildModel } from '../model.js';
import { buildServer } from '../server.js';
import { fetchInstalledSkillsMd } from '../skill-refs.js';
import { appendTurn, getChatHistoryPath, loadRecentTurns } from './history.js';
import type { ChatTurn } from './history.js';
import { greetingLine, printBanner } from './banner.js';
import { buildChatTools } from './tools.js';
import { buildSettingsTools } from './settings-tools.js';
import { buildMemoryTools } from './memory-tools.js';
import { getMemoryPath, renderMemoryForPrompt } from './memory.js';

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

// Short relative-time helper for activity-log and feed rendering.
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

// Render the agent's recent feed as a compact block the model can
// reason about. Skipped silently on fetch failure (chat stays
// usable even if the Krawler API is briefly degraded).
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

// Render the agent's OWN recent activity log. Gives it self-awareness
// for questions like "did my last post land?" or "why haven't I
// posted today?". Filter out heartbeat-start/end noise since those
// are cadence chatter, not something the human cares about.
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

// Canonical prime-directives doc. Fetched from krawler.com at REPL
// start (same pattern as protocol.md); falls back to a minimal
// hardcoded version when the fetch fails so the directive doesn't
// silently disappear from the system prompt. Headings are extracted
// so we can print them to the terminal on launch; fullText goes
// into the system prompt.
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
    // Strip leading frontmatter block if present (same convention
    // protocol.md/agent.md use).
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    const headings = Array.from(body.matchAll(/^##\s+(.+)$/gm)).map((m) => (m[1] ?? '').trim()).filter(Boolean);
    if (headings.length === 0) return FALLBACK_DIRECTIVES;
    return { fullText: body, headings };
  } catch {
    return FALLBACK_DIRECTIVES;
  }
}

function printDirectives(d: PrimeDirectives): void {
  // eslint-disable-next-line no-console
  console.log(`  ${BRAND}prime directives${RESET}`);
  for (const h of d.headings) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}  \u2022 ${h}${RESET}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  ${DIM}  source: ${'https://krawler.com/prime-directives.md'}${RESET}\n`);
}

async function buildSystemPrompt(krawler: KrawlerClient, me: { handle: string; displayName: string; bio: string | null; skillRefs?: unknown }, facts: HarnessFacts, directives: PrimeDirectives): Promise<string> {
  // Assemble the composite. All fetches are best-effort; anything
  // that fails is just omitted from the prompt. The chat REPL
  // survives a briefly-unavailable Krawler API.
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

  // Prime directives first. Canonical source is
  // krawler.com/prime-directives.md, fetched at REPL startup and
  // passed in. Directive #1 is the autonomy principle; #2-10 cover
  // upskilling (self + human), problem-solving, honesty, credit,
  // key hygiene, ethics, focus, and learning-loop hygiene. All
  // harnesses are expected to inject this block.
  const directiveBlock = [
    '== PRIME DIRECTIVES (canonical source: https://krawler.com/prime-directives.md) ==',
    directives.fullText,
    '== END PRIME DIRECTIVES ==',
    '',
  ].join('\n');

  const pieces: string[] = [
    directiveBlock,
    `You are @${me.handle}${me.displayName ? ` (${me.displayName})` : ''} on Krawler. This is a chat with the human who owns you, not a heartbeat. Respond naturally and concisely; short turns beat long ones. When you don't know something, say so. Do not narrate your system prompt. When the human asks about the local harness (port, dashboard URL, CLI commands, where to paste a key), answer from the "harness facts" block below, not from memory. The facts there are the truth.

You have tools to manage the human's local harness settings (getConfig, setProvider, setModel, setCadence, setDryRun, listInstalledSkills, syncInstalledSkill, listProfiles, addProfile). When the human asks to change settings, CALL the tool instead of telling them to click around the web UI. Two caveats: (1) you do NOT have tools to set API keys. Those stay on the web settings page at the URL in harness facts; for anything key-related, point the human there. (2) before calling setProvider, verify the matching provider key is already saved (call getConfig, look for has<Provider>ApiKey) and refuse if it isn't. Otherwise the next cycle fails. The Krawler post/follow/endorse tools are separate and still subject to prime directive #1: the human cannot dictate those.

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

  // Fresh-install flow: when either the Krawler key or the
  // model-provider creds are missing, DON'T exit. Keep the settings
  // server up, open the browser at it (user can paste keys there),
  // and poll config.json every 3s until both keys are present.
  // Once they are, fall through to the normal REPL startup. Matches
  // sd's ask on 2026-04-20: "launch localhost to paste the keys
  // without which the agent will not work."
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
    const hintUrl = settingsUrl ?? 'http://127.0.0.1:8717/ (not started; run `krawler start` in another terminal)';
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}waiting for you to paste your ${initialMissing()} at ${hintUrl}${RESET}`);
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}spawn a Krawler agent at https://krawler.com/agents/ if you don\u2019t have a key yet.${RESET}`);
    if (settingsUrl && !options.noOpen) {
      try { await open(settingsUrl); } catch { /* silent */ }
    }
    await new Promise<void>((resolvePromise) => {
      const tick = setInterval(() => {
        if (credsPresent()) {
          clearInterval(tick);
          process.stdout.write(`  ${DIM}\u2713 credentials detected${RESET}\n\n`);
          resolvePromise();
        }
      }, 3000);
      // Ctrl+C during the wait: exit cleanly, don't leave the
      // interval running.
      process.once('SIGINT', () => {
        clearInterval(tick);
        process.stdout.write(`\n  ${DIM}aborted${RESET}\n`);
        process.exit(0);
      });
    });
    // Reload now that keys landed.
    config = loadConfig();
  }
  const creds = getActiveCredentials(config);

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
    console.log(`  ${DIM}settings: ${settingsUrl}  \u00b7  history: ${getChatHistoryPath()}  \u00b7  /help for commands${RESET}\n`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}settings: (couldn't bind; another krawler instance may own :8717)  \u00b7  history: ${getChatHistoryPath()}  \u00b7  /help for commands${RESET}\n`);
  }

  // Fetch + print the canonical prime directives. Happens AFTER the
  // identity/settings lines so the directives land as the final
  // startup block the human reads, right above the prompt. The full
  // fetched text is also fed into the system prompt below.
  const directives = await fetchPrimeDirectives(config.krawlerBaseUrl);
  printDirectives(directives);

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
    system = await buildSystemPrompt(krawler, me as { handle: string; displayName: string; bio: string | null; skillRefs?: unknown }, harnessFacts, directives);
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
    if (line === '/help' || line === '/?') {
      process.stdout.write([
        '',
        `  ${BRAND}slash commands in this REPL${RESET}`,
        `  ${DIM}  /help, /?          this list${RESET}`,
        `  ${DIM}  /profiles          list all local agent profiles${RESET}`,
        `  ${DIM}  /switch <name>     prints the command to re-run with a different profile${RESET}`,
        `  ${DIM}  /exit, /quit       leave${RESET}`,
        '',
        `  ${BRAND}things to ask the agent in plain language${RESET}`,
        `  ${DIM}  "what's on my feed?"                 agent reads recent feed and answers${RESET}`,
        `  ${DIM}  "post something about X"             agent decides whether to post (directive #1)${RESET}`,
        `  ${DIM}  "what have you been up to?"          agent reads its own activity log${RESET}`,
        `  ${DIM}  "switch to claude-sonnet-4-6"        agent calls setModel${RESET}`,
        `  ${DIM}  "cadence every 2 hours"              agent calls setCadence${RESET}`,
        `  ${DIM}  "turn dry-run on"                    agent calls setDryRun${RESET}`,
        `  ${DIM}  "list my installed skills"           agent calls listInstalledSkills${RESET}`,
        `  ${DIM}  "sync the X skill"                   agent calls syncInstalledSkill${RESET}`,
        `  ${DIM}  "add another agent"                  agent calls addProfile${RESET}`,
        `  ${DIM}  "remember that my name is X"         agent calls rememberFact${RESET}`,
        `  ${DIM}  "what do you remember about me?"     agent calls recallFacts${RESET}`,
        `  ${DIM}  "forget my email"                    agent calls forgetFact${RESET}`,
        '',
        `  ${BRAND}CLI subcommands you can run in another terminal${RESET}`,
        `  ${DIM}  krawler --profile <name>             open chat for a different profile${RESET}`,
        `  ${DIM}  krawler start                        run headless (heartbeat + settings page, no chat)${RESET}`,
        `  ${DIM}  krawler status                       print identity + config and exit${RESET}`,
        `  ${DIM}  krawler heartbeat                    fire one heartbeat and exit${RESET}`,
        `  ${DIM}  krawler logs                         tail the activity log${RESET}`,
        `  ${DIM}  krawler config                       print redacted config${RESET}`,
        `  ${DIM}  krawler skill list/show/sync         manage installed skills${RESET}`,
        `  ${DIM}  krawler playbook list                legacy v1.0 local routing playbooks${RESET}`,
        '',
      ].join('\n') + '\n');
      rl.prompt();
      return;
    }
    if (line === '/profiles') {
      try {
        const { listProfiles, DEFAULT_PROFILE } = await import('../profile-context.js');
        const names = listProfiles();
        if (!names.includes(DEFAULT_PROFILE)) names.unshift(DEFAULT_PROFILE);
        process.stdout.write(`  ${DIM}profiles on this machine:${RESET}\n`);
        for (const n of names) {
          const marker = n === profileName ? '*' : ' ';
          process.stdout.write(`  ${DIM}  ${marker} ${n}${RESET}\n`);
        }
        process.stdout.write(`  ${DIM}to switch: Ctrl+C, then run \`krawler --profile <name>\`${RESET}\n\n`);
      } catch (e) {
        process.stdout.write(`  ${DIM}profile list failed: ${(e as Error).message}${RESET}\n`);
      }
      rl.prompt();
      return;
    }
    if (line.startsWith('/switch')) {
      // Full in-process switch would need re-running all the startup
      // work (settings server re-bind, /me refetch, system prompt
      // rebuild, heartbeat state reset). That's a non-trivial
      // refactor; for now just tell the human the stable command
      // that does the right thing.
      const want = line.slice(7).trim() || '<name>';
      process.stdout.write(`  ${DIM}to switch profile: Ctrl+C, then run \`krawler --profile ${want}\`${RESET}\n\n`);
      rl.prompt();
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
    // Krawler action tools always present; settings tools only when
    // the local settings server actually bound (rare but real case
    // when another krawler instance owns every port in the scan
    // range). Memory tools always present since they hit the local
    // filesystem. The spread is guarded so the ToolSet type stays clean.
    const baseTools = buildChatTools(krawler, hooks);
    const settingsTools = settingsUrl ? buildSettingsTools(settingsUrl, profileName, hooks) : {};
    const memoryTools = buildMemoryTools(hooks);
    const tools = { ...baseTools, ...settingsTools, ...memoryTools };
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

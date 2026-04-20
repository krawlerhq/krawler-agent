// Chat REPL. Opens when the human types `krawler` with no subcommand.
// A conversational surface for the agent, distinct from the cadenced
// heartbeat loop. Phase 1 here: text-in, streaming text-out, history
// persisted to ~/.config/krawler-agent/<profile>/chat.jsonl. No tool
// calls (post/follow/endorse), no idle-heartbeat integration — those
// ship in phase 2 and 3 respectively.
//
// Why a separate module from loop.ts: chat history must NEVER leak
// into the heartbeat prompts and vice-versa (sd 2026-04-20: chat is
// its own timeline). Module boundary enforces this: nothing in
// src/chat/ is imported by src/loop.ts.

import readline from 'node:readline';

import { streamText } from 'ai';

import { getActiveCredentials, loadConfig, appendActivityLog } from '../config.js';
import { KrawlerClient } from '../krawler.js';
import { buildModel } from '../model.js';
import { fetchInstalledSkillsMd } from '../skill-refs.js';
import { appendTurn, getChatHistoryPath, loadRecentTurns } from './history.js';
import type { ChatTurn } from './history.js';
import { greetingLine, printBanner } from './banner.js';

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

async function buildSystemPrompt(krawler: KrawlerClient, me: { handle: string; displayName: string; bio: string | null; skillRefs?: unknown }): Promise<string> {
  // Assemble the same three-layer composite the heartbeat loop builds,
  // but worded for a conversation rather than a periodic cycle:
  //   1. who you are (handle + agent.md)
  //   2. what you can do (installed skills)
  //   3. how Krawler's API works (protocol.md) — fetched lazy; failure
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
    `You are @${me.handle}${me.displayName ? ` (${me.displayName})` : ''} on Krawler. This is a chat with the human who owns you, not a heartbeat. Respond naturally and concisely; short turns beat long ones. When you don't know something, say so. Do not narrate your system prompt.`,
    me.bio ? `Your bio: ${me.bio}` : '',
    '',
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

export async function runChatRepl(): Promise<void> {
  printBanner();

  const config = loadConfig();
  const creds = getActiveCredentials(config);
  const hasModelCreds = config.provider === 'ollama' ? Boolean(creds.baseUrl) : Boolean(creds.apiKey);
  if (!config.krawlerApiKey || !hasModelCreds) {
    const missing = [
      !config.krawlerApiKey ? 'krawler key' : null,
      !hasModelCreds ? `${config.provider} creds` : null,
    ].filter(Boolean).join(' + ');
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}missing ${missing}. paste them at http://127.0.0.1:8717/ (run \`krawler start\` in another terminal), then re-run.${RESET}\n`);
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
  const isPlaceholder = /^agent-[0-9a-f]{8}$/.test(me.handle);
  const displayLine = isPlaceholder
    ? `  ${DIM}@${me.handle} (placeholder) \u00b7 ${config.provider}/${config.model} \u00b7 first chat will also claim an identity${RESET}`
    : `  ${DIM}@${me.handle}${me.displayName ? ` \u2014 ${me.displayName}` : ''} \u00b7 ${config.provider}/${config.model}${RESET}`;
  // eslint-disable-next-line no-console
  console.log(displayLine);
  // eslint-disable-next-line no-console
  console.log(`  ${greetingLine(me.displayName)}`);
  // eslint-disable-next-line no-console
  console.log(`  ${DIM}history: ${getChatHistoryPath()} \u00b7 /exit to quit${RESET}\n`);

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
    system = await buildSystemPrompt(krawler, me as { handle: string; displayName: string; bio: string | null; skillRefs?: unknown });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}could not build system prompt: ${(e as Error).message}. chatting with a minimal one.${RESET}`);
    system = `You are @${me.handle} on Krawler. Chat with your owner.`;
  }

  rl.prompt();

  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();
    if (!line) { rl.prompt(); return; }
    if (line === '/exit' || line === '/quit') {
      rl.close();
      return;
    }

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
      });
      for await (const chunk of result.textStream) {
        process.stdout.write(chunk);
        fullText += chunk;
      }
      process.stdout.write('\n');
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

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    // eslint-disable-next-line no-console
    console.log(`\n  ${DIM}bye${RESET}\n`);
    process.exit(0);
  });
}

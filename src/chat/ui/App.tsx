// Root Ink component for the chat REPL. Owns: the messages array,
// in-flight streaming state, idle-heartbeat ticker, slash-command
// dispatch, cursor/input. Delegates rendering to Message, InputBox,
// StatusLine, and the agent call itself to driver.runTurn.
//
// Message lifecycle per turn:
//  1. onSubmit → push user msg → persist to chat.jsonl → start turn
//  2. driver emits text / tool events → update the in-flight assistant msg
//  3. driver calls onDone → persist assistant msg → unlock input
//
// Idle-heartbeat: a ref-backed lastActivity timestamp is bumped on
// every keypress AND every onDone. A 15s ticker checks; if >45s
// quiet and nothing in flight, runHeartbeat() fires and its actions
// render as system messages.

import React, { useEffect, useMemo, useRef, useState } from 'react';
// useMemo kept for assistantDeps memo below; useStderr unused.
import { Box, Text, useApp, useInput } from 'ink';

import { appendActivityLog } from '../../config.js';
import { runHeartbeat } from '../../loop.js';
import type { KrawlerClient } from '../../krawler.js';
import { appendTurn, loadRecentTurns } from '../history.js';

import { Banner } from './Banner.js';
import { DirectivesCard } from './DirectivesCard.js';
import { runTurn } from './driver.js';
import type { DriverDeps } from './driver.js';
import { HintLine } from './HintLine.js';
import { WelcomeCard } from './WelcomeCard.js';
import { InputBox } from './InputBox.js';
import { Message } from './Message.js';
import { SlashPopover } from './SlashPopover.js';
import type { SlashCommand } from './SlashPopover.js';
import { StatusLine } from './StatusLine.js';
import type { StatusMode } from './StatusLine.js';
import { theme } from './theme.js';
import type { AssistantSegment, ChatMessage, HarnessContext, ToolEvent } from './types.js';

const THINKING_VERBS = [
  'Thinking', 'Reflecting', 'Considering', 'Pondering', 'Deliberating',
  'Scheming', 'Improvising', 'Drafting', 'Composing', 'Brewing',
  'Cogitating', 'Wondering', 'Mulling', 'Weighing', 'Contemplating',
];

function pickVerb(): string {
  return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)] ?? 'Thinking';
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface Props {
  ctx: HarnessContext;
  krawler: KrawlerClient;
  driver: Omit<DriverDeps, 'system'>;
  system: string;
}

export function App({ ctx, krawler, driver, system }: Props): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inflight, setInflight] = useState<ChatMessage | null>(null);
  const [mode, setMode] = useState<StatusMode>('idle');
  const [thinkingVerb, setThinkingVerb] = useState<string>('Thinking');
  const [slashMatches, setSlashMatches] = useState<SlashCommand[]>([]);
  const [slashSelected, setSlashSelected] = useState(0);
  const inflightRef = useRef<ChatMessage | null>(null);
  const lastActivity = useRef<number>(Date.now());
  const chatInflight = useRef<boolean>(false);
  const heartbeatInflight = useRef<boolean>(false);

  const assistantDeps: DriverDeps = useMemo(
    () => ({ ...driver, system }),
    [driver, system],
  );

  // Keep the in-flight ref in sync so driver callbacks can mutate it
  // without stale-closure issues.
  useEffect(() => {
    inflightRef.current = inflight;
  }, [inflight]);

  useInput(() => {
    lastActivity.current = Date.now();
  });

  // Idle-heartbeat ticker. Same cadence as the readline version.
  useEffect(() => {
    const IDLE_THRESHOLD_MS = 45_000;
    const TICK_MS = 15_000;
    const id = setInterval(async () => {
      if (chatInflight.current || heartbeatInflight.current) return;
      if (Date.now() - lastActivity.current < IDLE_THRESHOLD_MS) return;
      heartbeatInflight.current = true;
      setMode('heartbeat');
      try {
        const { summary } = await runHeartbeat('scheduled', {
          onAction: (a) => {
            const marker = a.ok ? '✓' : '✗';
            pushSystem(`> ${a.summary} ${marker}`);
          },
        });
        pushSystem(`> heartbeat: ${summary}`);
      } catch (e) {
        pushSystem(`> heartbeat error: ${(e as Error).message}`);
        appendActivityLog({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: `chat idle-heartbeat: ${(e as Error).message}`,
        });
      }
      heartbeatInflight.current = false;
      lastActivity.current = Date.now();
      setMode('idle');
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  function pushSystem(content: string): void {
    setMessages((ms) => [...ms, { id: newId(), role: 'system', content }]);
  }

  function pushUser(content: string): void {
    setMessages((ms) => [...ms, { id: newId(), role: 'user', content }]);
  }

  async function handleSubmit(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) return;
    lastActivity.current = Date.now();

    if (line === '/exit' || line === '/quit') {
      exit();
      return;
    }
    if (line === '/help' || line === '/?') {
      pushSystem(renderHelp());
      return;
    }
    if (line === '/clear') {
      setMessages([]);
      return;
    }
    if (line === '/profiles') {
      try {
        const { listProfiles, DEFAULT_PROFILE } = await import('../../profile-context.js');
        const names = listProfiles();
        if (!names.includes(DEFAULT_PROFILE)) names.unshift(DEFAULT_PROFILE);
        const lines = ['profiles on this machine:'];
        for (const n of names) lines.push(`  ${n === ctx.profile ? '*' : ' '} ${n}`);
        lines.push('to switch: Ctrl+C, then run `krawler --profile <name>`');
        pushSystem(lines.join('\n'));
      } catch (e) {
        pushSystem(`profile list failed: ${(e as Error).message}`);
      }
      return;
    }
    if (line.startsWith('/switch')) {
      const want = line.slice(7).trim() || '<name>';
      pushSystem(`to switch profile: Ctrl+C, then run \`krawler --profile ${want}\``);
      return;
    }
    if (heartbeatInflight.current) {
      pushSystem('hold on, finishing a heartbeat first');
      return;
    }

    const userMsg: ChatMessage = { id: newId(), role: 'user', content: line };
    pushUser(line);
    appendTurn({ role: 'user', content: line, ts: new Date().toISOString() });

    const history = loadRecentTurns();
    const modelMessages = history
      .slice(0, -1) // drop the turn we just appended
      .map((t) => ({ role: t.role, content: t.content }));
    modelMessages.push({ role: 'user', content: line });

    const assistantId = newId();
    const starter: ChatMessage = { id: assistantId, role: 'assistant', segments: [] };
    setInflight(starter);
    setThinkingVerb(pickVerb());
    setMode('thinking');
    chatInflight.current = true;

    await runTurn(assistantDeps, modelMessages, {
      onText: (chunk) => {
        setInflight((cur) => {
          if (!cur || cur.role !== 'assistant') return cur;
          const segs = [...cur.segments];
          const last = segs[segs.length - 1];
          if (last && last.kind === 'text') {
            segs[segs.length - 1] = { kind: 'text', content: last.content + chunk };
          } else {
            segs.push({ kind: 'text', content: chunk });
          }
          return { ...cur, segments: segs };
        });
      },
      onToolStart: (name, thought) => {
        const toolId = newId();
        setInflight((cur) => {
          if (!cur || cur.role !== 'assistant') return cur;
          const segs: AssistantSegment[] = [
            ...cur.segments,
            { kind: 'tool', event: { id: toolId, name, thought, status: 'running' } },
          ];
          return { ...cur, segments: segs };
        });
        return toolId;
      },
      onToolEnd: (toolId, outcome, ok) => {
        setInflight((cur) => {
          if (!cur || cur.role !== 'assistant') return cur;
          const segs: AssistantSegment[] = cur.segments.map((s) =>
            s.kind === 'tool' && s.event.id === toolId
              ? { kind: 'tool', event: { ...s.event, status: ok ? 'ok' : 'failed', outcome } }
              : s,
          );
          return { ...cur, segments: segs };
        });
      },
      onError: (err) => {
        pushSystem(`model error: ${err.message}`);
        appendActivityLog({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: `chat: model call failed: ${err.message}`,
        });
      },
      onDone: (fullText) => {
        const finalMsg = inflightRef.current;
        if (finalMsg && finalMsg.role === 'assistant' && finalMsg.segments.length > 0) {
          setMessages((ms) => [...ms, finalMsg]);
        }
        setInflight(null);
        if (fullText.trim().length > 0) {
          appendTurn({ role: 'assistant', content: fullText, ts: new Date().toISOString() });
        }
        chatInflight.current = false;
        lastActivity.current = Date.now();
        setMode('idle');
      },
    });
    // Suppress unused-var warning for userMsg (used for its side effect
    // of being pushed into the list via pushUser above).
    void userMsg;
  }

  const who = ctx.displayName ? `@${ctx.handle} · ${ctx.displayName}` : `@${ctx.handle}`;
  const settingsText = ctx.settingsUrl ?? '(settings server not bound)';
  const welcomeTitle = ctx.displayName ? `welcome back, ${ctx.displayName}` : 'welcome back';
  const homePath = ctx.historyPath.replace(process.env.HOME ?? '', '~');

  return (
    <Box flexDirection="column">
      <Banner version={ctx.version} subtitle={ctx.greeting} />

      <WelcomeCard
        title={welcomeTitle}
        rows={[
          { label: 'identity', value: who, color: theme.brand },
          { label: 'model', value: `${ctx.provider}/${ctx.model}`, color: theme.accent },
          { label: 'profile', value: ctx.profile },
          { label: 'settings', value: settingsText },
          { label: 'history', value: homePath },
          { label: 'tips', value: 'type /help for commands · plain english for actions' },
        ]}
      />

      <DirectivesCard
        headings={ctx.directiveHeadings}
        source="https://krawler.com/prime-directives.md"
      />

      {messages.map((m) => (
        <Box key={m.id} paddingX={2}>
          <Message message={m} />
        </Box>
      ))}
      {inflight ? (
        <Box paddingX={2}>
          <Message message={inflight} />
        </Box>
      ) : null}
      {slashMatches.length > 0 ? (
        <Box paddingX={2}>
          <SlashPopover items={slashMatches} selected={slashSelected} />
        </Box>
      ) : null}
      <Box paddingX={1}>
        <InputBox
          disabled={!!inflight || heartbeatInflight.current}
          onSubmit={handleSubmit}
          onSuggestionsChange={(m, s) => {
            setSlashMatches(m);
            setSlashSelected(s);
          }}
        />
      </Box>
      <HintLine mode={mode} thinkingVerb={thinkingVerb} />
      <StatusLine
        profile={ctx.profile}
        provider={ctx.provider}
        model={ctx.model}
        handle={ctx.handle}
      />
    </Box>
  );
}

function renderHelp(): string {
  return [
    'slash commands:',
    '  /help, /?          this list',
    '  /profiles          list local agent profiles',
    '  /switch <name>     prints command to re-run with different profile',
    '  /clear             clear the visible scrollback',
    '  /exit, /quit       leave',
    '',
    'things to ask in plain language:',
    '  "what\'s on my feed?"                agent reads recent feed',
    '  "post something about X"             agent decides whether to post',
    '  "switch to claude-sonnet-4-6"        agent calls setModel',
    '  "cadence every 2 hours"              agent calls setCadence',
    '  "remember my name is X"              agent calls rememberFact',
    '',
    'CLI subcommands in another terminal:',
    '  krawler --profile <name>    open chat for a different profile',
    '  krawler status              identity + config, no cycles',
    '  krawler heartbeat           fire one heartbeat',
    '  krawler logs                tail activity log',
  ].join('\n');
}


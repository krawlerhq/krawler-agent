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
import type { AgentRegistry } from '../agents-registry.js';

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
  // Null when the primary is the personal agent (mode === 'personal').
  // The boot-diagnostic + idle-heartbeat paths both guard on this.
  krawler: KrawlerClient | null;
  driver: Omit<DriverDeps, 'system'>;
  system: string;
  registry: AgentRegistry;
}

export function App({ ctx, krawler, driver, system, registry }: Props): React.ReactElement {
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

  // Memoise the mentionables list we hand to InputBox. Without this,
  // the inline .map() in JSX creates a new array every render,
  // invalidating InputBox's useMemo on matches, which fires its
  // onSuggestionsChange useEffect, which setState's here, which
  // re-renders, which recreates the array — an infinite loop. 0.7.0
  // shipped with this bug; pin the reference so the effect only fires
  // when the actual handles change.
  const inputMentionables = useMemo(
    () => ctx.mentionables.map((m) => ({ handle: m.handle, displayName: m.displayName })),
    [ctx.mentionables],
  );

  // Keep the in-flight ref in sync so driver callbacks can mutate it
  // without stale-closure issues.
  useEffect(() => {
    inflightRef.current = inflight;
  }, [inflight]);

  useInput(() => {
    lastActivity.current = Date.now();
  });

  // Count recent consecutive cycles with no post. Surfaced in the
  // heartbeat outcome line when setup is still stuck at 4/5, so the
  // human sees "N cycles and still no first post" rather than just a
  // sequence of terse skip lines. Reset whenever any post lands.
  const consecutiveNoPostCycles = useRef<number>(0);

  // Parse runHeartbeat's free-form summary into structured bits so we
  // can render a friendly one-line outcome. The upstream summary format
  // is `posts=N endorsements=N follows=N[ skip="..."]`. Stable enough
  // to regex, and any new fields we don't recognise fall through as
  // extra text.
  function parseSummary(summary: string): { posts: number; endorses: number; follows: number; skipReason: string | null } {
    const m = summary.match(/posts=(\d+)\s+endorsements=(\d+)\s+follows=(\d+)(?:\s+skip="([^"]*)")?/);
    if (!m) return { posts: 0, endorses: 0, follows: 0, skipReason: null };
    return {
      posts: Number(m[1] ?? 0),
      endorses: Number(m[2] ?? 0),
      follows: Number(m[3] ?? 0),
      skipReason: m[4] || null,
    };
  }

  // Idle-heartbeat ticker. Network agents only — the personal agent
  // has no scheduled cycle to fire (no Krawler handle, no post/follow).
  useEffect(() => {
    if (ctx.mode !== 'network') return;
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
        // Render a readable outcome line. When the cycle skipped posting,
        // track consecutive-skip count so we can nudge after a few.
        const s = parseSummary(summary);
        if (s.posts === 0) consecutiveNoPostCycles.current++;
        else consecutiveNoPostCycles.current = 0;

        let line: string;
        if (s.posts > 0 || s.endorses > 0 || s.follows > 0) {
          const bits: string[] = [];
          if (s.posts) bits.push(`posted ${s.posts}`);
          if (s.endorses) bits.push(`endorsed ${s.endorses}`);
          if (s.follows) bits.push(`followed ${s.follows}`);
          line = `❯ cycle done · ${bits.join(', ')}`;
        } else if (s.skipReason) {
          line = `❯ cycle skipped · "${s.skipReason}"`;
        } else {
          // Edge case: no actions + no skip reason. Probably dry-run.
          line = `❯ cycle done · no actions`;
        }
        pushSystem(line);

        // After 3 consecutive no-post cycles, surface a nudge so the
        // human doesn't sit wondering why the setup page won't move.
        if (consecutiveNoPostCycles.current === 3) {
          pushSystem(
            `💡 3 cycles in a row chose not to post. Try prompting your agent directly ("post about X") or /post to force one.`,
          );
        }
      } catch (e) {
        pushSystem(`❯ cycle failed · ${(e as Error).message}`);
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

  // Boot diagnostic. Fetch the setup checklist once on mount and, if
  // anything's pending, surface a single dim hint line in the chat log
  // BEFORE the first greeting. Fully-green setups see no extra output.
  //
  // The diagnostic uses the public /agents/:handle/setup endpoint
  // (no auth), so it works even when the local agent key is 401.
  // A network / parse failure here is swallowed; a broken diagnostic
  // should never block the chat from opening.
  useEffect(() => {
    if (ctx.mode !== 'network' || !ctx.handle || !krawler) return;
    const handle = ctx.handle;
    const client = krawler;
    let cancelled = false;
    (async () => {
      try {
        const s = await client.getSetupChecklist(handle);
        if (cancelled) return;
        const c = s.checklist;
        const allIdentity = c.handleClaimed && c.nameChosen && c.bioWritten && c.avatarPicked;
        // Most common remaining-pending case for 0.6+ users: identity
        // is done (instant-identity at spawn) but the agent hasn't run
        // a cycle that posted anything yet. The setup page sits on 4/5
        // until the first post lands.
        if (allIdentity && !c.firstPost) {
          pushSystem(
            `💡 setup is at 4/5 · first post hasn't landed yet. The idle-heartbeat fires after 45s of quiet and will try. Or run /post to force one now.`,
          );
          return;
        }
        if (!allIdentity && c.handleClaimed) {
          // Identity is partly claimed but not fully; server-side the
          // page shows the yellow "waiting" banner. Tell the human
          // where to look.
          pushSystem(
            `💡 identity still partially pending · details at https://krawler.com/agent-setup/?handle=${encodeURIComponent(handle)}`,
          );
          return;
        }
        // All green (firstPost = true). Say nothing.
      } catch {
        // Silent — diagnostic is a nicety, not a blocker.
      }
    })();
    return () => { cancelled = true; };
  }, [ctx.handle, krawler]);

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
    if (line === '/post') {
      if (ctx.mode !== 'network') {
        pushSystem('`/post` only works when chatting AS a Krawler network agent. Try `@<handle> post about X` to route through one of your network agents, or `krawler --profile <name>` to open that agent directly.');
        return;
      }
      if (heartbeatInflight.current) {
        pushSystem('another cycle is already in flight — wait for it');
        return;
      }
      heartbeatInflight.current = true;
      setMode('heartbeat');
      pushSystem('❯ forcing a post (dry-run off, cap 1)…');
      try {
        const { postNow } = await import('../../loop.js');
        const { summary } = await postNow();
        const s = parseSummary(summary);
        if (s.posts > 0) {
          pushSystem(`❯ posted ✓ · check your agent on krawler.com`);
          consecutiveNoPostCycles.current = 0;
        } else if (s.skipReason) {
          pushSystem(`❯ model chose not to post · "${s.skipReason}". Try prompting directly ("post about X").`);
        } else {
          pushSystem(`❯ no post made · ${summary}`);
        }
      } catch (e) {
        pushSystem(`❯ /post failed: ${(e as Error).message}`);
      }
      heartbeatInflight.current = false;
      lastActivity.current = Date.now();
      setMode('idle');
      return;
    }
    if (heartbeatInflight.current) {
      pushSystem('hold on, finishing a heartbeat first');
      return;
    }

    // @-handle routing. One turn can be addressed to any of the
    // mentionable agents (other profiles on this machine). The match
    // is case-insensitive; the rest of the line becomes the user
    // message, unprefixed. Unknown handles fail closed with a
    // friendly list of the handles this human actually has.
    let targetHandle: string | null = null;
    let effectiveLine = line;
    const atMatch = /^@(\S+)(?:\s+(.*))?$/.exec(line);
    if (atMatch) {
      const requested = (atMatch[1] ?? '').toLowerCase();
      const body = (atMatch[2] ?? '').trim();
      const match = ctx.mentionables.find((m) => m.handle.toLowerCase() === requested);
      if (!match) {
        const known = ctx.mentionables.map((m) => `@${m.handle}`).join(', ');
        pushSystem(
          known
            ? `no agent @${atMatch[1]} — your agents here: ${known}`
            : `no agent @${atMatch[1]} — you haven't spawned any other agents on this machine yet. mint one at https://krawler.com/agents/ then re-open chat.`,
        );
        return;
      }
      if (!body) {
        pushSystem(`say something after @${match.handle}`);
        return;
      }
      targetHandle = match.handle;
      effectiveLine = body;
    }

    const userMsg: ChatMessage = targetHandle
      ? { id: newId(), role: 'user', content: effectiveLine, targetHandle }
      : { id: newId(), role: 'user', content: effectiveLine };
    // Show the user bubble with its original `@handle body` phrasing so
    // the human sees what they typed. The model only sees `body` though.
    const displayedUserLine = targetHandle ? `@${targetHandle} ${effectiveLine}` : effectiveLine;
    pushUser(displayedUserLine);
    // Primary-agent turns persist to the primary profile's chat.jsonl.
    // @-routed turns are session-ephemeral in Phase 1: routed replies
    // aren't in the primary's history (confuses the primary's context)
    // and we haven't wired cross-profile appends yet. When the human
    // reopens chat, sidebars are gone — that matches the "turn-scoped"
    // contract the routing was designed around.
    if (!targetHandle) {
      appendTurn({ role: 'user', content: effectiveLine, ts: new Date().toISOString() }, ctx.historyPath);
    }

    // Build the model messages list. Primary agent: full history from
    // chat.jsonl. Secondary agent: just this one user turn (sidebar is
    // stateless in Phase 1).
    const modelMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (!targetHandle) {
      const history = loadRecentTurns(ctx.historyPath);
      for (const t of history.slice(0, -1)) {
        modelMessages.push({ role: t.role, content: t.content });
      }
    }
    modelMessages.push({ role: 'user', content: effectiveLine });

    // Pick the right driver + system prompt. Primary uses the ones
    // already cached on mount. Secondaries build the system prompt
    // lazily on first address so boot-time cost stays constant.
    let turnDeps: DriverDeps = assistantDeps;
    if (targetHandle) {
      const entry = registry.byHandle[targetHandle];
      if (!entry) {
        pushSystem(`agent @${targetHandle} vanished — registry desync`);
        return;
      }
      let sys: string;
      try {
        sys = await entry.buildSystem();
      } catch (e) {
        pushSystem(`could not build @${targetHandle} system prompt: ${(e as Error).message}`);
        return;
      }
      turnDeps = { ...entry.driver, system: sys };
    }

    const assistantId = newId();
    const starter: ChatMessage = targetHandle
      ? { id: assistantId, role: 'assistant', segments: [], sourceHandle: targetHandle }
      : { id: assistantId, role: 'assistant', segments: [] };
    setInflight(starter);
    setThinkingVerb(pickVerb());
    setMode('thinking');
    chatInflight.current = true;

    await runTurn(turnDeps, modelMessages, {
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
        // Skip persisting @-routed replies to the primary's chat.jsonl
        // (see the matching skip on user turn above).
        if (fullText.trim().length > 0 && !targetHandle) {
          appendTurn({ role: 'assistant', content: fullText, ts: new Date().toISOString() }, ctx.historyPath);
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

  // The agent you're chatting WITH. Network mode shows "@handle ·
  // DisplayName"; personal mode shows the personal agent's name
  // (default "krawler") with no handle because it has none.
  const agentLabel = ctx.mode === 'personal'
    ? (ctx.displayName ?? 'krawler')
    : (ctx.displayName ? `@${ctx.handle} · ${ctx.displayName}` : `@${ctx.handle}`);
  // The human logging in. Falls through to a generic greeting when we
  // have no record of their name in memory.md.
  const welcomeTitle = ctx.userName ? `welcome back, ${ctx.userName}` : 'welcome back';
  const homePath = ctx.historyPath.replace(process.env.HOME ?? '', '~');

  return (
    <Box flexDirection="column">
      <Banner version={ctx.version} subtitle={ctx.greeting} />

      <WelcomeCard
        title={welcomeTitle}
        rows={[
          { label: 'agent', value: agentLabel, color: theme.brand },
          { label: 'model', value: `${ctx.provider}/${ctx.model}`, color: theme.accent },
          ...(ctx.mode === 'network'
            ? [{ label: 'profile', value: ctx.profile }]
            : []),
          { label: 'history', value: homePath },
          ...(ctx.mentionables.length > 0
            ? [{
                label: ctx.mode === 'personal' ? 'network' : 'also here',
                value: ctx.mentionables.map((m) => `@${m.handle}`).join(', ') + ' · type @ to address',
                color: theme.dim,
              }]
            : []),
          { label: 'tips', value: 'type /help for commands · plain english for actions' },
        ]}
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
          mentionables={inputMentionables}
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
    '  /post              force one post now (overrides dry-run, cap 1)',
    '  /profiles          list local agent profiles',
    '  /switch <name>     prints command to re-run with different profile',
    '  /clear             clear the visible scrollback',
    '  /exit, /quit       leave',
    '',
    '@-tagging (route one turn to another agent you spawned):',
    '  @<handle> <message>      route this turn only — next message without @',
    '                           goes back to your primary agent',
    '  type @ to see an autocomplete list of your agents',
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


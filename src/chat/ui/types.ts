// Shared types for the Ink chat UI. A single assistant "turn"
// interleaves text chunks and tool calls, so we model it as an
// ordered segment list. User turns are just text.

export type ToolStatus = 'running' | 'ok' | 'failed';

export interface ToolEvent {
  id: string;
  name: string;
  thought: string;
  status: ToolStatus;
  outcome?: string;
}

export type AssistantSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; event: ToolEvent };

export type ChatMessage =
  | { id: string; role: 'user'; content: string; targetHandle?: string }
  | { id: string; role: 'assistant'; segments: AssistantSegment[]; sourceHandle?: string }
  | { id: string; role: 'system'; content: string };

export interface HarnessContext {
  version: string;
  settingsUrl: string | null;
  profile: string;
  krawlerBaseUrl: string;
  provider: string;
  model: string;
  // Chat mode. `personal` = user's local general-purpose agent (no
  // network handle, no Krawler tools). `network` = one of the user's
  // spawned Krawler identities, addressed by running --profile or by
  // the secondary driver of a @-tag routing. Drives a few UI choices:
  // welcome-card handle row shown only in network mode, idle-heartbeat
  // gated off in personal mode.
  mode: 'personal' | 'network';
  // Agent identity: who the human is chatting WITH. These are the
  // agent's persona on krawler.com (its handle, its display name),
  // not the human's identity. UI strings that refer to "you" should
  // use userName below, not displayName.
  handle: string | null;
  displayName: string | null;
  // Best-effort human name, read from memory.md's `## name` fact when
  // present. Null when we have no record of who the human is. The
  // welcome card uses this to greet the HUMAN, not the agent.
  userName: string | null;
  historyPath: string;
  greeting: string;
  // Other agents the human can @-tag to route one turn to. The primary
  // agent (handle above) is NOT in this list — it's the default voice.
  // Empty when the user only has one profile. Used by InputBox for
  // autocomplete and by App.handleSubmit for routing lookup.
  mentionables: Array<{ handle: string; displayName: string | null; profile: string }>;
  // User-level auth identity. Populated when ~/.config/krawler-agent/
  // auth.json exists and GET /cli/whoami validated it at boot. Null
  // otherwise; the human can type /login to sign in. Personal chat
  // continues to work either way — this is advisory, not gating.
  userAuth: { email: string; id: string } | null;
}

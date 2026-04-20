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
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; segments: AssistantSegment[] }
  | { id: string; role: 'system'; content: string };

export interface HarnessContext {
  version: string;
  settingsUrl: string | null;
  profile: string;
  krawlerBaseUrl: string;
  provider: string;
  model: string;
  // Agent identity: who the human is chatting WITH. These are the
  // agent's persona on krawler.com (its handle, its display name),
  // not the human's identity. UI strings that refer to "you" should
  // use userName below, not displayName.
  handle: string;
  displayName: string | null;
  // Best-effort human name, read from memory.md's `## name` fact when
  // present. Null when we have no record of who the human is. The
  // welcome card uses this to greet the HUMAN, not the agent.
  userName: string | null;
  historyPath: string;
  greeting: string;
}

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
  handle: string;
  displayName: string | null;
  historyPath: string;
  greeting: string;
}

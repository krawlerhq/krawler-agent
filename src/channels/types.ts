// Channel adapter contract. Every channel (Discord, WhatsApp, Telegram, ...)
// implements ChannelPlugin — a bag of optional capability adapters. See
// design.md §4.
//
// Shape borrowed from OpenClaw's proven adapter-bag pattern, trimmed to what
// v1.0 needs. Grow adapters as new channels land.

export type ChannelId = 'discord' | 'whatsapp' | 'telegram' | 'cli' | 'cron';

export interface NormalisedInbound {
  channel: ChannelId;
  // Which of the agent's accounts on this channel received the message. For
  // Discord this is the bot application id; for WhatsApp a phone number;
  // for CLI it is a constant.
  accountId: string;
  peer: { id: string; handle?: string; displayName?: string };
  // Thread / topic / DM. Absent for top-level DMs.
  thread?: { id: string; parentId?: string };
  guild?: { id: string; name?: string };
  body: string;
  attachments: Attachment[];
  receivedAt: number;
  // Channel-specific blob for escape hatches (raw Discord message, raw
  // Baileys node). Not persisted.
  raw: unknown;
}

export interface Attachment {
  id: string;
  kind: 'image' | 'audio' | 'file';
  url: string;
  contentType?: string;
  bytes?: number;
  name?: string;
}

export interface SessionEnvelope {
  sessionKey: string;
  channel: ChannelId;
  accountId: string;
  peerId: string;
  threadId?: string;
  guildId?: string;
}

export type OutboundPayload =
  | { kind: 'text'; text: string }
  | { kind: 'approval-request'; approvalId: string; capability: string; description: string };

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ChannelRuntimeAdapter {
  onInbound(handler: (event: NormalisedInbound) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ChannelOutboundAdapter {
  send(envelope: SessionEnvelope, payload: OutboundPayload): Promise<SendResult>;
}

export interface ChannelDoctorReport {
  ok: boolean;
  issues: string[];
  details?: Record<string, unknown>;
}

export interface ChannelPlugin {
  id: ChannelId;
  meta: { label: string; maturity: 'primary' | 'beta' | 'experimental' };

  boot?(): Promise<void>;
  shutdown?(): Promise<void>;

  runtime: ChannelRuntimeAdapter;
  outbound: ChannelOutboundAdapter;

  doctor?(): Promise<ChannelDoctorReport>;
}

// A hook the gateway hands to each channel plugin so inbound events can drive
// a turn without every plugin having to import the planner directly.
export type InboundHandler = (event: NormalisedInbound) => Promise<void>;

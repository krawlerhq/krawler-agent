// Discord channel runtime. Wraps discord.js Client, normalises inbound
// messages, handles button interactions for approvals, and provides outbound
// send(envelope, payload).

import {
  ChannelType, Client, Events, GatewayIntentBits, Partials,
  type Interaction, type Message,
} from 'discord.js';

import { resolveApproval } from '../../approvals.js';
import type {
  ChannelOutboundAdapter, ChannelRuntimeAdapter, InboundHandler,
  NormalisedInbound, OutboundPayload, SendResult, SessionEnvelope,
} from '../types.js';
import { buildApprovalRow, decisionAck, parseCustomId } from './approvals.js';
import { chunkText } from './chunking.js';

interface DiscordClientOpts {
  botToken: string;
  // Filter: if set, ignore messages from guilds not in this list.
  guildAllowlist?: string[];
}

export class DiscordRuntime implements ChannelRuntimeAdapter, ChannelOutboundAdapter {
  private client: Client | null = null;
  private handler: InboundHandler | null = null;
  private started = false;

  constructor(private readonly opts: DiscordClientOpts) {}

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on(Events.MessageCreate, (m) => {
      this.onMessage(m).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[discord] onMessage error:', (e as Error).message);
      });
    });
    client.on(Events.InteractionCreate, (i) => {
      this.onInteraction(i).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[discord] onInteraction error:', (e as Error).message);
      });
    });

    await client.login(this.opts.botToken);
    this.client = client;
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    await this.client.destroy();
    this.client = null;
    this.started = false;
  }

  accountId(): string {
    return this.client?.user?.id ?? '';
  }

  async send(envelope: SessionEnvelope, payload: OutboundPayload): Promise<SendResult> {
    if (!this.client) return { ok: false, error: 'discord not started' };
    if (!envelope.threadId) return { ok: false, error: 'envelope missing threadId (channel target)' };
    const target = await this.resolveSendable(envelope.threadId, envelope.peerId);
    if (!target) return { ok: false, error: 'channel not resolvable or not sendable' };

    if (payload.kind === 'text') {
      const chunks = chunkText(payload.text, 2000);
      let lastId: string | undefined;
      for (const chunk of chunks) {
        const msg = await target.send(chunk);
        lastId = msg.id;
      }
      return { ok: true, messageId: lastId };
    }

    if (payload.kind === 'approval-request') {
      const row = buildApprovalRow(payload.approvalId);
      const msg = await target.send({
        content:
          `Approval needed:\n` +
          `**${payload.description}**\n` +
          `Capability: \`${payload.capability}\``,
        components: [row],
      });
      return { ok: true, messageId: msg.id };
    }

    return { ok: false, error: 'unknown payload kind' };
  }

  // Returns something that has a .send() method or null. Narrowed via a
  // duck-type check because discord.js's TextBasedChannel union includes
  // PartialGroupDMChannel (no send) and the unions don't project cleanly.
  private async resolveSendable(channelId: string, peerIdFallback?: string): Promise<Sendable | null> {
    if (!this.client) return null;
    try {
      const ch = await this.client.channels.fetch(channelId);
      if (ch && isSendable(ch)) return ch;
    } catch { /* fall through */ }
    // DM fallback: if the stored threadId is stale (common after bot restarts)
    // open a fresh DM with the peer.
    if (peerIdFallback) {
      try {
        const user = await this.client.users.fetch(peerIdFallback);
        const dm = await user.createDM();
        if (isSendable(dm)) return dm;
      } catch { /* ignore */ }
    }
    return null;
  }

  private async onMessage(m: Message): Promise<void> {
    if (!this.client || !this.client.user) return;
    if (m.author.bot) return;

    // v1.0 behaviour: always respond in DMs; in guild channels, only when the
    // bot is mentioned. Grows with channel maturity.
    const isDm = m.channel.type === ChannelType.DM;
    const mentioned = m.mentions.has(this.client.user.id);
    if (!isDm && !mentioned) return;

    if (m.guild && this.opts.guildAllowlist?.length) {
      if (!this.opts.guildAllowlist.includes(m.guild.id)) return;
    }

    const body = stripMention(m.content, this.client.user.id).trim();
    if (!body && m.attachments.size === 0) return;

    const thread = (m.channel.type === ChannelType.PublicThread || m.channel.type === ChannelType.PrivateThread)
      ? { id: m.channelId, parentId: 'parentId' in m.channel ? (m.channel.parentId ?? undefined) : undefined }
      : { id: m.channelId };

    const inbound: NormalisedInbound = {
      channel: 'discord',
      accountId: this.client.user.id,
      peer: {
        id: m.author.id,
        handle: m.author.username,
        displayName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
      },
      thread,
      guild: m.guildId ? { id: m.guildId, name: m.guild?.name } : undefined,
      body,
      attachments: Array.from(m.attachments.values()).map((a) => ({
        id: a.id,
        kind: attachmentKind(a.contentType),
        url: a.url,
        contentType: a.contentType ?? undefined,
        bytes: a.size,
        name: a.name ?? undefined,
      })),
      receivedAt: m.createdTimestamp,
      raw: m,
    };
    if (this.handler) await this.handler(inbound);
  }

  private async onInteraction(i: Interaction): Promise<void> {
    if (!i.isButton()) return;
    const parsed = parseCustomId(i.customId);
    if (!parsed) return;
    const ok = resolveApproval(parsed.approvalId, parsed.decision);
    try {
      await i.reply({
        content: ok ? decisionAck(parsed.decision) : 'This approval was already resolved or expired.',
        ephemeral: true,
      });
    } catch { /* ignore reply failures (race with other handlers) */ }
  }
}

function stripMention(text: string, botId: string): string {
  const mention = `<@${botId}>`;
  const mentionNick = `<@!${botId}>`;
  return text.replaceAll(mention, '').replaceAll(mentionNick, '');
}

function attachmentKind(contentType: string | null | undefined): 'image' | 'audio' | 'file' {
  if (!contentType) return 'file';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

interface Sendable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(payload: any): Promise<{ id: string }>;
}

function isSendable(x: unknown): x is Sendable {
  return typeof (x as { send?: unknown })?.send === 'function';
}

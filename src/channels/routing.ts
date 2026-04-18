// Route an inbound event to a deterministic session_key and persist the
// envelope so outbound replies go to the right (account, peer, thread).
//
// See design.md §4.2.

import { getDb } from '../db.js';
import { deterministicSessionKey } from '../id.js';
import type { NormalisedInbound, SessionEnvelope } from './types.js';

export function resolveRoute(event: NormalisedInbound): SessionEnvelope {
  const sessionKey = deterministicSessionKey({
    channel: event.channel,
    accountId: event.accountId,
    peerId: event.peer.id,
    threadId: event.thread?.id,
  });
  const envelope: SessionEnvelope = {
    sessionKey,
    channel: event.channel,
    accountId: event.accountId,
    peerId: event.peer.id,
    threadId: event.thread?.id,
    guildId: event.guild?.id,
  };
  persistEnvelope(envelope);
  return envelope;
}

export function getEnvelope(sessionKey: string): SessionEnvelope | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT session_key as sessionKey, channel, account_id as accountId,
            peer_id as peerId, thread_id as threadId, guild_id as guildId
     FROM session_envelope WHERE session_key = ?`,
  ).get(sessionKey) as SessionEnvelope | undefined;
  return row ?? null;
}

function persistEnvelope(e: SessionEnvelope): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO session_envelope
       (session_key, channel, account_id, peer_id, thread_id, guild_id, first_seen, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET last_active = excluded.last_active`,
  ).run(e.sessionKey, e.channel, e.accountId, e.peerId, e.threadId ?? null, e.guildId ?? null, now, now);
}

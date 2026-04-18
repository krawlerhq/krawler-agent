import { ulid } from 'ulid';

// All identifiers are ULIDs. Time-sorted, 26-char Crockford base32, no dashes.
// Prefix per entity so a stray id in a log tells you what it points at.

export const newTurnId    = () => `t_${ulid()}`;
export const newToolCallId = () => `c_${ulid()}`;
export const newOutcomeId = () => `o_${ulid()}`;
export const newFactId    = () => `f_${ulid()}`;
export const newProjectId = () => `p_${ulid()}`;
export const newThreadId  = () => `h_${ulid()}`;
export const newEntityId  = () => `e_${ulid()}`;
export const newClaimId   = () => `l_${ulid()}`;
export const newApprovalId = () => `a_${ulid()}`;
export const newSessionKey = () => `s_${ulid()}`;

// Deterministic session key derived from channel routing fields. Used by
// resolveRoute so inbound events from the same (channel, account, peer,
// thread) land in the same session.
export function deterministicSessionKey(parts: {
  channel: string;
  accountId: string;
  peerId: string;
  threadId?: string;
}): string {
  const raw = `${parts.channel}:${parts.accountId}:${parts.peerId}:${parts.threadId ?? ''}`;
  // Simple non-cryptographic hash: 64-bit FNV-1a, base32-ish hex. Stable and
  // short. No need for collision resistance at the scale of one user's
  // session envelopes.
  let h1 = 0xcbf29ce4n;
  let h2 = 0x84222325n;
  for (let i = 0; i < raw.length; i++) {
    const c = BigInt(raw.charCodeAt(i));
    h1 = BigInt.asUintN(32, (h1 ^ c) * 0x01000193n);
    h2 = BigInt.asUintN(32, (h2 ^ c) * 0x01000193n);
  }
  return `s_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

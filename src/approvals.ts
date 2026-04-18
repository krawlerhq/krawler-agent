// Approval queue. When a tool call needs a capability the agent does not
// currently hold, we insert an `approval` row and an async waiter awaits the
// user's decision. The channel adapter (Discord in v1.0) renders inline UI
// that flips the row from pending to resolved.
//
// Approvals are per-grain, one-shot by default. An "always" decision writes
// a new CapabilityToken so the grain does not ask again.

import { grantToken } from './capabilities.js';
import { getDb } from './db.js';
import { newApprovalId } from './id.js';

export type ApprovalDecision = 'approve-once' | 'approve-always' | 'deny';

export interface ApprovalRequest {
  id: string;
  turnId?: string;
  toolCallId?: string;
  capability: string;
  description: string;
  channel: string;
  peerId?: string;
}

export interface ApprovalRecord extends ApprovalRequest {
  createdAt: number;
  resolvedAt: number | null;
  decision: ApprovalDecision | null;
  always: boolean;
}

const waiters = new Map<string, {
  resolve: (d: ApprovalDecision) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}>();

// Default 10 minutes. Channels can override at request time.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function createApproval(req: Omit<ApprovalRequest, 'id'>, timeoutMs = DEFAULT_TIMEOUT_MS): {
  id: string;
  done: Promise<ApprovalDecision>;
} {
  const id = newApprovalId();
  const db = getDb();
  db.prepare(
    `INSERT INTO approval (id, turn_id, tool_call_id, capability, description, channel, peer_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    req.turnId ?? null,
    req.toolCallId ?? null,
    req.capability,
    req.description,
    req.channel,
    req.peerId ?? null,
    Date.now(),
  );

  const done = new Promise<ApprovalDecision>((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          const w = waiters.get(id);
          if (!w) return;
          waiters.delete(id);
          resolveRow(id, 'deny', false);
          resolve('deny');
        }, timeoutMs)
      : null;
    waiters.set(id, { resolve, reject, timer });
  });

  return { id, done };
}

export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const w = waiters.get(id);
  if (!w) {
    // No in-memory waiter (e.g. after a restart). Still persist the decision
    // if the row is unresolved, so the dashboard sees the outcome.
    return persistStandaloneDecision(id, decision);
  }
  const always = decision === 'approve-always';
  const row = resolveRow(id, decision, always);
  if (row && decision === 'approve-always') {
    grantToken({
      capability: row.capability,
      source: 'approval',
      note: row.description,
    });
  }
  if (w.timer) clearTimeout(w.timer);
  waiters.delete(id);
  w.resolve(decision);
  return true;
}

export function cancelApproval(id: string): boolean {
  const w = waiters.get(id);
  if (!w) return false;
  if (w.timer) clearTimeout(w.timer);
  waiters.delete(id);
  resolveRow(id, 'deny', false);
  w.reject(new Error('approval cancelled'));
  return true;
}

export function listPendingApprovals(): ApprovalRecord[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, turn_id as turnId, tool_call_id as toolCallId, capability, description,
            channel, peer_id as peerId, created_at as createdAt, resolved_at as resolvedAt,
            decision, always
     FROM approval
     WHERE resolved_at IS NULL
     ORDER BY created_at`,
  ).all() as Array<{
    id: string; turnId: string | null; toolCallId: string | null;
    capability: string; description: string; channel: string; peerId: string | null;
    createdAt: number; resolvedAt: number | null; decision: string | null; always: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    turnId: r.turnId ?? undefined,
    toolCallId: r.toolCallId ?? undefined,
    capability: r.capability,
    description: r.description,
    channel: r.channel,
    peerId: r.peerId ?? undefined,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    decision: (r.decision as ApprovalDecision | null) ?? null,
    always: r.always === 1,
  }));
}

function resolveRow(
  id: string,
  decision: ApprovalDecision,
  always: boolean,
): { capability: string; description: string } | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT capability, description, resolved_at FROM approval WHERE id = ?`,
  ).get(id) as { capability: string; description: string; resolved_at: number | null } | undefined;
  if (!row) return null;
  if (row.resolved_at !== null) return { capability: row.capability, description: row.description };
  db.prepare(
    `UPDATE approval SET resolved_at = ?, decision = ?, always = ? WHERE id = ?`,
  ).run(Date.now(), decision, always ? 1 : 0, id);
  return { capability: row.capability, description: row.description };
}

function persistStandaloneDecision(id: string, decision: ApprovalDecision): boolean {
  const always = decision === 'approve-always';
  const row = resolveRow(id, decision, always);
  if (!row) return false;
  if (always) {
    grantToken({
      capability: row.capability,
      source: 'approval',
      note: row.description,
    });
  }
  return true;
}

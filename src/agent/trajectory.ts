// Trajectory writers. Every inbound event becomes a `turn` row; nested tool
// calls become `tool_call` rows; outcome signals land in `outcome`. See
// design.md §1.2.

import { getDb } from '../db.js';
import { newOutcomeId, newToolCallId, newTurnId } from '../id.js';

export interface TurnInit {
  sessionKey: string;
  channel: string;
  peerId?: string;
  model: string;
  modelConfig: Record<string, unknown>;
  inboundText?: string;
  parentTurnId?: string;
  skillIds?: string[];
}

export function startTurn(init: TurnInit): string {
  const id = newTurnId();
  const db = getDb();
  db.prepare(
    `INSERT INTO turn (id, session_id, parent_id, channel, peer_id, started_at,
       model, model_config, inbound_text, status, skill_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    init.sessionKey,
    init.parentTurnId ?? null,
    init.channel,
    init.peerId ?? null,
    Date.now(),
    init.model,
    JSON.stringify(init.modelConfig),
    init.inboundText ?? null,
    'running',
    init.skillIds ? JSON.stringify(init.skillIds) : null,
  );
  return id;
}

export interface TurnFinish {
  outboundText?: string;
  tokensIn?: number;
  tokensOut?: number;
  status: 'ok' | 'error' | 'abandoned' | 'interrupted';
  error?: string;
  skillIds?: string[];
}

export function finishTurn(turnId: string, fin: TurnFinish): void {
  const db = getDb();
  const started = db.prepare(`SELECT started_at FROM turn WHERE id = ?`).get(turnId) as
    | { started_at: number }
    | undefined;
  const latency = started ? Date.now() - started.started_at : null;
  db.prepare(
    `UPDATE turn
       SET ended_at = ?, outbound_text = ?, tokens_in = ?, tokens_out = ?,
           latency_ms = ?, status = ?, error = ?,
           skill_ids = COALESCE(?, skill_ids)
     WHERE id = ?`,
  ).run(
    Date.now(),
    fin.outboundText ?? null,
    fin.tokensIn ?? null,
    fin.tokensOut ?? null,
    latency,
    fin.status,
    fin.error ?? null,
    fin.skillIds ? JSON.stringify(fin.skillIds) : null,
    turnId,
  );
}

export interface ToolCallInit {
  turnId: string;
  ordinal: number;
  tool: string;
  args: unknown;
}

export function startToolCall(init: ToolCallInit): string {
  const id = newToolCallId();
  const db = getDb();
  db.prepare(
    `INSERT INTO tool_call (id, turn_id, ordinal, tool, args, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, init.turnId, init.ordinal, init.tool, JSON.stringify(init.args ?? null), 'running');
  return id;
}

export interface ToolCallFinish {
  result?: unknown;
  status: 'ok' | 'error' | 'denied' | 'sandboxed-timeout';
  error?: string;
  approvalId?: string;
  startedAt: number;
}

export function finishToolCall(callId: string, fin: ToolCallFinish): void {
  const db = getDb();
  const resultJson = fin.result === undefined ? null : JSON.stringify(fin.result);
  const latency = Date.now() - fin.startedAt;
  db.prepare(
    `UPDATE tool_call
       SET result = ?, result_bytes = ?, latency_ms = ?, status = ?, error = ?, approval_id = ?
     WHERE id = ?`,
  ).run(
    resultJson,
    resultJson ? Buffer.byteLength(resultJson, 'utf8') : null,
    latency,
    fin.status,
    fin.error ?? null,
    fin.approvalId ?? null,
    callId,
  );
}

export function recordOutcome(input: {
  turnId?: string;
  toolCallId?: string;
  kind: string;
  value?: number;
  detail?: unknown;
  source: 'krawler' | 'channel' | 'critic' | 'user-reaction' | 'user-next-turn' | 'tool';
}): string {
  const id = newOutcomeId();
  const db = getDb();
  db.prepare(
    `INSERT INTO outcome (id, turn_id, tool_call_id, kind, value, detail, observed_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.turnId ?? null,
    input.toolCallId ?? null,
    input.kind,
    input.value ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    Date.now(),
    input.source,
  );
  return id;
}

// Small helpers for querying the store. Not an ORM; just convenience for the
// dashboard and `krawler trajectories` CLI.

export interface TurnRow {
  id: string;
  sessionId: string;
  parentId: string | null;
  channel: string;
  peerId: string | null;
  startedAt: number;
  endedAt: number | null;
  model: string;
  inboundText: string | null;
  outboundText: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  status: string;
  error: string | null;
  skillIds: string[];
}

export function listRecentTurns(opts: { limit?: number; sinceMs?: number } = {}): TurnRow[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 50));
  const rows = db.prepare(
    `SELECT id, session_id as sessionId, parent_id as parentId, channel, peer_id as peerId,
            started_at as startedAt, ended_at as endedAt, model, inbound_text as inboundText,
            outbound_text as outboundText, tokens_in as tokensIn, tokens_out as tokensOut,
            latency_ms as latencyMs, status, error, skill_ids as skillIds
     FROM turn
     WHERE started_at >= ?
     ORDER BY started_at DESC
     LIMIT ?`,
  ).all(opts.sinceMs ?? 0, limit) as Array<Omit<TurnRow, 'skillIds'> & { skillIds: string | null }>;
  return rows.map((r) => ({
    ...r,
    skillIds: r.skillIds ? (JSON.parse(r.skillIds) as string[]) : [],
  }));
}

// user_fact CRUD + supersede semantics. Each fact is a typed claim about the
// user with provenance (source_turn) and a confidence score. Facts are
// immutable once written; new information supersedes old via superseded_by,
// so the history is preserved and we can audit how the model's view
// evolved.
//
// See design.md §1.8.

import { getDb } from '../db.js';
import { newFactId } from '../id.js';

export const USER_FACT_KINDS = [
  'preference',   // "prefers short replies", "dislikes markdown in Discord"
  'relationship', // "works with @jane on krawler"
  'project',      // "working on the krawler-agent v1.0 harness"
  'profession',   // "founder, ERP.AI", "senior backend eng"
  'context',      // "in a different timezone", "on parental leave"
] as const;

export type UserFactKind = (typeof USER_FACT_KINDS)[number];

export interface UserFact {
  id: string;
  kind: UserFactKind;
  key: string;
  value: string;
  confidence: number;
  sourceTurn: string | null;
  firstSeen: number;
  lastSeen: number;
  supersededBy: string | null;
}

export interface UpsertFactInput {
  kind: UserFactKind;
  key: string;
  value: string;
  confidence: number;
  sourceTurn?: string;
}

// If an active fact with the same (kind, key) exists:
// - value matches: bump last_seen, pick max(confidence)
// - value differs: supersede old row, insert new
// Otherwise insert new.
//
// Returns the active UserFact after the operation.
export function upsertFact(input: UpsertFactInput): UserFact {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare(
    `SELECT id, kind, key, value, confidence, source_turn as sourceTurn,
            first_seen as firstSeen, last_seen as lastSeen,
            superseded_by as supersededBy
     FROM user_fact
     WHERE kind = ? AND key = ? AND superseded_by IS NULL
     ORDER BY last_seen DESC LIMIT 1`,
  ).get(input.kind, input.key) as UserFact | undefined;

  if (existing) {
    if (normalize(existing.value) === normalize(input.value)) {
      const nextConf = Math.max(existing.confidence, input.confidence);
      db.prepare(
        `UPDATE user_fact SET last_seen = ?, confidence = ? WHERE id = ?`,
      ).run(now, nextConf, existing.id);
      return { ...existing, lastSeen: now, confidence: nextConf };
    }
    // Value changed. Supersede the old, insert new.
    const id = newFactId();
    db.prepare(
      `INSERT INTO user_fact
         (id, kind, key, value, confidence, source_turn, first_seen, last_seen, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, input.kind, input.key, input.value, input.confidence, input.sourceTurn ?? null, now, now);
    db.prepare(
      `UPDATE user_fact SET superseded_by = ? WHERE id = ?`,
    ).run(id, existing.id);
    return {
      id, kind: input.kind, key: input.key, value: input.value,
      confidence: input.confidence, sourceTurn: input.sourceTurn ?? null,
      firstSeen: now, lastSeen: now, supersededBy: null,
    };
  }

  const id = newFactId();
  db.prepare(
    `INSERT INTO user_fact
       (id, kind, key, value, confidence, source_turn, first_seen, last_seen, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, input.kind, input.key, input.value, input.confidence, input.sourceTurn ?? null, now, now);
  return {
    id, kind: input.kind, key: input.key, value: input.value,
    confidence: input.confidence, sourceTurn: input.sourceTurn ?? null,
    firstSeen: now, lastSeen: now, supersededBy: null,
  };
}

export function listActiveFacts(opts: {
  kind?: UserFactKind;
  limit?: number;
  minConfidence?: number;
} = {}): UserFact[] {
  const db = getDb();
  const clauses: string[] = ['superseded_by IS NULL'];
  const params: unknown[] = [];
  if (opts.kind) {
    clauses.push('kind = ?');
    params.push(opts.kind);
  }
  if (typeof opts.minConfidence === 'number') {
    clauses.push('confidence >= ?');
    params.push(opts.minConfidence);
  }
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const rows = db.prepare(
    `SELECT id, kind, key, value, confidence, source_turn as sourceTurn,
            first_seen as firstSeen, last_seen as lastSeen,
            superseded_by as supersededBy
     FROM user_fact
     WHERE ${clauses.join(' AND ')}
     ORDER BY confidence DESC, last_seen DESC
     LIMIT ?`,
  ).all(...params, limit) as UserFact[];
  return rows;
}

export function grepFacts(pattern: string, opts: { limit?: number } = {}): UserFact[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const like = `%${pattern}%`;
  const rows = db.prepare(
    `SELECT id, kind, key, value, confidence, source_turn as sourceTurn,
            first_seen as firstSeen, last_seen as lastSeen,
            superseded_by as supersededBy
     FROM user_fact
     WHERE superseded_by IS NULL AND (key LIKE ? OR value LIKE ?)
     ORDER BY confidence DESC, last_seen DESC
     LIMIT ?`,
  ).all(like, like, limit) as UserFact[];
  return rows;
}

export function countActiveFacts(): number {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) as n FROM user_fact WHERE superseded_by IS NULL`,
  ).get() as { n: number };
  return row.n;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

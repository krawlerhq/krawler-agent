import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { CONFIG_DIR } from './config.js';
import { join } from 'node:path';

export const DB_PATH = join(CONFIG_DIR, 'state.db');

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (instance) return instance;
  if (!existsSync(dirname(DB_PATH))) {
    mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
  }
  const db = new Database(DB_PATH, { fileMustExist: false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  instance = db;
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// Schema is versioned via SQLite's user_version pragma. Each migration is a
// function that runs inside a transaction and bumps the pragma on success.
// Never edit an applied migration in place; add a new one.

const MIGRATIONS: Array<{ version: number; up: (db: Database.Database) => void }> = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1);
    },
  },
];

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }
}

// ---------------------------------------------------------------------------
// Schema v1. All tables designed in design.md §§1.2, 1.8, 2.4, 4.2, 6.2.
// ---------------------------------------------------------------------------

const SCHEMA_V1 = `
-- Trajectory: every inbound event creates a turn row; nested tool calls land
-- in tool_call; outcome signals (public or private) land in outcome.
CREATE TABLE turn (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  parent_id     TEXT,
  channel       TEXT NOT NULL,
  peer_id       TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  model         TEXT NOT NULL,
  model_config  TEXT NOT NULL,
  inbound_text  TEXT,
  inbound_ref   TEXT,
  outbound_text TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  latency_ms    INTEGER,
  status        TEXT NOT NULL,
  error         TEXT,
  skill_ids     TEXT
);

CREATE TABLE tool_call (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT NOT NULL REFERENCES turn(id),
  ordinal       INTEGER NOT NULL,
  tool          TEXT NOT NULL,
  args          TEXT NOT NULL,
  result        TEXT,
  result_bytes  INTEGER,
  latency_ms    INTEGER,
  status        TEXT NOT NULL,
  error         TEXT,
  approval_id   TEXT
);

CREATE TABLE outcome (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT REFERENCES turn(id),
  tool_call_id  TEXT REFERENCES tool_call(id),
  kind          TEXT NOT NULL,
  value         REAL,
  detail        TEXT,
  observed_at   INTEGER NOT NULL,
  source        TEXT NOT NULL
);

-- Lexical full-text search over turn inbound + outbound. Kept in sync with
-- turn via triggers below.
CREATE VIRTUAL TABLE turn_fts USING fts5(
  inbound_text,
  outbound_text,
  content='turn',
  content_rowid='rowid'
);

CREATE TRIGGER turn_fts_insert AFTER INSERT ON turn BEGIN
  INSERT INTO turn_fts(rowid, inbound_text, outbound_text)
    VALUES (NEW.rowid, NEW.inbound_text, NEW.outbound_text);
END;
CREATE TRIGGER turn_fts_delete AFTER DELETE ON turn BEGIN
  INSERT INTO turn_fts(turn_fts, rowid, inbound_text, outbound_text)
    VALUES ('delete', OLD.rowid, OLD.inbound_text, OLD.outbound_text);
END;
CREATE TRIGGER turn_fts_update AFTER UPDATE ON turn BEGIN
  INSERT INTO turn_fts(turn_fts, rowid, inbound_text, outbound_text)
    VALUES ('delete', OLD.rowid, OLD.inbound_text, OLD.outbound_text);
  INSERT INTO turn_fts(rowid, inbound_text, outbound_text)
    VALUES (NEW.rowid, NEW.inbound_text, NEW.outbound_text);
END;

-- Typed user model. Each fact/relationship/project/thread has provenance via
-- source_turn so we can audit the origin and replay fact extraction.
CREATE TABLE user_fact (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  confidence    REAL NOT NULL,
  source_turn   TEXT REFERENCES turn(id),
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  superseded_by TEXT REFERENCES user_fact(id)
);

CREATE TABLE user_relationship (
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  confidence  REAL NOT NULL,
  source_turn TEXT REFERENCES turn(id),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (subject, predicate, object)
);

CREATE TABLE user_project (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  state             TEXT NOT NULL,
  summary           TEXT,
  last_mention_turn TEXT REFERENCES turn(id),
  last_mention_at   INTEGER NOT NULL
);

CREATE TABLE user_thread (
  id              TEXT PRIMARY KEY,
  summary         TEXT NOT NULL,
  state           TEXT NOT NULL,
  project_id      TEXT REFERENCES user_project(id),
  last_touch      INTEGER NOT NULL,
  next_check_due  INTEGER
);

-- Lightweight entity graph for things the agent reads + reasons about
-- (projects, agents on krawler, tools, repos, papers).
CREATE TABLE entity (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  canonical   TEXT,
  embedding   BLOB,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE claim (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL REFERENCES entity(id),
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  confidence  REAL NOT NULL,
  source_turn TEXT REFERENCES turn(id),
  observed_at INTEGER NOT NULL
);

CREATE TABLE entity_alias (
  entity_id   TEXT NOT NULL REFERENCES entity(id),
  alias       TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias)
);

-- Approvals: when a tool call needs user consent, a row lands here and the
-- channel adapter renders inline UI for the user to accept/deny.
CREATE TABLE approval (
  id           TEXT PRIMARY KEY,
  turn_id      TEXT REFERENCES turn(id),
  tool_call_id TEXT REFERENCES tool_call(id),
  capability   TEXT NOT NULL,
  description  TEXT NOT NULL,
  channel      TEXT NOT NULL,
  peer_id      TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  decision     TEXT,
  always       INTEGER
);

-- Session envelope: deterministic mapping from (channel, account, peer,
-- thread) to a single session_key so every reply threads the right way.
CREATE TABLE session_envelope (
  session_key TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  peer_id     TEXT NOT NULL,
  thread_id   TEXT,
  guild_id    TEXT,
  first_seen  INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);

-- Cursor for polling /me/signals?since=. One row per signal source (krawler
-- is the only one in v1.0).
CREATE TABLE signal_cursor (
  source    TEXT PRIMARY KEY,
  since_iso TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_turn_session        ON turn(session_id, started_at);
CREATE INDEX idx_turn_channel        ON turn(channel, started_at);
CREATE INDEX idx_turn_parent         ON turn(parent_id);
CREATE INDEX idx_toolcall_turn       ON tool_call(turn_id, ordinal);
CREATE INDEX idx_outcome_turn        ON outcome(turn_id, observed_at);
CREATE INDEX idx_outcome_kind        ON outcome(kind, observed_at);
CREATE INDEX idx_user_fact_kind      ON user_fact(kind, key);
CREATE INDEX idx_user_fact_active    ON user_fact(kind, key) WHERE superseded_by IS NULL;
CREATE INDEX idx_entity_kind         ON entity(kind, name);
CREATE INDEX idx_claim_subject       ON claim(subject, predicate);
CREATE INDEX idx_approval_unresolved ON approval(resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_session_env_lookup  ON session_envelope(channel, account_id, peer_id, thread_id);
`;

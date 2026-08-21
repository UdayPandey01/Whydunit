import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
-- Every decision the agent makes, effectful or not. THIS IS THE AUDIT LOG.
CREATE TABLE IF NOT EXISTS audit_log (
  idempotency_key TEXT PRIMARY KEY,
  decided_at      TEXT NOT NULL,
  mandate_id      TEXT NOT NULL,
  cycle           TEXT NOT NULL,
  attempt_no      INTEGER NOT NULL,
  source_attempt  TEXT NOT NULL,
  cause           TEXT,
  confidence      REAL,
  action          TEXT NOT NULL,
  scheduled_at    TEXT,
  notification_at TEXT,
  checks_passed   TEXT NOT NULL,
  checks_failed   TEXT NOT NULL,
  checks_skipped  TEXT NOT NULL,
  status          TEXT NOT NULL,
  outcome         TEXT
);

-- Per-mandate-per-cycle runtime state. The intervention budget lives here and is
-- incremented in the SAME transaction that records the intent, so a crash can
-- never hand a mandate a fourth intervention.
CREATE TABLE IF NOT EXISTS cycle_state (
  mandate_id         TEXT NOT NULL,
  cycle              TEXT NOT NULL,
  interventions_used INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL,
  PRIMARY KEY (mandate_id, cycle)
);

-- Stands in for the PSP. In production this is someone else's database behind an
-- Idempotency-Key header; here it is a table whose PRIMARY KEY is that same key,
-- which buys the identical exactly-once guarantee. The row IS the side effect.
CREATE TABLE IF NOT EXISTS psp_ledger (
  idempotency_key TEXT PRIMARY KEY,
  mandate_id      TEXT NOT NULL,
  fired_at        TEXT NOT NULL,
  result          TEXT NOT NULL,
  blockers        TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  // WAL keeps readers off the writer's back; synchronous=FULL means a committed
  // transaction has reached the disk before we act on it, which is the whole
  // basis of the crash-resume argument.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(SCHEMA);
  return db;
}

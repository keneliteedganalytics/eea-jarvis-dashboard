-- Real (sportsbook) bets — Book Bets analytics. Ken's ACTUAL placed bets
-- (XBNet + Churchill book dump), independent of the Jarvis bet_legs ledger.
-- bet_id is the book's own identifier and is UNIQUE so a re-ingest upserts on
-- it. The runtime bootstrap in server/db.ts performs the same idempotent
-- CREATE TABLE IF NOT EXISTS so the table is present without a drizzle-kit push.
CREATE TABLE IF NOT EXISTS real_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id TEXT NOT NULL UNIQUE,
  placed_at TEXT NOT NULL,
  date TEXT NOT NULL,
  track TEXT NOT NULL,
  race INTEGER NOT NULL,
  bet_type TEXT NOT NULL,
  bet_subtype TEXT,
  wager_desc TEXT NOT NULL,
  base_amount REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL,
  payout REAL NOT NULL DEFAULT 0,
  result TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_real_bets_track ON real_bets(track);
CREATE INDEX IF NOT EXISTS idx_real_bets_date ON real_bets(date);

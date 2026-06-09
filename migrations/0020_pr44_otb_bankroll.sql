-- PR #44 — OTB auto-grader + bankroll ledger + race_results upsert/delete +
-- idempotent retier filtering scratches.
--
-- Most of this PR is code-level (server/services/otb-results.ts,
-- results-poller-cron.ts, bankroll.ts plus route handlers). The only new
-- persisted state is the bankroll ledger. The `results` table already carries a
-- UNIQUE(race_id) constraint and storage.logResult already upserts (delete +
-- insert), so no dedup/unique migration is needed there — the duplicate rows on
-- Card #9 are cleaned by the one-shot endpoint, not DDL.
--
-- The project bootstraps schema in server/db.ts (idempotent CREATE/ALTER); this
-- file is the explicit, reviewable forward migration for the same change.

-- Bankroll ledger: append-only per-card money ledger. Seeded with a +$1000
-- `card-start` event when a card is created; a `race-grade` event is appended on
-- each race grade (delta = leg payouts − leg costs).
CREATE TABLE IF NOT EXISTS bankroll_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  race_id INTEGER REFERENCES races(id) ON DELETE CASCADE,
  source TEXT NOT NULL,           -- 'race-grade' | 'manual-adjust' | 'card-start' | 'bet-placed'
  delta REAL NOT NULL,            -- positive = winnings, negative = stake
  running_balance REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bankroll_cardId ON bankroll_events(card_id);

-- Belt-and-suspenders: ensure race_id is unique on results so upsert holds even
-- on a DB that predates the UNIQUE constraint. (No-op where it already exists.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_raceId ON results(race_id);

-- Backtest snapshot harness — forward-looking, no-leakage ROI.
--
-- Historical entry data (M/L odds, jockey/trainer, PrimePower, speed figs, local
-- picks) is NOT retrievable from open web sources after the fact, so we must
-- backtest prospectively: persist the FULL pre-race state of a card at score
-- time, and only later attach actual outcomes. The scoring blob is sealed before
-- any race runs, which is what makes the eventual ROI free of look-ahead bias.
--
-- The project bootstraps schema in server/db.ts (idempotent CREATE/ALTER); this
-- file is the explicit, reviewable forward migration for the same change.

-- Frozen pre-race artifact: one row per (card_id, methodology_version). Re-
-- snapshotting the same pair upserts (the route deletes + re-inserts).
CREATE TABLE IF NOT EXISTS card_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  snapshot_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  methodology_version TEXT NOT NULL DEFAULT 'card10-v1', -- which scoring stack
  raw_data TEXT NOT NULL DEFAULT '{}',   -- entries, M/L odds, connections, figs
  scoring TEXT NOT NULL DEFAULT '{}',    -- per-race A/B/C/D + tier + bet + reason
  bankroll_allocated INTEGER NOT NULL DEFAULT 0, -- cents
  bankroll_cap INTEGER NOT NULL DEFAULT 0,       -- cents
  UNIQUE (card_id, methodology_version)
);
CREATE INDEX IF NOT EXISTS idx_card_snapshots_card ON card_snapshots(card_id);
CREATE INDEX IF NOT EXISTS idx_card_snapshots_method ON card_snapshots(methodology_version);

-- Actual outcomes, recorded AFTER the card runs. Kept separate from the snapshot
-- so the snapshot stays an untouched pre-race artifact.
CREATE TABLE IF NOT EXISTS card_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  race_num INTEGER NOT NULL,
  horse_id TEXT NOT NULL,         -- program number or horse name
  finish_position INTEGER,        -- nullable until known
  win_payout REAL,
  place_payout REAL,
  show_payout REAL,
  exacta_payout TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (card_id, race_num, horse_id)
);
CREATE INDEX IF NOT EXISTS idx_card_outcomes_card ON card_outcomes(card_id);

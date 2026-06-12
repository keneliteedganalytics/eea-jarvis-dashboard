-- Expert picks (Expert Picks Comparison). Third-party handicapper selections
-- (Racing Dudes, NYRA/Andy Serling, Churchill/Kevin Kilroy) scraped per
-- (track, date, race). The UNIQUE (track, date, race, source) constraint makes
-- a re-fetch upsert in place (idempotent). result/winner are filled later by
-- the reconcile endpoint once a race is official. The runtime bootstrap in
-- server/db.ts performs the same idempotent CREATE TABLE IF NOT EXISTS so the
-- table is present without a drizzle-kit push.
CREATE TABLE IF NOT EXISTS expert_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track TEXT NOT NULL,
  date TEXT NOT NULL,
  race INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_handicapper TEXT NOT NULL,
  top_pick INTEGER NOT NULL,
  picks_2_4 TEXT NOT NULL DEFAULT '[]',
  raw_text TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result TEXT,
  winner INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expert_picks_unique
  ON expert_picks(track, date, race, source);
CREATE INDEX IF NOT EXISTS idx_expert_picks_track_date ON expert_picks(track, date);

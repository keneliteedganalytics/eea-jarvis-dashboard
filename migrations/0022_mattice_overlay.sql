-- Mattice 5-factor overlay (PR #51).
--
-- Dave Mattice has been Finger Lakes' primary track handicapper since 2001. His
-- framework is five factors, each scored 0-20 by the overlay:
--   1. Pace & Running Styles — dueling speed vs lone pacesetter that can steal the lead
--   2. Speed Figures — lifetime top speeds + most recent figures to measure current form
--   3. Class Levels — dropping down (easier) vs stepping up where outmatched
--   4. Connections — recent success, win %, stats of jockeys and trainers
--   5. Form & Habits — recent results, workouts, excuse lines (bumped, off track)
--
-- "Let data earn the weight." The overlay starts as a tiebreak + veto only
-- (Phase 1) and logs every prediction here. The auto-promotion service reads the
-- graded win%/ROI and bumps the stored weight phase (1 -> 2 -> 3) as evidence
-- accumulates, demoting on decay. No score blending happens until Phase 2.

CREATE TABLE IF NOT EXISTS mattice_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  program_number TEXT NOT NULL,
  horse_name TEXT,
  mattice_score INTEGER NOT NULL DEFAULT 0,
  veto_flag INTEGER NOT NULL DEFAULT 0,
  factor_pace INTEGER NOT NULL DEFAULT 0,
  factor_speed INTEGER NOT NULL DEFAULT 0,
  factor_class INTEGER NOT NULL DEFAULT 0,
  factor_connections INTEGER NOT NULL DEFAULT 0,
  factor_form INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  is_system_pick INTEGER NOT NULL DEFAULT 0,
  is_mattice_top INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'deterministic',
  predicted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actual_finish INTEGER,
  won INTEGER,
  in_money INTEGER,
  graded_at TEXT,
  UNIQUE (card_id, race_id, program_number)
);
CREATE INDEX IF NOT EXISTS idx_mattice_predictions_card ON mattice_predictions(card_id);
CREATE INDEX IF NOT EXISTS idx_mattice_predictions_race ON mattice_predictions(race_id);

-- Mattice overlay config lives on the single-row settings table (no separate
-- system_config table in this schema). Phase 1 = tiebreak + veto only.
ALTER TABLE settings ADD COLUMN mattice_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN mattice_weight_phase INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN mattice_phase_changed_at TEXT;
ALTER TABLE settings ADD COLUMN mattice_phase_reason TEXT;

-- "Mattice Confirmed" badge on the race win pick (score >= 75, no veto).
ALTER TABLE races ADD COLUMN mattice_confirmed INTEGER NOT NULL DEFAULT 0;

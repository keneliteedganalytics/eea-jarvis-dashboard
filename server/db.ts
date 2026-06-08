import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

const sqlite = new Database(process.env.DATABASE_FILE || "data.db");
sqlite.pragma("journal_mode = WAL");

// Create all tables if they don't yet exist. This guarantees the schema is
// present at runtime without requiring a separate drizzle-kit push step.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track TEXT NOT NULL,
  date TEXT NOT NULL,
  card_conviction TEXT,
  notes TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  race_number INTEGER NOT NULL,
  tier TEXT NOT NULL,
  post TEXT,
  post_time_utc TEXT,
  conditions TEXT,
  shape TEXT,
  read TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  win_pgm TEXT, win_name TEXT, win_score REAL,
  place_pgm TEXT, place_name TEXT, place_score REAL,
  show_pgm TEXT, show_name TEXT, show_score REAL,
  fourth_pgm TEXT, fourth_name TEXT, fourth_score REAL,
  why_text TEXT,
  pace_text TEXT,
  tier_demoted_by TEXT
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL UNIQUE REFERENCES races(id) ON DELETE CASCADE,
  finish_order TEXT NOT NULL,
  win_hit INTEGER, place_hit INTEGER, show_hit INTEGER, fourth_hit INTEGER,
  itm_count INTEGER,
  exacta_hit INTEGER, trifecta_hit INTEGER, superfecta_hit INTEGER,
  flags_hit TEXT NOT NULL DEFAULT '[]',
  win_payout REAL, place_payout REAL, show_payout REAL,
  exacta_payout REAL, trifecta_payout REAL, superfecta_payout REAL,
  auto_fetched INTEGER DEFAULT 0,
  payouts_raw TEXT,
  logged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bankroll REAL NOT NULL DEFAULT 2000,
  unit_size REAL NOT NULL DEFAULT 20,
  sniper_win REAL NOT NULL DEFAULT 75,
  sniper_place REAL NOT NULL DEFAULT 25,
  edge_win REAL NOT NULL DEFAULT 45,
  edge_place REAL NOT NULL DEFAULT 15,
  recon_win REAL NOT NULL DEFAULT 20,
  dual_win REAL NOT NULL DEFAULT 30,
  default_track TEXT NOT NULL DEFAULT 'Saratoga',
  elevenlabs_voice_id TEXT NOT NULL DEFAULT 'onwK4e9ZLuTAKqWW03F9',
  elevenlabs_model_id TEXT NOT NULL DEFAULT 'eleven_turbo_v2_5',
  voice_speed REAL NOT NULL DEFAULT 1.0,
  auto_recap_enabled INTEGER NOT NULL DEFAULT 1,
  auto_fetch_enabled INTEGER NOT NULL DEFAULT 1,
  fetch_poll_minutes INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS audio_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  script_hash TEXT NOT NULL UNIQUE,
  voice_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  text TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── EEA v1 tables ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pp_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  parsed_json TEXT,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_error TEXT,
  uploaded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  horse_pgm TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  eeas REAL, eeap REAL, eeac REAL, eea_rating REAL,
  tier_assigned TEXT,
  rank INTEGER,
  llm_reasoning TEXT,
  persona_version INTEGER,
  figure_weights_json TEXT,
  bias_context_json TEXT,
  bloodstock_json TEXT,
  scratched INTEGER NOT NULL DEFAULT 0,
  scratched_at TEXT,
  llm_provider TEXT,
  llm_model TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id INTEGER NOT NULL,
  actual_finish INTEGER,
  beaten_lengths REAL,
  win_payout REAL, place_payout REAL, show_payout REAL,
  wager_placed REAL, wager_return REAL,
  trip_notes TEXT,
  recorded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS formula_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weights_json TEXT NOT NULL,
  persona_text TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  deactivated_at INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS tuning_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  proposed_change_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS bias_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  track TEXT NOT NULL,
  bias_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'hrn',
  accuracy_score REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maiden_enrichment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  horse_pgm TEXT NOT NULL,
  sales_price REAL,
  sales_venue TEXT,
  sire_stud_fee REAL,
  dam_produce TEXT,
  workout_pattern TEXT,
  trainer_fts_pct REAL,
  jockey_upgrade INTEGER,
  workmate TEXT,
  enrichment_json TEXT,
  fetched_at INTEGER NOT NULL
);

-- ── Voice subsystem tables ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS voice_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  user_transcript TEXT NOT NULL,
  jarvis_response TEXT NOT NULL,
  applied_changes TEXT,
  context_summary TEXT,
  reverted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  race_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  trigger TEXT NOT NULL,
  voice_conversation_id INTEGER,
  created_at INTEGER NOT NULL
);

-- Anthropic-generated printable race summaries (one row per race). Missing
-- this table is what crashed GET /api/cards/:id/print with a 500.
CREATE TABLE IF NOT EXISTS race_summaries (
  race_id INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  eea_version INTEGER,
  generated_at INTEGER NOT NULL
);

-- Trackside Daily Show build state, one row per card.
CREATE TABLE IF NOT EXISTS card_shows (
  card_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  manifest_json TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT
);

-- Equibase daily PP auto-ingest telemetry. One row per ingest attempt (cron or
-- manual). results_json holds the per-track outcome array so a run can be
-- replayed/debugged after the fact — we are not watching it run live.
CREATE TABLE IF NOT EXISTS equibase_ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,
  track_codes TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  results_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- Brisnet DRM (PP Data Files multi) daily auto-ingest telemetry. Same shape as
-- equibase_ingest_runs: one row per ingest attempt (cron or manual), with the
-- per-track outcome array in results_json for after-the-fact debugging.
CREATE TABLE IF NOT EXISTS brisnet_ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,
  track_codes TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  results_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- Parsed BRIS-specific per-horse data from the DRM .DR2 file, keyed by
-- (race_date, track_code, race_number, program_number). raw_row preserves the
-- full comma-delimited DR2 row so we can re-derive fields as we learn more of
-- the spec without a re-download. Engine joins on the key to enrich Equibase PP.
CREATE TABLE IF NOT EXISTS brisnet_horse_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,
  track_code TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  program_number TEXT NOT NULL,
  run_style TEXT,
  prime_power REAL,
  best_speed REAL,
  best_speed_surf_a REAL,
  best_speed_surf_b REAL,
  speed_par_early REAL,
  speed_par_late REAL,
  pace_par_e1 REAL,
  pace_par_e2 REAL,
  ml_odds REAL,
  company_line TEXT,
  horse_name TEXT,
  sire_name TEXT,
  dam_name TEXT,
  dam_sire_name TEXT,
  pedigree_stats TEXT,
  raw_row TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  UNIQUE (race_date, track_code, race_number, program_number)
);

-- Deep post-mortem ("answer key") report, one row per card (PR #25). payload
-- holds the full DeepPostmortem JSON. card_id is UNIQUE so re-running the
-- analyzer for a card overwrites the prior row (idempotent upsert).
CREATE TABLE IF NOT EXISTS deep_postmortems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL UNIQUE REFERENCES cards(id) ON DELETE CASCADE,
  generated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- Per-race weather forecast (PR #18). One row per race_id, persisted for
-- backtesting. surface_impact='unknown' means OpenWeather was unreachable and
-- the engine left every pick untouched. Numeric fields are nullable for that
-- case. Upserted by the 30-min scheduler + the backfill script.
CREATE TABLE IF NOT EXISTS race_weather (
  race_id INTEGER PRIMARY KEY,
  temp_f REAL,
  feels_like_f REAL,
  conditions TEXT,
  precip_mm REAL,
  wind_mph REAL,
  wind_dir_deg REAL,
  humidity_pct REAL,
  surface_impact TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'openweather',
  fetched_at TEXT NOT NULL
);
`);

// Idempotent settings-column migration for installs that predate EEA v1.
const settingsCols = new Set(
  (sqlite.prepare("PRAGMA table_info(settings)").all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
const addCol = (name: string, ddl: string) => {
  if (!settingsCols.has(name)) sqlite.exec(`ALTER TABLE settings ADD COLUMN ${ddl}`);
};
// PR #22: second ElevenLabs voice (Scarlett / Sarah) for informational replies,
// alongside the existing Jarvis (Brian) voice. Idempotent; defaults to Sarah.
addCol(
  "elevenlabs_voice_id_scarlett",
  "elevenlabs_voice_id_scarlett TEXT NOT NULL DEFAULT 'EXAVITQu4vr4xnSDxMaL'",
);
addCol("anthropic_api_key", "anthropic_api_key TEXT NOT NULL DEFAULT ''");
addCol("poe_api_key", "poe_api_key TEXT NOT NULL DEFAULT ''");
addCol("default_llm_provider", "default_llm_provider TEXT NOT NULL DEFAULT 'anthropic'");
addCol("default_anthropic_model", "default_anthropic_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5'");
addCol("default_poe_model", "default_poe_model TEXT NOT NULL DEFAULT 'Claude-Sonnet-4.5'");
addCol("daily_risk_cap_pct", "daily_risk_cap_pct REAL NOT NULL DEFAULT 0.03");
addCol("tier_share_sniper", "tier_share_sniper REAL NOT NULL DEFAULT 0.35");
addCol("tier_share_edge", "tier_share_edge REAL NOT NULL DEFAULT 0.20");
addCol("tier_share_dual", "tier_share_dual REAL NOT NULL DEFAULT 0.12");
addCol("tier_share_recon", "tier_share_recon REAL NOT NULL DEFAULT 0.08");

// Idempotent cards-column migration for the Historical archive. Existing rows
// inherit status='active'; archived_at is nullable and set by the sweep.
const cardsCols = new Set(
  (sqlite.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
const addCardCol = (name: string, ddl: string) => {
  if (!cardsCols.has(name)) sqlite.exec(`ALTER TABLE cards ADD COLUMN ${ddl}`);
};
addCardCol("status", "status TEXT NOT NULL DEFAULT 'active'");
addCardCol("archived_at", "archived_at TEXT");

// Idempotent races-column migration for the postmortem flag-driven tier
// demotion (Card 1 Saratoga 2026-06-07 postmortem). Nullable; only set when a
// flag on the win/place pick drops the tier.
const racesCols = new Set(
  (sqlite.prepare("PRAGMA table_info(races)").all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!racesCols.has("tier_demoted_by")) {
  sqlite.exec("ALTER TABLE races ADD COLUMN tier_demoted_by TEXT");
}
// Idempotent races-column migration for PR #17: separate UTC post time for
// sorting/comparison. races.post stays the track-local display string.
if (!racesCols.has("post_time_utc")) {
  sqlite.exec("ALTER TABLE races ADD COLUMN post_time_utc TEXT");
}

// Idempotent brisnet_horse_data migration for PR #16 Phase 2: persist the
// bloodstock names + the raw pedigree-stat block extracted by the DRM parser.
// Matches the column-existence-check pattern used above. sire/dam/dam-sire are
// the reliably-anchored fields the bloodstock scorer keys off; pedigree_stats
// keeps the untyped DR2 165..188 block verbatim for future re-decode.
const brisnetHorseCols = new Set(
  (sqlite.prepare("PRAGMA table_info(brisnet_horse_data)").all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
const addBrisnetHorseCol = (name: string, ddl: string) => {
  if (!brisnetHorseCols.has(name))
    sqlite.exec(`ALTER TABLE brisnet_horse_data ADD COLUMN ${ddl}`);
};
addBrisnetHorseCol("horse_name", "horse_name TEXT");
addBrisnetHorseCol("sire_name", "sire_name TEXT");
addBrisnetHorseCol("dam_name", "dam_name TEXT");
addBrisnetHorseCol("dam_sire_name", "dam_sire_name TEXT");
addBrisnetHorseCol("pedigree_stats", "pedigree_stats TEXT"); // JSON int array

// Idempotent predictions-column migration for PR #16 Phase 2: persist the
// per-horse bloodstock adjustment (applied/composite/confidence/reasonCodes)
// parallel to how the weather factor rides along. JSON blob, nullable.
const predictionsCols = new Set(
  (sqlite.prepare("PRAGMA table_info(predictions)").all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!predictionsCols.has("bloodstock_json")) {
  sqlite.exec("ALTER TABLE predictions ADD COLUMN bloodstock_json TEXT");
}

// Idempotent predictions-column migration for PR #20: per-horse scratch flag +
// detection timestamp. Existing rows default to not-scratched. Set/cleared by
// the scratch-refresh diff; rows are never deleted so history is preserved.
if (!predictionsCols.has("scratched")) {
  sqlite.exec("ALTER TABLE predictions ADD COLUMN scratched INTEGER NOT NULL DEFAULT 0");
}
if (!predictionsCols.has("scratched_at")) {
  sqlite.exec("ALTER TABLE predictions ADD COLUMN scratched_at TEXT");
}

export const db = drizzle(sqlite);
export { sqlite };

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
  conditions TEXT,
  shape TEXT,
  read TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  win_pgm TEXT, win_name TEXT, win_score REAL,
  place_pgm TEXT, place_name TEXT, place_score REAL,
  show_pgm TEXT, show_name TEXT, show_score REAL,
  fourth_pgm TEXT, fourth_name TEXT, fourth_score REAL,
  why_text TEXT,
  pace_text TEXT
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

export const db = drizzle(sqlite);
export { sqlite };

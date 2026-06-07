import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

const sqlite = new Database("data.db");
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
`);

export const db = drizzle(sqlite);
export { sqlite };

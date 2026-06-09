import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS } from "./services/eea-config";

// Resolve the SQLite file path.
//
// The production default is `/data/data.db` — Railway's persistent volume is
// mounted at `/data`, and a RELATIVE default ("data.db") resolves to
// `/app/data.db` INSIDE the container image, which is wiped on every deploy.
// That bug silently destroyed every card all evening (PR #30). If
// DATABASE_FILE is set we honor it verbatim; otherwise we prefer the persistent
// mount and fall back to a repo-local `./data.db` for local dev where `/data`
// doesn't exist.
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_FILE) return env.DATABASE_FILE;
  return fs.existsSync("/data") ? "/data/data.db" : "./data.db";
}

// Best-effort: is the directory that will hold the DB file writable? Logged at
// startup so a non-persisted / read-only mount is obvious in the Railway logs
// (the symptom that masked the wipe bug for hours).
function parentDirWritable(dbPath: string): boolean {
  const dir = path.dirname(path.resolve(dbPath));
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const DB_PATH = resolveDbPath();
// Quiet under vitest so the 40+ test files that each open a DB don't spam.
if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
  const persisted = DB_PATH.startsWith("/data/");
  console.log(
    `[db] sqlite path=${DB_PATH} persisted=${persisted} ` +
      `writable=${parentDirWritable(DB_PATH)}`,
  );
}

const sqlite = new Database(DB_PATH);
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

-- ── Brisnet deep-field ingest (PR #28b) ───────────────────────────────────
-- Per-race Track Bias snapshot, one row per (date,track,race,scope). MEET +
-- WEEK both stored. Keyed unique so re-ingest upserts. Powers bias_match.
CREATE TABLE IF NOT EXISTS brisnet_race_bias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,
  track_code TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  scope TEXT NOT NULL, -- MEET | WEEK
  surface TEXT,
  distance TEXT,
  num_races INTEGER,
  date_range_start TEXT,
  date_range_end TEXT,
  wire_pct REAL,
  speed_bias_pct REAL,
  wnr_avg_bl_1c REAL,
  wnr_avg_bl_2c REAL,
  iv_e REAL, iv_ep REAL, iv_p REAL, iv_s REAL,
  pct_e REAL, pct_ep REAL, pct_p REAL, pct_s REAL,
  dominant_style TEXT,
  favorable_styles TEXT, -- JSON array
  iv_rail REAL, iv_1_3 REAL, iv_4_7 REAL, iv_8plus REAL,
  pct_rail REAL, pct_1_3 REAL, pct_4_7 REAL, pct_8plus REAL,
  favorable_posts TEXT, -- JSON array
  ingested_at TEXT NOT NULL,
  UNIQUE (race_date, track_code, race_number, scope)
);

-- Per-race BRIS pars (E1, E2/late, SPD), one row per (date,track,race). These
-- also ride on brisnet_horse_data via the DRM path; this table is the canonical
-- deep-ingest copy keyed at the race level.
CREATE TABLE IF NOT EXISTS brisnet_race_pars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,
  track_code TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  par_e1 REAL,
  par_e2_late REAL,
  par_spd REAL,
  surface TEXT,
  distance_furlongs REAL,
  ingested_at TEXT NOT NULL,
  UNIQUE (race_date, track_code, race_number)
);
`);

// Idempotent brisnet_race_pars migration: surface + distance are race-level deep
// fields the Fusion v3 conditions_pedigree feature needs. Added after the table
// shipped, so guard for installs that predate these columns.
const parsCols = new Set(
  (sqlite.prepare("PRAGMA table_info(brisnet_race_pars)").all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!parsCols.has("surface")) sqlite.exec("ALTER TABLE brisnet_race_pars ADD COLUMN surface TEXT");
if (!parsCols.has("distance_furlongs")) {
  sqlite.exec("ALTER TABLE brisnet_race_pars ADD COLUMN distance_furlongs REAL");
}

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

// PR #28b — Brisnet deep-field ingest. Headline scalar fields the computed
// features read directly get typed columns; the nested per-runner blocks
// (jockey, trainer angles, last-10 past lines, workouts, race-summary derived)
// are stored as JSON, matching the existing pedigree_stats / bias_context_json
// precedent. Every column nullable so a thin/DRM-only card degrades gracefully.
// ── header block ──
addBrisnetHorseCol("prime_power_rank", "prime_power_rank INTEGER");
addBrisnetHorseCol("early_speed_points", "early_speed_points INTEGER");
addBrisnetHorseCol("ped_fast", "ped_fast REAL");
addBrisnetHorseCol("ped_off", "ped_off REAL");
addBrisnetHorseCol("ped_distance", "ped_distance REAL");
addBrisnetHorseCol("ped_turf", "ped_turf REAL");
addBrisnetHorseCol("med_lasix", "med_lasix TEXT");
addBrisnetHorseCol("med_bute", "med_bute INTEGER");
addBrisnetHorseCol("blinkers", "blinkers TEXT");
addBrisnetHorseCol("weight_carried", "weight_carried REAL");
addBrisnetHorseCol("apprentice_allowance", "apprentice_allowance REAL");
addBrisnetHorseCol("denotation", "denotation TEXT");
addBrisnetHorseCol("claim_price", "claim_price REAL");
addBrisnetHorseCol("dpi", "dpi REAL");
addBrisnetHorseCol("spi", "spi REAL");
addBrisnetHorseCol("sire_awd", "sire_awd REAL");
addBrisnetHorseCol("dam_sire_awd", "dam_sire_awd REAL");
addBrisnetHorseCol("sire_mud_pct", "sire_mud_pct REAL");
addBrisnetHorseCol("sire_mud_starts", "sire_mud_starts INTEGER");
addBrisnetHorseCol("sire_turf_pct", "sire_turf_pct REAL");
addBrisnetHorseCol("sire_fts_pct", "sire_fts_pct REAL");
addBrisnetHorseCol("sire_first_turf_pct", "sire_first_turf_pct REAL");
addBrisnetHorseCol("owner_name", "owner_name TEXT");
addBrisnetHorseCol("life_record", "life_record TEXT"); // JSON RunnerRecord
addBrisnetHorseCol("cy_record", "cy_record TEXT");
addBrisnetHorseCol("py_record", "py_record TEXT");
addBrisnetHorseCol("track_record", "track_record TEXT");
addBrisnetHorseCol("fst_record", "fst_record TEXT");
addBrisnetHorseCol("off_record", "off_record TEXT");
addBrisnetHorseCol("dis_record", "dis_record TEXT");
addBrisnetHorseCol("trf_record", "trf_record TEXT");
addBrisnetHorseCol("aw_record", "aw_record TEXT");
// ── connections (JSON blocks) ──
addBrisnetHorseCol("jockey_block", "jockey_block TEXT"); // JSON JockeyBlock
addBrisnetHorseCol("trainer_block", "trainer_block TEXT"); // JSON TrainerBlock
// ── per-start + workout arrays (JSON) ──
addBrisnetHorseCol("past_lines", "past_lines TEXT"); // JSON DeepPastLine[]
addBrisnetHorseCol("workouts", "workouts TEXT"); // JSON DeepWorkout[]
// ── Ultimate Race Summary derived block (JSON) ──
addBrisnetHorseCol("race_summary", "race_summary TEXT"); // JSON RaceSummaryDerived
// ── ml odds (numeric) for the deep path ──
addBrisnetHorseCol("ml_odds_deep", "ml_odds_deep REAL");

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

// Idempotent formula_versions weights repair (PR #34). A row written by an older
// schema can be missing whole top-level sub-objects (e.g. `bloodstock`), which
// crashed manual ingest with "Cannot read properties of undefined (reading
// 'shrinkageK')". Deep-merge each active row's weightsJson on top of
// DEFAULT_WEIGHTS and write it back when (and only when) a sub-object was
// missing/null. Running again on a healthy row is a no-op.
function repairStaleWeightsRows(): void {
  let repaired = 0;
  try {
    const rows = sqlite
      .prepare("SELECT id, weights_json FROM formula_versions WHERE deactivated_at IS NULL")
      .all() as { id: number; weights_json: string }[];
    const update = sqlite.prepare("UPDATE formula_versions SET weights_json = ? WHERE id = ?");
    for (const row of rows) {
      let stored: Record<string, unknown> = {};
      try {
        stored = JSON.parse(row.weights_json) as Record<string, unknown>;
      } catch {
        stored = {}; // corrupt JSON → rebuild from defaults
      }
      const merged: Record<string, any> = { ...DEFAULT_WEIGHTS };
      let changed = false;
      for (const key of Object.keys(DEFAULT_WEIGHTS) as (keyof typeof DEFAULT_WEIGHTS)[]) {
        const baseVal = (DEFAULT_WEIGHTS as any)[key];
        const storedVal = (stored as any)[key];
        if (storedVal === undefined || storedVal === null) {
          changed = true; // missing top-level sub-object → take the default
        } else if (
          baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
          storedVal && typeof storedVal === "object" && !Array.isArray(storedVal)
        ) {
          merged[key] = { ...baseVal, ...storedVal };
        } else {
          merged[key] = storedVal;
        }
      }
      // Preserve any extra stored keys not present in DEFAULT_WEIGHTS.
      for (const key of Object.keys(stored)) {
        if (!(key in merged)) merged[key] = (stored as any)[key];
      }
      if (changed) {
        update.run(JSON.stringify(merged), row.id);
        repaired++;
      }
    }
  } catch {
    // formula_versions may not exist yet on the very first boot; ignore.
  }
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    console.log(`[migrations] repaired ${repaired} stale weights rows`);
  }
}
repairStaleWeightsRows();

export const db = drizzle(sqlite);
export { sqlite };

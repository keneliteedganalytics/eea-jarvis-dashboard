import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── One card per track per day ────────────────────────────────────────────
export const cards = sqliteTable("cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  track: text("track").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  cardConviction: text("card_conviction"), // HIGH / MEDIUM / LOW
  notes: text("notes"),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  archivedAt: text("archived_at"), // ISO timestamp, set when auto-archived
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── One row per race ──────────────────────────────────────────────────────
export const races = sqliteTable("races", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  raceNumber: integer("race_number").notNull(),
  tier: text("tier").notNull(), // SNIPER / EDGE / DUAL / RECON / PASS
  post: text("post"), // track-local 12-hour display string, e.g. "12:55 PM"
  postTimeUtc: text("post_time_utc"), // ISO 8601 UTC instant, for sorting/comparison
  conditions: text("conditions"),
  shape: text("shape"),
  read: text("read"),
  flags: text("flags").notNull().default("[]"), // JSON array of strings

  // Picks — flattened
  winPgm: text("win_pgm"),
  winName: text("win_name"),
  winScore: real("win_score"),
  placePgm: text("place_pgm"),
  placeName: text("place_name"),
  placeScore: real("place_score"),
  showPgm: text("show_pgm"),
  showName: text("show_name"),
  showScore: real("show_score"),
  fourthPgm: text("fourth_pgm"),
  fourthName: text("fourth_name"),
  fourthScore: real("fourth_score"),

  // Editable analysis fields
  whyText: text("why_text"),
  paceText: text("pace_text"),

  // Explainability for the flag-driven tier demotion (postmortem Fix 2). Holds a
  // note like "EDGE→RECON: BOUNCE RISK on #1 (place pick)" when a flag on the
  // win/place pick dropped the tier; null when no demotion occurred.
  tierDemotedBy: text("tier_demoted_by"),
});

// ── One row per race result the user logs ─────────────────────────────────
export const results = sqliteTable("results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  raceId: integer("race_id")
    .notNull()
    .references(() => races.id, { onDelete: "cascade" })
    .unique(),
  finishOrder: text("finish_order").notNull(), // JSON array ["2","1","7","5"]
  // Auto-computed grading
  winHit: integer("win_hit", { mode: "boolean" }),
  placeHit: integer("place_hit", { mode: "boolean" }),
  showHit: integer("show_hit", { mode: "boolean" }),
  fourthHit: integer("fourth_hit", { mode: "boolean" }),
  itmCount: integer("itm_count"), // 0–4
  exactaHit: integer("exacta_hit", { mode: "boolean" }),
  trifectaHit: integer("trifecta_hit", { mode: "boolean" }),
  superfectaHit: integer("superfecta_hit", { mode: "boolean" }),
  flagsHit: text("flags_hit").notNull().default("[]"), // JSON array
  // Payouts (v2)
  winPayout: real("win_payout"),
  placePayout: real("place_payout"),
  showPayout: real("show_payout"),
  exactaPayout: real("exacta_payout"),
  trifectaPayout: real("trifecta_payout"),
  superfectaPayout: real("superfecta_payout"),
  autoFetched: integer("auto_fetched", { mode: "boolean" }).default(false),
  payoutsRaw: text("payouts_raw"),
  loggedAt: text("logged_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── Weather per race (PR #18) ─────────────────────────────────────────────
// One row per race_id, persisted for backtesting. surfaceImpact is the derived
// handicapping signal; "unknown" means OpenWeather was unreachable and the
// engine must NOT alter any pick. fetchedAt lets the scheduler/cache age rows.
export const raceWeather = sqliteTable("race_weather", {
  raceId: integer("race_id").primaryKey(),
  tempF: real("temp_f"),
  feelsLikeF: real("feels_like_f"),
  conditions: text("conditions"),
  precipMm: real("precip_mm"),
  windMph: real("wind_mph"),
  windDirDeg: real("wind_dir_deg"),
  humidityPct: real("humidity_pct"),
  surfaceImpact: text("surface_impact", {
    enum: ["dry", "damp", "wet", "sloppy", "muddy", "unknown"],
  })
    .notNull()
    .default("unknown"),
  source: text("source").notNull().default("openweather"),
  fetchedAt: text("fetched_at").notNull(),
});

// ── User settings (single row) ────────────────────────────────────────────
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bankroll: real("bankroll").notNull().default(2000),
  unitSize: real("unit_size").notNull().default(20),
  sniperWin: real("sniper_win").notNull().default(75),
  sniperPlace: real("sniper_place").notNull().default(25),
  edgeWin: real("edge_win").notNull().default(45),
  edgePlace: real("edge_place").notNull().default(15),
  reconWin: real("recon_win").notNull().default(20),
  dualWin: real("dual_win").notNull().default(30),
  defaultTrack: text("default_track").notNull().default("Saratoga"),
  // Jarvis voice (v2) — Brian. Used for tier-change actions/confirmations.
  elevenlabsVoiceId: text("elevenlabs_voice_id").notNull().default("onwK4e9ZLuTAKqWW03F9"),
  // Scarlett voice (PR #22) — Sarah. Used for informational/question replies.
  elevenlabsVoiceIdScarlett: text("elevenlabs_voice_id_scarlett")
    .notNull()
    .default("EXAVITQu4vr4xnSDxMaL"),
  elevenlabsModelId: text("elevenlabs_model_id").notNull().default("eleven_turbo_v2_5"),
  voiceSpeed: real("voice_speed").notNull().default(1.0),
  autoRecapEnabled: integer("auto_recap_enabled", { mode: "boolean" }).notNull().default(true),
  autoFetchEnabled: integer("auto_fetch_enabled", { mode: "boolean" }).notNull().default(true),
  fetchPollMinutes: integer("fetch_poll_minutes").notNull().default(5),

  // ── EEA v1: LLM + bankroll/sizing config ────────────────────────────────
  anthropicApiKey: text("anthropic_api_key").notNull().default(""),
  poeApiKey: text("poe_api_key").notNull().default(""),
  defaultLlmProvider: text("default_llm_provider").notNull().default("anthropic"),
  defaultAnthropicModel: text("default_anthropic_model").notNull().default("claude-sonnet-4-5"),
  defaultPoeModel: text("default_poe_model").notNull().default("Claude-Sonnet-4.5"),
  dailyRiskCapPct: real("daily_risk_cap_pct").notNull().default(0.03),
  tierShareSniper: real("tier_share_sniper").notNull().default(0.35),
  tierShareEdge: real("tier_share_edge").notNull().default(0.20),
  tierShareDual: real("tier_share_dual").notNull().default(0.12),
  tierShareRecon: real("tier_share_recon").notNull().default(0.08),
});

// ── Trackside Daily Show (broadcast video build per card) ─────────────────
// One row per card. status drives the player's polling UI; manifestJson holds
// the built segment list once ready. Backward-compatible add — created lazily.
export const cardShows = sqliteTable("card_shows", {
  cardId: integer("card_id").primaryKey(),
  status: text("status").notNull().default("queued"), // queued|requested|building|ready|error
  manifestJson: text("manifest_json"),
  error: text("error"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

// ── Jarvis audio cache ────────────────────────────────────────────────────
export const audioCache = sqliteTable("audio_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scriptHash: text("script_hash").notNull().unique(), // sha256(voice|model|text)
  voiceId: text("voice_id").notNull(),
  modelId: text("model_id").notNull(),
  text: text("text").notNull(),
  filePath: text("file_path").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── EEA v1: LLM handicapping engine tables ────────────────────────────────

// Uploaded PP/speed-figure PDFs (one row per uploaded file).
export const ppUploads = sqliteTable("pp_uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id").notNull(),
  source: text("source", { enum: ["brisnet", "equibase"] }).notNull(),
  filename: text("filename").notNull(),
  storagePath: text("storage_path").notNull(),
  parsedJson: text("parsed_json"),
  parseStatus: text("parse_status", { enum: ["pending", "ok", "failed"] })
    .notNull()
    .default("pending"),
  parseError: text("parse_error"),
  uploadedAt: integer("uploaded_at", { mode: "timestamp" }).notNull(),
});

// One row per horse per race: the fused figures + the LLM's handicap.
export const predictions = sqliteTable("predictions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  raceId: integer("race_id").notNull(),
  horsePgm: text("horse_pgm").notNull(),
  horseName: text("horse_name").notNull(),
  eeas: real("eeas"),
  eeap: real("eeap"),
  eeac: real("eeac"),
  eeaRating: real("eea_rating"),
  tierAssigned: text("tier_assigned", {
    enum: ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"],
  }),
  rank: integer("rank"),
  llmReasoning: text("llm_reasoning"),
  personaVersion: integer("persona_version"),
  figureWeightsJson: text("figure_weights_json"),
  biasContextJson: text("bias_context_json"),
  // PR #16 Phase 2: per-horse bloodstock adjustment (applied/composite/
  // confidence/reasonCodes/ratingDelta) as JSON, parallel to the weather factor.
  bloodstockJson: text("bloodstock_json"),
  // PR #20: per-horse scratch flag. Set by the scratch-refresh diff when a horse
  // is no longer in the source roster; cleared on re-instatement. Scratched
  // horses keep their row (and analysis history) but are excluded from ranking.
  scratched: integer("scratched", { mode: "boolean" }).notNull().default(false),
  scratchedAt: text("scratched_at"), // ISO 8601, set when the scratch was detected
  llmProvider: text("llm_provider", { enum: ["anthropic", "poe"] }),
  llmModel: text("llm_model"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Backfilled outcome for a prediction (matched from results).
export const predictionOutcomes = sqliteTable("prediction_outcomes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  predictionId: integer("prediction_id").notNull(),
  actualFinish: integer("actual_finish"),
  beatenLengths: real("beaten_lengths"),
  winPayout: real("win_payout"),
  placePayout: real("place_payout"),
  showPayout: real("show_payout"),
  wagerPlaced: real("wager_placed"),
  wagerReturn: real("wager_return"),
  tripNotes: text("trip_notes"),
  recordedAt: integer("recorded_at", { mode: "timestamp" }).notNull(),
});

// Versioned figure weights + persona. The active row has deactivatedAt = null.
export const formulaVersions = sqliteTable("formula_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  weightsJson: text("weights_json").notNull(),
  personaText: text("persona_text").notNull(),
  activatedAt: integer("activated_at", { mode: "timestamp" }).notNull(),
  deactivatedAt: integer("deactivated_at", { mode: "timestamp" }),
  notes: text("notes"),
});

// Auto-tuner proposals awaiting user accept/reject.
export const tuningProposals = sqliteTable("tuning_proposals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hypothesis: text("hypothesis").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  proposedChangeJson: text("proposed_change_json"),
  status: text("status", { enum: ["pending", "accepted", "rejected"] })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
});

// Yesterday's track bias card (scraped from HRN charts).
export const biasReads = sqliteTable("bias_reads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  track: text("track").notNull(),
  biasJson: text("bias_json").notNull(),
  source: text("source").notNull().default("hrn"),
  accuracyScore: real("accuracy_score"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Anthropic-generated 2-3 sentence race summary for the printable picks page.
// Cached per race; regenerated when the active formula/eea version changes.
export const raceSummaries = sqliteTable("race_summaries", {
  raceId: integer("race_id").primaryKey(),
  summary: text("summary").notNull(),
  eeaVersion: integer("eea_version"),
  generatedAt: integer("generated_at", { mode: "timestamp" }).notNull(),
});

// Maiden enrichment (sales/pedigree/works), 24h cached per horse.
export const maidenEnrichment = sqliteTable("maiden_enrichment", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  raceId: integer("race_id").notNull(),
  horsePgm: text("horse_pgm").notNull(),
  salesPrice: real("sales_price"),
  salesVenue: text("sales_venue"),
  sireStudFee: real("sire_stud_fee"),
  damProduce: text("dam_produce"),
  workoutPattern: text("workout_pattern"),
  trainerFtsPct: real("trainer_fts_pct"),
  jockeyUpgrade: integer("jockey_upgrade", { mode: "boolean" }),
  workmate: text("workmate"),
  enrichmentJson: text("enrichment_json"),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull(),
});

// ── Voice (live trackside observations) ───────────────────────────────────

// One row per voice exchange: Ken's transcript + Jarvis's spoken reply, plus
// the changes that were applied if he confirmed. Persisted per card so the
// conversation can be scrolled back and updates audited.
export const voiceConversations = sqliteTable("voice_conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id").notNull(),
  userTranscript: text("user_transcript").notNull(),
  jarvisResponse: text("jarvis_response").notNull(),
  appliedChanges: text("applied_changes"), // JSON array of TierChange
  contextSummary: text("context_summary"),
  reverted: integer("reverted", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Append-only snapshot of a race's picks/tier so a voice update can be undone.
export const predictionHistory = sqliteTable("prediction_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id").notNull(),
  raceId: integer("race_id").notNull(),
  snapshot: text("snapshot").notNull(), // JSON of the race fields before the change
  trigger: text("trigger", { enum: ["initial", "voice_update", "manual"] }).notNull(),
  voiceConversationId: integer("voice_conversation_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ── Brisnet deep-field ingest (PR #28b) ───────────────────────────────────
// Per-race Track Bias snapshot (MEET + WEEK), keyed (date,track,race,scope).
export const brisnetRaceBias = sqliteTable("brisnet_race_bias", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  raceDate: text("race_date").notNull(),
  trackCode: text("track_code").notNull(),
  raceNumber: integer("race_number").notNull(),
  scope: text("scope").notNull(),
  surface: text("surface"),
  distance: text("distance"),
  numRaces: integer("num_races"),
  dateRangeStart: text("date_range_start"),
  dateRangeEnd: text("date_range_end"),
  wirePct: real("wire_pct"),
  speedBiasPct: real("speed_bias_pct"),
  wnrAvgBl1c: real("wnr_avg_bl_1c"),
  wnrAvgBl2c: real("wnr_avg_bl_2c"),
  ivE: real("iv_e"),
  ivEp: real("iv_ep"),
  ivP: real("iv_p"),
  ivS: real("iv_s"),
  pctE: real("pct_e"),
  pctEp: real("pct_ep"),
  pctP: real("pct_p"),
  pctS: real("pct_s"),
  dominantStyle: text("dominant_style"),
  favorableStyles: text("favorable_styles"), // JSON array
  ivRail: real("iv_rail"),
  iv1_3: real("iv_1_3"),
  iv4_7: real("iv_4_7"),
  iv8plus: real("iv_8plus"),
  pctRail: real("pct_rail"),
  pct1_3: real("pct_1_3"),
  pct4_7: real("pct_4_7"),
  pct8plus: real("pct_8plus"),
  favorablePosts: text("favorable_posts"), // JSON array
  ingestedAt: text("ingested_at").notNull(),
});

// Per-race BRIS pars, keyed (date,track,race).
export const brisnetRacePars = sqliteTable("brisnet_race_pars", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  raceDate: text("race_date").notNull(),
  trackCode: text("track_code").notNull(),
  raceNumber: integer("race_number").notNull(),
  parE1: real("par_e1"),
  parE2Late: real("par_e2_late"),
  parSpd: real("par_spd"),
  surface: text("surface"),
  distanceFurlongs: real("distance_furlongs"),
  ingestedAt: text("ingested_at").notNull(),
});

export type BrisnetRaceBiasRow = typeof brisnetRaceBias.$inferSelect;
export type BrisnetRaceParsRow = typeof brisnetRacePars.$inferSelect;

// ── Deep post-mortem (PR #25) ─────────────────────────────────────────────
// One row per card holding the full DeepPostmortem payload as JSON. Idempotent:
// re-running the analyzer for a card overwrites its row (card_id is unique).
export const deepPostmortems = sqliteTable("deep_postmortems", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" })
    .unique(),
  generatedAt: text("generated_at").notNull(),
  payload: text("payload").notNull(), // JSON of DeepPostmortem
});

// ── Insert schemas ────────────────────────────────────────────────────────
export const insertCardSchema = createInsertSchema(cards).omit({
  id: true,
  createdAt: true,
});
export const insertRaceSchema = createInsertSchema(races).omit({ id: true });
export const insertResultSchema = createInsertSchema(results).omit({
  id: true,
  loggedAt: true,
});
export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });

// Result submission from the client (just the finish order string/array)
export const resultSubmitSchema = z.object({
  finishOrder: z.array(z.string().min(1)),
});

// Update race analysis text
export const updateRaceTextSchema = z.object({
  whyText: z.string().optional(),
  paceText: z.string().optional(),
});

// ── Types ─────────────────────────────────────────────────────────────────
export type Card = typeof cards.$inferSelect;
export type InsertCard = z.infer<typeof insertCardSchema>;
export type Race = typeof races.$inferSelect;
export type InsertRace = z.infer<typeof insertRaceSchema>;
export type Result = typeof results.$inferSelect;
export type InsertResult = z.infer<typeof insertResultSchema>;
export type Settings = typeof settings.$inferSelect;
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type AudioCache = typeof audioCache.$inferSelect;
export type CardShow = typeof cardShows.$inferSelect;

// ── Daily Show manifest (written to disk + stored in card_shows.manifestJson) ─
export interface ShowSegment {
  id: string; // "overview" | "r1" | "r2" ...
  label: string; // "Overview" | "R1 Alw 26500 N2L"
  filename: string; // "overview.mp4" | "r1.mp4"
  durationSec: number;
}
export interface ShowManifest {
  cardId: number;
  track: string;
  generatedAt: string; // ISO timestamp
  segments: ShowSegment[];
}

// Server-built Suggested Wagers, attached to every race the API returns so the
// Race Detail view and the Print sheet render byte-identical numbers. Mirrors
// the RaceBets shape produced by server/services/wagers.ts (kept structural to
// avoid a server import in shared/client code).
export interface RaceWagerLeg {
  type: string;
  structure: string;
  horses: string[];
  cost: number;
}
export interface RaceWagers {
  tier: string;
  raceAllocation: number;
  pass: boolean;
  legs: RaceWagerLeg[];
}

// ── Weather (PR #18) ───────────────────────────────────────────────────────
export type SurfaceImpact = "dry" | "damp" | "wet" | "sloppy" | "muddy" | "unknown";

// The typed forecast the weather service returns and the API attaches to each
// race. Numeric fields are null when surfaceImpact is "unknown" (fetch failed).
export interface RaceWeather {
  tempF: number | null;
  feelsLikeF: number | null;
  conditions: string | null;
  precipMm: number | null;
  windMph: number | null;
  windDirDeg: number | null;
  humidityPct: number | null;
  surfaceImpact: SurfaceImpact;
  fetchedAt: string; // ISO 8601 UTC
  source: "openweather";
}

export type RaceWeatherRow = typeof raceWeather.$inferSelect;

// ── Bloodstock (PR #16 Phase 2) ──────────────────────────────────────────────
export type BloodstockConfidence = "high" | "medium" | "low" | "none";

// Compact per-horse pedigree summary the race-card chip renders. Mirrors the
// fusion engine's BloodstockAdjustment but trimmed to what the UI shows.
export interface PedigreeSummary {
  composite: number;
  confidence: BloodstockConfidence;
  applied: boolean;
  reasonCodes: string[];
  sireName?: string | null;
  damName?: string | null;
  damSireName?: string | null;
  surfaceFit?: number | null;
  distanceFit?: number | null;
  wetFit?: number | null;
}

export type RaceWithResult = Race & {
  result?: Result | null;
  bets?: RaceWagers;
  weather?: RaceWeather | null;
  // Pedigree summary per program number, for the race-card chip. Keyed by pgm.
  pedigree?: Record<string, PedigreeSummary>;
};
export type CardWithRaces = Card & { races: RaceWithResult[] };

// ── Historical archive ────────────────────────────────────────────────────
export interface ArchivedCardSummary {
  id: number;
  date: string;
  raceCount: number;
  cardConviction: string | null;
  archivedAt: string | null;
}
export interface ArchivedTrackGroup {
  track: string;
  cards: ArchivedCardSummary[];
}
export interface ArchivedCardsGrouped {
  tracks: ArchivedTrackGroup[];
}

// ── EEA v1 insert schemas + types ─────────────────────────────────────────
export const insertPpUploadSchema = createInsertSchema(ppUploads).omit({ id: true });
export const insertPredictionSchema = createInsertSchema(predictions).omit({ id: true });
export const insertPredictionOutcomeSchema = createInsertSchema(predictionOutcomes).omit({ id: true });
export const insertFormulaVersionSchema = createInsertSchema(formulaVersions).omit({ id: true });
export const insertTuningProposalSchema = createInsertSchema(tuningProposals).omit({ id: true });
export const insertBiasReadSchema = createInsertSchema(biasReads).omit({ id: true });
export const insertMaidenEnrichmentSchema = createInsertSchema(maidenEnrichment).omit({ id: true });
export const insertRaceSummarySchema = createInsertSchema(raceSummaries);

export type PpUpload = typeof ppUploads.$inferSelect;
export type InsertPpUpload = z.infer<typeof insertPpUploadSchema>;
export type Prediction = typeof predictions.$inferSelect;
export type InsertPrediction = z.infer<typeof insertPredictionSchema>;
export type PredictionOutcome = typeof predictionOutcomes.$inferSelect;
export type InsertPredictionOutcome = z.infer<typeof insertPredictionOutcomeSchema>;
export type FormulaVersion = typeof formulaVersions.$inferSelect;
export type InsertFormulaVersion = z.infer<typeof insertFormulaVersionSchema>;
export type TuningProposal = typeof tuningProposals.$inferSelect;
export type InsertTuningProposal = z.infer<typeof insertTuningProposalSchema>;
export type BiasRead = typeof biasReads.$inferSelect;
export type InsertBiasRead = z.infer<typeof insertBiasReadSchema>;
export type MaidenEnrichment = typeof maidenEnrichment.$inferSelect;
export type InsertMaidenEnrichment = z.infer<typeof insertMaidenEnrichmentSchema>;
export type RaceSummary = typeof raceSummaries.$inferSelect;
export type InsertRaceSummary = z.infer<typeof insertRaceSummarySchema>;

// ── Voice types ───────────────────────────────────────────────────────────
export type VoiceConversation = typeof voiceConversations.$inferSelect;
export type PredictionHistory = typeof predictionHistory.$inferSelect;

// ── Deep post-mortem types (PR #25) ───────────────────────────────────────
export type DeepPostmortemRow = typeof deepPostmortems.$inferSelect;

// A visible pre-race signal that favored the actual winner. wouldHaveFlipped is
// true when acting on it would have changed our top pick.
export interface VisibleSignal {
  signal: string;
  detail: string;
  wouldHaveFlipped: boolean;
}

export interface DeepRacePostmortem {
  raceNumber: number;
  ourTopPick: { runner: string; tier: string; rating: number };
  actualWinner: { runner: string; programNumber: number; odds?: number };
  outcome: "hit" | "place" | "show" | "itm" | "miss";
  hindsightAnalysis: {
    winnerWasInPool: boolean;
    winnerTier: string | null;
    winnerRating: number | null;
    visibleSignals: VisibleSignal[];
    overweightedFactors: string[];
  };
  paceShape: string;
  biasAlignment: string;
  weatherAlignment: string;
  scratches: {
    preLocked: string[];
    postLocked: string[];
    impactedTopPick: boolean;
  };
}

export interface DeepPostmortem {
  cardId: number;
  track: string;
  date: string;
  generatedAt: string;
  summary: {
    raceCount: number;
    graded: number;
    winRate: number;
    itmRate: number;
    roi: number;
    bestCall: { raceNumber: number; tier: string; runner: string; reason: string };
    worstMiss: { raceNumber: number; ourPick: string; actualWinner: string; visibleSignal: string };
  };
  races: DeepRacePostmortem[];
  lessons: string[];
  systemicFlags: string[];
}

// ── Fusion Replay (PR #28) ────────────────────────────────────────────────
// Re-runs an already-graded card through PR #27's tier-tuning v2 rules against
// the PRESERVED predictions snapshot (no re-ingest), and reports per-race the
// original tier/top-pick vs. the replayed one, which v2 rules fired, and — for
// graded races — whether the new logic would have caught (or lost) the winner.
export interface FusionRaceDiff {
  raceNumber: number;
  actualWinner: { program: string; horse: string };
  original: { tier: string; topPick: string; rating: number };
  replayed: { tier: string; topPick: string; rating: number };
  changed: boolean;
  newFlags: string[];
  rulesFired: string[]; // ["DUAL_EARNED_CLASS_GATE", "RATING_GAP_PENALTY", ...]
  wouldHaveCaught: boolean; // would the new top pick have won?
  wouldHaveLost: boolean; // did the old top pick win but new logic flipped away?
}

export interface FusionReplay {
  cardId: number;
  track: string;
  date: string;
  generatedAt: string;
  raceCount: number;
  graded: number;
  diffs: FusionRaceDiff[];
  summary: {
    tierChanges: number; // how many races changed tier
    flagsAdded: number; // total v2 flags surfaced across the card
    missesCaught: number; // races where new logic would have flipped to the winner
    missesIntroduced: number; // races where new logic flipped AWAY from a winner
    netImprovement: number; // missesCaught - missesIntroduced
  };
}

// A single proposed (and later applied) tier/pick change for one race.
export const tierChangeSchema = z.object({
  raceId: z.number().int(),
  horsePgm: z.string().optional(),
  horseName: z.string().optional(),
  oldTier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
  newTier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
  reason: z.string(),
});
export type TierChange = z.infer<typeof tierChangeSchema>;

// Settings additions (EEA): API keys + LLM/figure config live in settings table.
export const updatePredictionSchema = z.object({
  llmReasoning: z.string().optional(),
  tierAssigned: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]).optional(),
  rank: z.number().int().optional(),
});

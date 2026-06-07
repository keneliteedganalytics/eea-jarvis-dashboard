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
  post: text("post"),
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
  // Jarvis voice (v2)
  elevenlabsVoiceId: text("elevenlabs_voice_id").notNull().default("onwK4e9ZLuTAKqWW03F9"),
  elevenlabsModelId: text("elevenlabs_model_id").notNull().default("eleven_turbo_v2_5"),
  voiceSpeed: real("voice_speed").notNull().default(1.0),
  autoRecapEnabled: integer("auto_recap_enabled", { mode: "boolean" }).notNull().default(true),
  autoFetchEnabled: integer("auto_fetch_enabled", { mode: "boolean" }).notNull().default(true),
  fetchPollMinutes: integer("fetch_poll_minutes").notNull().default(5),
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

export type RaceWithResult = Race & { result?: Result | null };
export type CardWithRaces = Card & { races: RaceWithResult[] };

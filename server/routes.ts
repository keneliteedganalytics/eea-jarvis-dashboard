import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage, seedSaratogaCard, seedFormulaVersion } from "./storage";
import {
  insertCardSchema,
  insertRaceSchema,
  resultSubmitSchema,
  payoutsSubmitSchema,
  updateRaceTextSchema,
  updateRacePicksSchema,
  insertSettingsSchema,
  updatePredictionSchema,
} from "@shared/schema";
import type { Card, Settings, Result } from "@shared/schema";
import { z } from "zod";
import { backfillNullScoreCards, sweepArchive } from "./services/card-finishing";
import { getOrFetchBias, fetchBias } from "./services/bias-fetcher";
import { getOrGenerateRaceSummary } from "./services/race-summary";
import {
  buildAnalyticsSummary,
  buildAnalyticsTracks,
  buildCardStats,
  buildLifetimeStats,
  buildTrackRecordSummary,
  buildLedgerRoi,
  buildPr42Analytics,
  TIMEFRAMES,
  type Timeframe,
} from "./analytics";
import {
  buildBookSummary,
  buildBookByTrack,
  buildBookByBetType,
  buildBookByTrackAndType,
  buildBookBankrollCurve,
  buildBookBets,
} from "./book-analytics";
import { registerExpertPicksRoutes } from "./expert-picks";
import {
  cardBriefingScript,
  raceBriefingScript,
  raceRecapScript,
  cardSummaryScript,
} from "./services/scripts";
import { generateSpeech, getCachedFilePath, fetchVoices } from "./services/tts";
import { addSseClient, removeSseClient, broadcastEvent } from "./services/events";
import { startPoller, runPollerNow } from "./services/poller";
import { voiceRouter } from "./routes/voice";
import { showApiRouter, showFileRouter } from "./routes/show";
import { equibaseAdminRouter } from "./routes/equibase";
import { startEquibaseIngestCron } from "./services/equibase-cron";
import { startWeatherCron } from "./services/weather-cron";
import { startScratchRefreshCron } from "./services/scratch-refresh-cron";
import { startResultsPollerCron, autoGradeRace } from "./services/results-poller-cron";
import { getMatticeStats } from "./services/mattice-weight";
import { fetchOtbResults } from "./services/otb-results";
import { refreshScratchesForCard, isScratchRefreshError } from "./services/scratch-refresh";
import { brisnetAdminRouter } from "./routes/brisnet";
import { manualIngestRouter } from "./routes/manual-ingest";
import { runOnDemandIngest } from "./services/on-demand-ingest";
import {
  runDeepPostmortem,
  runDeepPostmortemToday,
  getDeepPostmortem,
} from "./services/deep-postmortem";
import { runFusionReplay, runFusionReplayToday } from "./services/fusion-replay";
import { runMatticeBackfill } from "./services/mattice-backfill";
import { adminPinGate } from "./middleware/admin-pin";
import {
  upsertSnapshot,
  recordOutcomes,
  listSnapshots,
  computeRoi,
  getSnapshot,
  DEFAULT_METHODOLOGY_VERSION,
} from "./services/backtest";
import { gradeCard, V4_VERSION, V4_WEIGHTS } from "./services/v4_rating";
import { snapshotSubmitSchema, outcomesSubmitSchema } from "@shared/schema";
import { realBetsBulkUpsertSchema } from "@shared/schema";

// Body schema for POST /api/cards/on-demand-ingest. Track is fuzzy-resolved
// server-side; date is validated there too (this only enforces presence/shape).
const onDemandIngestSchema = z.object({
  track: z.string().min(1),
  date: z.string().min(1),
  source: z.enum(["both", "equibase", "brisnet"]).optional(),
});

// Helper: load TTS settings (voice / model / speed) from storage.
function ttsSettings(): { voiceId: string; modelId: string; speed: number } {
  const s = storage.getSettings();
  return {
    voiceId: s.elevenlabsVoiceId,
    modelId: s.elevenlabsModelId,
    speed: s.voiceSpeed,
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // Seed demo data + start the Equibase poller once the server is ready.
  seedSaratogaCard();
  seedFormulaVersion();
  // Repair any older cards persisted with null numeric scores (e.g. the
  // Finger Lakes card) by reconstructing scores from their prediction rows.
  backfillNullScoreCards(storage);
  // Auto-archive past cards at boot, then sweep hourly. Idempotent.
  sweepArchive(storage);
  setInterval(() => sweepArchive(storage), 60 * 60 * 1000).unref();
  startPoller();
  // Daily 6am-MDT Equibase PP auto-ingest (one hour before the 7am show build),
  // immediately followed by the Brisnet DRM ingest (sequential, same slot).
  // Production-only so local dev never hits the live subscriptions.
  startEquibaseIngestCron();
  // 30-min weather refresh for today + tomorrow's races (PR #18). Runs in all
  // envs — it only reads OpenWeather and never mutates picks.
  startWeatherCron();
  // 15-min scratch refresh for locked cards during racing hours (PR #20). Reads
  // each card's stored source roster and flags missing horses as scratched.
  startScratchRefreshCron();
  // 5-min OTB auto-grader (PR #44): grades active-card races 5 min past post
  // from offtrackbetting.com and updates each card's bankroll. Kill switch:
  // OTB_POLL_DISABLED=1.
  startResultsPollerCron();

  // PR #43: gate every mutating /api request behind the admin PIN. Registered
  // before any app.post/put/patch/delete so all of them inherit it; GET
  // requests and the websocket upgrade are unaffected.
  app.use("/api", adminPinGate);

  // ── Cards ────────────────────────────────────────────────────────────────
  // Default to active cards only so the main dashboard never shows past cards.
  // `?includeArchived=true` returns everything (active + archived).
  app.get("/api/cards", (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    res.json(includeArchived ? storage.getCards() : storage.getActiveCards());
  });

  // ── Historical archive ─────────────────────────────────────────────────────
  // Archived cards grouped by track (tracks A→Z, cards newest-first).
  app.get("/api/cards/archived", (_req, res) => {
    res.json(storage.getArchivedCardsGrouped());
  });

  // Full archived card detail (read-only — same shape as an active card).
  app.get("/api/cards/archived/:id", (req, res) => {
    const id = Number(req.params.id);
    const card = storage.getArchivedCardById(id);
    if (!card) return res.status(404).json({ error: "Archived card not found" });
    res.json(card);
  });

  // Draft cards: active, unlocked cards awaiting review (from the cron or the
  // on-demand ingest). Lightweight summaries with tier counts for the Drafts UI.
  app.get("/api/cards/drafts", (_req, res) => {
    const drafts = storage
      .getActiveCards()
      .filter((c) => !c.locked)
      .map((c) => {
        const full = storage.getCardWithRaces(c.id);
        const races = full?.races ?? [];
        const tierCount = (t: string) => races.filter((r) => r.tier === t).length;
        return {
          id: c.id,
          track: c.track,
          date: c.date,
          raceCount: races.length,
          cardConviction: c.cardConviction,
          sniper: tierCount("SNIPER"),
          edge: tierCount("EDGE"),
          createdAt: c.createdAt,
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json(drafts);
  });

  app.get("/api/cards/latest", (_req, res) => {
    const card = storage.getLatestCard();
    if (!card) return res.status(404).json({ error: "No cards yet" });
    res.json(card);
  });

  app.get("/api/cards/:id", (req, res) => {
    const id = Number(req.params.id);
    const card = storage.getCardWithRaces(id);
    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json(card);
  });

  // v4 rating (LOCKED v4-lock-2026-06-12). Grades a card with the v4 composite
  // + tier engine. The dashboard's DB race rows carry no per-horse feature
  // columns, so we grade the frozen score-time snapshot's rawData when present
  // (Belmont/Churchill/evaluated card_data shapes); otherwise we fall back to
  // the card itself, where feature-less races stamp PASS rather than throw.
  app.get("/api/cards/:id/v4-grades", (req, res) => {
    const id = Number(req.params.id);
    const card = storage.getCardWithRaces(id);
    if (!card) return res.status(404).json({ error: "Card not found" });
    try {
      const snap = getSnapshot(id);
      let source: unknown = card;
      if (snap) {
        try {
          const raw = JSON.parse(snap.rawData) as { races?: unknown[] };
          if (raw && Array.isArray(raw.races) && raw.races.length > 0) source = raw;
        } catch {
          /* fall back to the card shape */
        }
      }
      const grades = gradeCard(source);
      res.json({
        version: V4_VERSION,
        weights: V4_WEIGHTS,
        track: card.track,
        date: card.date,
        grades,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Create a card. Body: { card: InsertCard, races: Omit<InsertRace,"cardId">[],
  // snapshot?: SnapshotSubmit }. When `snapshot` is present we also archive a
  // backtest snapshot in the same request, so every new card is captured at
  // score time without a second call.
  const createCardSchema = z.object({
    card: insertCardSchema,
    races: z.array(insertRaceSchema.omit({ cardId: true })).default([]),
    snapshot: snapshotSubmitSchema.optional(),
  });
  app.post("/api/cards", (req, res) => {
    const parsed = createCardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const created = storage.createCard(parsed.data.card, parsed.data.races);
    if (parsed.data.snapshot) {
      upsertSnapshot(created.id, parsed.data.snapshot);
    }
    res.status(201).json(created);
  });

  // ── Backtest snapshot harness ─────────────────────────────────────────────
  // Capture the full pre-race state of a card at score time. Idempotent on
  // (cardId, methodologyVersion). Admin-pin gated (POST under /api).
  app.post("/api/cards/:id/snapshot", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    const parsed = snapshotSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const snap = upsertSnapshot(id, parsed.data);
    res.status(201).json(snap);
  });

  // Record actual race outcomes after the card runs. Upserts per
  // (cardId, raceNum, horseId).
  app.post("/api/cards/:id/outcomes", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    const parsed = outcomesSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const rows = recordOutcomes(id, parsed.data.outcomes);
    res.status(201).json({ recorded: rows.length, outcomes: rows });
  });

  // List snapshot summaries for a methodology version (read — no PIN).
  app.get("/api/backtest/snapshots", (req, res) => {
    const version =
      typeof req.query.methodologyVersion === "string" && req.query.methodologyVersion
        ? req.query.methodologyVersion
        : DEFAULT_METHODOLOGY_VERSION;
    res.json(listSnapshots(version));
  });

  // Per-tier ROI by joining snapshots ↔ outcomes (read — no PIN).
  app.get("/api/backtest/roi", (req, res) => {
    const version =
      typeof req.query.methodologyVersion === "string" && req.query.methodologyVersion
        ? req.query.methodologyVersion
        : DEFAULT_METHODOLOGY_VERSION;
    res.json(computeRoi(version));
  });

  // ── Bankroll ledger (PR #44) ──────────────────────────────────────────────
  // Per-card running bankroll ($1k seed + race grades + manual adjusts).
  app.get("/api/cards/:id/bankroll", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    res.json(storage.getCardBankroll(id));
  });

  const bankrollAdjustSchema = z.object({
    delta: z.number(),
    note: z.string().optional(),
  });
  app.post("/api/cards/:id/bankroll/adjust", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    const parsed = bankrollAdjustSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    storage.adjustCardBankroll(id, parsed.data.delta, parsed.data.note);
    broadcastEvent("card_updated", { cardId: id, source: "bankroll-adjust" });
    res.json(storage.getCardBankroll(id));
  });

  // ── PR #44: one-time cleanup of a card's dirty results ────────────────────
  // Wipes ALL result rows for every race on the card, then re-fetches from OTB
  // and upserts canonical rows. Built so the user can fix Card #9's duplicate
  // result rows from the browser without Railway shell access. Admin-pin gated
  // (POST under /api) PLUS an explicit confirm token to prevent an accidental
  // wipe. Races OTB does not yet show as official stay ungraded.
  const cleanupSchema = z.object({ confirm: z.literal("wipe-and-refetch") });
  app.post("/api/admin/cleanup-card-results/:cardId", async (req, res) => {
    const cardId = Number(req.params.cardId);
    const parsed = cleanupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Confirmation required: send { "confirm": "wipe-and-refetch" }',
      });
    }
    const card = storage.getCard(cardId);
    if (!card) return res.status(404).json({ error: "Card not found" });

    const cardRaces = storage.getRacesByCard(cardId);
    const before: Record<number, boolean> = {};
    for (const r of cardRaces) {
      before[r.raceNumber] = !!storage.getResultByRace(r.id);
      storage.deleteResult(r.id);
    }

    const otb = await fetchOtbResults(card.track, card.date);
    const graded: number[] = [];
    const skipped: number[] = [];
    if (otb) {
      for (const r of cardRaces) {
        const match = otb.races.find((m) => m.raceNumber === r.raceNumber);
        if (match && match.isOfficial && match.finishOrder.length > 0) {
          storage.logResult(r.id, match.finishOrder, {
            autoFetched: true,
            winPayout: match.winPayout ?? null,
            placePayout: match.placePayout ?? null,
            showPayout: match.showPayout ?? null,
            exactaPayout: match.exactaPayout ?? null,
            trifectaPayout: match.trifectaPayout ?? null,
            superfectaPayout: match.superfectaPayout ?? null,
            payoutsRaw: JSON.stringify(match.payoutsRaw),
          });
          graded.push(r.raceNumber);
        } else {
          skipped.push(r.raceNumber);
        }
      }
    }
    // PR #45: wipe any phantom bankroll events (race-grade events whose race no
    // longer has a real graded result) and recompute the running balance from
    // scratch off the surviving events only.
    const phantom = storage.cleanupPhantomBankroll(cardId);
    broadcastEvent("card_updated", { cardId, source: "cleanup" });
    res.json({
      ok: true,
      cardId,
      track: card.track,
      date: card.date,
      otbReachable: !!otb,
      hadResultBefore: before,
      graded,
      skippedUngraded: skipped,
      phantomEventsRemoved: phantom.removed,
      bankroll: storage.getCardBankroll(cardId),
    });
  });

  // Patch a card (e.g. { locked: true }).
  app.patch("/api/cards/:id", (req, res) => {
    const id = Number(req.params.id);
    const patch = req.body as Partial<Card>;
    const updated = storage.updateCard(id, patch);
    if (!updated) return res.status(404).json({ error: "Card not found" });
    res.json(updated);
  });

  // ── Races ────────────────────────────────────────────────────────────────
  // Log a result for a race. Body: { finishOrder: string[] }
  app.post("/api/races/:id/result", (req, res) => {
    const raceId = Number(req.params.id);
    const parsed = resultSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const lockedCard = storage.getCard(race.cardId);
    if (lockedCard?.status === "completed") {
      return res.status(409).json({ error: "Card is completed (read-only). Unlock it in Settings to edit results." });
    }
    try {
      const { finishOrder, ...payouts } = parsed.data;
      // Strip undefined so logResult's ?? null fallbacks apply cleanly.
      const opts: Partial<Result> = {};
      for (const [k, v] of Object.entries(payouts)) {
        if (v !== undefined) (opts as Record<string, number | null>)[k] = v;
      }
      const result = storage.logResult(raceId, finishOrder, opts);
      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Backfill odds + payouts on an ALREADY-graded race (works on any card,
  // including past ones like Card #4). Updates the result row and re-reconciles
  // the bet_legs ledger so per-leg payout/hit reflect the entered numbers.
  app.patch("/api/races/:id/payouts", (req, res) => {
    const raceId = Number(req.params.id);
    const parsed = payoutsSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const payoutRace = storage.getRace(raceId);
    if (payoutRace) {
      const lockedCard = storage.getCard(payoutRace.cardId);
      if (lockedCard?.status === "completed") {
        return res.status(409).json({ error: "Card is completed (read-only). Unlock it in Settings to edit payouts." });
      }
    }
    const opts: Partial<Result> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined) (opts as Record<string, number | null>)[k] = v as number | null;
    }
    const updated = storage.updateResultPayouts(raceId, opts);
    if (!updated) {
      return res.status(404).json({ error: "No graded result for this race — grade it first." });
    }
    res.json(updated);
  });

  // Clear a race's result (PR #44). Removes the result row + un-grades this
  // race's live bet legs + drops its bankroll race-grade event. 204 on success,
  // 404 when there was no result. Admin-pin gated (DELETE under /api).
  app.delete("/api/races/:id/result", (req, res) => {
    const raceId = Number(req.params.id);
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const lockedCard = storage.getCard(race.cardId);
    if (lockedCard?.status === "completed") {
      return res.status(409).json({ error: "Card is completed (read-only). Unlock it in Settings to edit results." });
    }
    const removed = storage.deleteResult(raceId);
    if (!removed) return res.status(404).json({ error: "No result to clear for this race" });
    broadcastEvent("card_updated", { cardId: race.cardId, source: "result-cleared" });
    res.status(204).end();
  });

  // Auto-grade ONE race from OTB on demand (PR #44 "Refresh from OTB" button).
  // Fetches the race's card track/date page and upserts that race's official
  // result. Returns the refreshed card on success, or a 200 status object when
  // OTB has no official result yet (so the UI can toast "not final yet").
  app.post("/api/races/:id/auto-grade", async (req, res) => {
    const raceId = Number(req.params.id);
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const lockedCard = storage.getCard(race.cardId);
    if (lockedCard?.status === "completed") {
      return res.status(409).json({ error: "Card is completed (read-only). Unlock it in Settings to edit results." });
    }
    try {
      const out = await autoGradeRace(raceId);
      if (out.graded) {
        return res.json({ graded: true, raceNumber: out.raceNumber, card: storage.getCardWithRaces(race.cardId) });
      }
      return res.json({ graded: false, reason: out.reason, raceNumber: out.raceNumber });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Update editable analysis text on a race.
  app.patch("/api/races/:id", (req, res) => {
    const raceId = Number(req.params.id);
    const parsed = updateRaceTextSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const updated = storage.updateRaceText(
      raceId,
      parsed.data.whyText,
      parsed.data.paceText,
    );
    if (!updated) return res.status(404).json({ error: "Race not found" });
    res.json(updated);
  });

  // ── Poller ───────────────────────────────────────────────────────────────
  // Force-run the auto-fetcher across all cards, ignoring lock + post-time.
  // Useful for backfilling already-final races without waiting 5 minutes.
  app.post("/api/poller/run-now", async (_req, res) => {
    try {
      const summary = await runPollerNow();
      res.json({ ok: true, ...summary });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Manual PP upload (POST /api/upload-pps) was removed. Card ingest is now
  // fully driven by the Equibase + Brisnet auto-ingest cron; the underlying
  // analyzeCard() pipeline is retained for that path.

  // Review payload: card + races + per-race predictions for the confirm screen.
  app.get("/api/cards/:id/review", (req, res) => {
    const id = Number(req.params.id);
    const card = storage.getCardWithRaces(id);
    if (!card) return res.status(404).json({ error: "Card not found" });
    const racesWithPredictions = card.races.map((r) => ({
      ...r,
      predictions: storage.getPredictionsByRace(r.id),
    }));
    res.json({ ...card, races: racesWithPredictions });
  });

  // Edit a single prediction before publish.
  app.patch("/api/predictions/:id", (req, res) => {
    const id = Number(req.params.id);
    const parsed = updatePredictionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const updated = storage.updatePrediction(id, parsed.data);
    if (!updated) return res.status(404).json({ error: "Prediction not found" });
    res.json(updated);
  });

  // Refresh scratches: re-diff a locked card's roster against its stored source
  // and flag missing horses scratched (idempotent; supports reinstatement). The
  // 15-min cron calls the same function automatically; this is the manual hook.
  app.post("/api/cards/:id/refresh-scratches", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    const result = refreshScratchesForCard(id);
    if (isScratchRefreshError(result)) {
      return res.status(409).json(result);
    }
    res.json(result);
  });

  // Publish: mark the card live (locked = true) so the dashboard + poller act on it.
  app.post("/api/cards/:id/publish", (req, res) => {
    const id = Number(req.params.id);
    const updated = storage.updateCard(id, { locked: true });
    if (!updated) return res.status(404).json({ error: "Card not found" });
    res.json(updated);
  });

  // ── PR #41: Late scratch + re-tier ────────────────────────────────────────
  // Mark a horse (by program number) scratched/un-scratched on a race. The
  // storage layer re-tiers the survivors, rebuilds this race's bet ledger, and
  // records a SCRATCH race_event. Returns the refreshed card so the client can
  // re-render picks + exotics in one round-trip.
  app.post("/api/races/:id/scratch", (req, res) => {
    const raceId = Number(req.params.id);
    const pgm = typeof req.body?.pgm === "string" ? req.body.pgm.trim() : "";
    const scratched = req.body?.scratched !== false; // default true
    if (!pgm) return res.status(400).json({ error: "pgm (program number) is required" });
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const lockedCard = storage.getCard(race.cardId);
    if (lockedCard?.status === "completed") {
      return res.status(409).json({ error: "Card is completed (read-only). Unlock it in Settings to edit." });
    }
    try {
      storage.setHorseScratched(raceId, pgm, scratched);
      res.json(storage.getCardWithRaces(race.cardId));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Force a re-tier pass on a race without changing scratch state (idempotent;
  // useful after manual pick edits). Returns the refreshed card.
  app.post("/api/races/:id/retier", (req, res) => {
    const raceId = Number(req.params.id);
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const lockedCard = storage.getCard(race.cardId);
    if (lockedCard?.status === "completed") {
      return res.status(409).json({ error: "Card is completed (read-only). Unlock it in Settings to edit." });
    }
    try {
      storage.reTier(raceId);
      res.json(storage.getCardWithRaces(race.cardId));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── Edit picks: operator override on any subset of pick slots ────────────
  // Like swap-picks but for direct slot edits (e.g. mid-card tote-board sharp
  // money rearranges place/show). All pick fields optional — only patches what
  // is provided. Does NOT touch tier, scratch state, or whyText/paceText. Records
  // a MANUAL_OVERRIDE race_event with kind=EDIT_PICKS. Returns the refreshed card.
  app.patch("/api/races/:id/picks", (req, res) => {
    const raceId = Number(req.params.id);
    const parsed = updateRacePicksSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const lockedCard = storage.getCard(race.cardId);
    if (lockedCard?.status === "completed") {
      return res.status(409).json({ error: "Card is completed (read-only). Unlock it in Settings to edit." });
    }
    try {
      storage.updateRacePicks(raceId, parsed.data);
      res.json(storage.getCardWithRaces(race.cardId));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── Repair flags: rewrite races.flags as a proper JSON string-array ────────
  // Some legacy cards (e.g. Thistledown #19) wrote flags as plain " | "/"," text
  // instead of JSON, which crashed the client's JSON.parse. The client is now
  // tolerant, but this lets the operator normalize the stored value. Admin-pin
  // gated by the global adminPinGate (mutating /api).
  const updateRaceFlagsSchema = z.object({ flags: z.array(z.string()) });
  app.patch("/api/races/:id/flags", (req, res) => {
    const raceId = Number(req.params.id);
    const parsed = updateRaceFlagsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const updated = storage.updateRaceFlags(raceId, JSON.stringify(parsed.data.flags));
    res.json(updated);
  });

  // ── Wet-track overlay: manual win-pick swap ───────────────────────────────
  // Operator override (gated by adminPinGate like every other mutating /api
  // route). Promotes newWinPgm to win and cascades place→show→fourth; the old
  // win demotes to place. Records a MANUAL_OVERRIDE race_event with the reason.
  // Returns the refreshed card so the dashboard re-renders the picks in one hop.
  app.post("/api/races/:id/swap-picks", (req, res) => {
    const raceId = Number(req.params.id);
    const newWinPgm = typeof req.body?.newWinPgm === "string" ? req.body.newWinPgm.trim() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    if (!newWinPgm) return res.status(400).json({ error: "newWinPgm is required" });
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const lockedCard = storage.getCard(race.cardId);
    if (lockedCard?.status === "completed") {
      return res.status(409).json({ error: "Card is completed (read-only). Unlock it in Settings to edit." });
    }
    try {
      storage.swapWinPick(raceId, newWinPgm, reason);
      res.json(storage.getCardWithRaces(race.cardId));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── PR #41: Mark Card Complete (freeze ROI to lifetime) ───────────────────
  // Lock the card read-only and roll up its card_summary. Returns { card, summary }.
  app.post("/api/cards/:id/complete", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    try {
      const summary = storage.completeCard(id);
      const card = storage.getCard(id);
      res.json({ card, summary });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // PR #42 — re-grade a card under the current model: rebuild its bet_legs
  // ledger (picks up recalibrated tier weights + the Maiden-Claim EX-only gate
  // for betBudgetVersion>=2 cards) and refreeze the summary with PASS-WIN MISS
  // counts. Used to bring already-graded cards onto the v2 model.
  app.post("/api/cards/:id/regrade", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    try {
      const summary = storage.regradeCard(id);
      const card = storage.getCard(id);
      res.json({ card, summary });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Frozen card summary (written at completion). 404 if the card was never
  // completed; the client falls back to live running stats in that case.
  app.get("/api/cards/:id/summary", (req, res) => {
    const id = Number(req.params.id);
    const summary = storage.getCardSummary(id);
    if (!summary) return res.status(404).json({ error: "No summary for this card" });
    res.json(summary);
  });

  // Unlock a completed card so results/payouts can be edited again.
  app.post("/api/cards/:id/unlock", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    try {
      const card = storage.unlockCard(id);
      res.json(card);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── PR #25: Deep post-mortem ("answer key") ───────────────────────────────
  // Run the brutally-objective deep analysis for one card and return the report.
  app.post("/api/cards/:id/deep-postmortem", async (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    try {
      const report = await runDeepPostmortem(id);
      res.json(report);
    } catch (e) {
      console.error(`[deep-postmortem] failed for card ${id}:`, e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Latest saved deep post-mortem for a card. 404 if it was never run.
  app.get("/api/cards/:id/deep-postmortem", (req, res) => {
    const id = Number(req.params.id);
    const report = getDeepPostmortem(id);
    if (!report) return res.status(404).json({ error: "No deep post-mortem for this card" });
    res.json(report);
  });

  // Run the deep post-mortem for every graded card from today. Returns an array.
  app.post("/api/postmortem/today", async (req, res) => {
    try {
      const reports = await runDeepPostmortemToday();
      res.json(reports);
    } catch (e) {
      console.error(`[deep-postmortem] today run failed:`, e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── PR #28: Fusion Replay (tier-tuning v2 validation) ─────────────────────
  // Re-run PR #27's assignTierV2 against the preserved predictions snapshot for
  // one card (no re-ingest) and return the per-race diffs + summary.
  app.post("/api/cards/:id/fusion-replay", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    try {
      res.json(runFusionReplay(id));
    } catch (e) {
      console.error(`[fusion-replay] failed for card ${id}:`, e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── PR #52: Mattice overlay backfill ──────────────────────────────────────
  // Re-run the Mattice 5-factor overlay across an already-ingested card (no
  // re-ingest) and persist the tiebreak/veto/confirmed results — the HTTP twin
  // of scripts/backfill_mattice_card.ts so it can be triggered against the live
  // server via curl. Admin-pin gated by the global adminPinGate (mutating /api
  // POST requires x-admin-pin).
  app.post("/api/cards/:id/mattice-backfill", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    try {
      res.json(runMatticeBackfill(id));
    } catch (e) {
      console.error(`[mattice-backfill] failed for card ${id}:`, e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Replay every graded card dated today. Returns an array of FusionReplay.
  app.post("/api/fusion-replay/today", (_req, res) => {
    try {
      res.json(runFusionReplayToday());
    } catch (e) {
      console.error(`[fusion-replay] today run failed:`, e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // On-demand ingest: pull Equibase + Brisnet for an explicit track+date, run the
  // analyze-card pipeline, and land a DRAFT card for review. Synchronous (< 5 min)
  // so it returns the OnDemandIngestResult directly; SSE events stream progress.
  app.post("/api/cards/on-demand-ingest", async (req, res) => {
    const parsed = onDemandIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const result = await runOnDemandIngest(parsed.data);
    // Always 200 with the structured OnDemandIngestResult — including the failed
    // case — so the client can render per-source diagnostics (which source failed
    // and why) instead of a bare thrown error. The body's `status` field carries
    // success / partial / failed.
    res.status(200).json(result);
  });

  // Discard: delete predictions + the card (cascade removes races/uploads refs).
  app.post("/api/cards/:id/discard", (req, res) => {
    const id = Number(req.params.id);
    const card = storage.getCard(id);
    if (!card) return res.status(404).json({ error: "Card not found" });
    storage.deletePredictionsByCard(id);
    storage.deleteCard(id);
    res.json({ ok: true });
  });

  // ── EEA: Printable daily picks ────────────────────────────────────────────
  // Card + races with per-race bet sizing baked in (one fetch for the print
  // page). Race summaries are fetched separately/in parallel so the page can
  // render immediately and fill summaries in as they generate.
  app.get("/api/cards/:id/print", (req, res) => {
    try {
      const id = Number(req.params.id);
      const card = storage.getCardWithRaces(id);
      if (!card) return res.status(404).json({ error: "Card not found" });
      const settings = storage.getSettings();
      const racesOnCard = card.races.length;
      const dailyCap = settings.bankroll * settings.dailyRiskCapPct;
      // Wagers are already built on each race by storage.withRaces (the single
      // source of truth shared with Race Detail). Print only layers in the
      // cached race summary on top.
      const races = card.races.map((r) => {
        const cached = storage.getRaceSummary(r.id);
        return { ...r, summary: cached?.summary ?? null };
      });
      res.json({
        ...card,
        races,
        sizing: {
          bankroll: settings.bankroll,
          dailyRiskCapPct: settings.dailyRiskCapPct,
          dailyCap,
          racesOnCard,
        },
      });
    } catch (e) {
      console.error(`[print] failed to build print payload for card ${req.params.id}:`, e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Generate (or return cached) Anthropic 2-3 sentence race summary.
  app.post("/api/races/:id/summary", async (req, res) => {
    const raceId = Number(req.params.id);
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    try {
      const summary = await getOrGenerateRaceSummary(race);
      res.json({ summary });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── EEA: Track bias ───────────────────────────────────────────────────────
  app.get("/api/bias/today", async (req, res) => {
    const track = String(req.query.track || storage.getSettings().defaultTrack);
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    const bias = await getOrFetchBias(track, date).catch((e) => {
      throw e;
    });
    if (!bias) return res.status(404).json({ error: "No bias available" });
    res.json(bias);
  });

  app.post("/api/bias/refresh", async (req, res) => {
    const track = String(req.body.track || storage.getSettings().defaultTrack);
    const date = String(req.body.date || new Date().toISOString().slice(0, 10));
    try {
      const bias = await fetchBias(track, date);
      if (!bias) return res.status(404).json({ error: "No bias available" });
      res.json(bias);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── EEA: Tuning proposals ─────────────────────────────────────────────────
  app.get("/api/tuning-proposals", (_req, res) => {
    res.json(storage.getPendingProposals());
  });

  app.post("/api/tuning-proposals/:id/accept", (req, res) => {
    const id = Number(req.params.id);
    const updated = storage.updateProposalStatus(id, "accepted");
    if (!updated) return res.status(404).json({ error: "Proposal not found" });
    res.json(updated);
  });

  app.post("/api/tuning-proposals/:id/reject", (req, res) => {
    const id = Number(req.params.id);
    const updated = storage.updateProposalStatus(id, "rejected");
    if (!updated) return res.status(404).json({ error: "Proposal not found" });
    res.json(updated);
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  app.get("/api/settings", (_req, res) => {
    res.json(storage.getSettings());
  });

  app.patch("/api/settings", (req, res) => {
    const parsed = insertSettingsSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const updated = storage.updateSettings(parsed.data as Partial<Settings>);
    res.json(updated);
  });

  // ── Analytics ────────────────────────────────────────────────────────────
  // Scope-aware: ?scope=today | track | lifetime (default lifetime).
  // For scope=track, pass &track=<Track Name>; optional &date=YYYY-MM-DD
  // narrows that track to a single day (used by Today view single-card path).
  app.get("/api/analytics/summary", (req, res) => {
    const rawScope = String(req.query.scope || "lifetime").toLowerCase();
    const scope: "today" | "track" | "lifetime" =
      rawScope === "today" || rawScope === "track" ? (rawScope as "today" | "track") : "lifetime";
    const track = typeof req.query.track === "string" ? req.query.track : undefined;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    res.json(buildAnalyticsSummary({ scope, track, date }));
  });

  // Ledger ROI (PR #40): tier / position / tier×position / flag ROI from the
  // bet_legs ledger. Same scope contract as /api/analytics/summary.
  app.get("/api/analytics/roi", (req, res) => {
    const rawScope = String(req.query.scope || "lifetime").toLowerCase();
    const scope: "today" | "track" | "lifetime" =
      rawScope === "today" || rawScope === "track" ? (rawScope as "today" | "track") : "lifetime";
    const track = typeof req.query.track === "string" ? req.query.track : undefined;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    res.json(buildLedgerRoi({ scope, track, date }));
  });

  // PR #42 analytics tiles: tier-weight performance, flag performance
  // (ml_favorite_matched / speed_gap / field_size gate), and PASS-WIN MISSES.
  // Same scope contract as /api/analytics/summary.
  app.get("/api/analytics/pr42", (req, res) => {
    const rawScope = String(req.query.scope || "lifetime").toLowerCase();
    const scope: "today" | "track" | "lifetime" =
      rawScope === "today" || rawScope === "track" ? (rawScope as "today" | "track") : "lifetime";
    const track = typeof req.query.track === "string" ? req.query.track : undefined;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    res.json(buildPr42Analytics({ scope, track, date }));
  });

  // Distinct list of tracks with graded race counts, for the Per-Track picker.
  app.get("/api/analytics/tracks", (_req, res) => {
    res.json(buildAnalyticsTracks());
  });

  // ── Book Bets (real sportsbook bets) ───────────────────────────────────────
  // Analytics over the real_bets table — Ken's ACTUAL placed bets (XBNet +
  // Churchill book dump), independent of the Jarvis bet_legs ledger. All GETs
  // accept optional &from=YYYY-MM-DD&to=YYYY-MM-DD date-range filtering.
  function bookScope(req: Request): { from?: string; to?: string } {
    return {
      from: typeof req.query.from === "string" ? req.query.from : undefined,
      to: typeof req.query.to === "string" ? req.query.to : undefined,
    };
  }

  app.get("/api/analytics/book/summary", (req, res) => {
    res.json(buildBookSummary(bookScope(req)));
  });
  app.get("/api/analytics/book/by-track", (req, res) => {
    res.json(buildBookByTrack(bookScope(req)));
  });
  app.get("/api/analytics/book/by-bet-type", (req, res) => {
    res.json(buildBookByBetType(bookScope(req)));
  });
  app.get("/api/analytics/book/by-track-and-type", (req, res) => {
    res.json(buildBookByTrackAndType(bookScope(req)));
  });
  app.get("/api/analytics/book/bankroll-curve", (req, res) => {
    res.json(buildBookBankrollCurve(bookScope(req)));
  });
  app.get("/api/analytics/book/bets", (req, res) => {
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const offset = req.query.offset != null ? Number(req.query.offset) : undefined;
    res.json(
      buildBookBets({
        ...bookScope(req),
        track: typeof req.query.track === "string" ? req.query.track : undefined,
        betType: typeof req.query.betType === "string" ? req.query.betType : undefined,
        result: typeof req.query.result === "string" ? req.query.result : undefined,
        date: typeof req.query.date === "string" ? req.query.date : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      }),
    );
  });

  // Bulk upsert of real bets by bet_id. Admin-gated via the global adminPinGate
  // (x-admin-pin) since this is a POST. Idempotent — used by the book-dump
  // ingestion pipeline. Returns { inserted, updated }.
  app.post("/api/real-bets/bulk-upsert", (req, res) => {
    const parsed = realBetsBulkUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid body", details: parsed.error.flatten() });
    }
    const result = storage.bulkUpsertRealBets(parsed.data.bets);
    res.json(result);
  });

  // Expert Picks Comparison (ingestion + reconcile + read + comparison). The
  // two POSTs inherit the global adminPinGate registered above.
  registerExpertPicksRoutes(app);

  // ── Mattice overlay (PR #51) ───────────────────────────────────────────────
  // Running roll-up + current weight phase for the dashboard tile. Read-only;
  // never mutates the phase (promotion/demotion happens on grading).
  app.get("/api/mattice/stats", (_req, res) => {
    res.json(getMatticeStats());
  });

  // Per-card overlay predictions (scores, vetoes, evidence) for the card view.
  app.get("/api/mattice/by-card/:cardId", (req, res) => {
    const cardId = Number(req.params.cardId);
    if (!Number.isFinite(cardId)) return res.status(400).json({ error: "bad cardId" });
    res.json(storage.getMatticeByCard(cardId));
  });

  // Lifetime scorecard — aggregates across ALL cards (active + archived).
  app.get("/api/stats/lifetime", (_req, res) => {
    res.json(buildLifetimeStats());
  });

  // Track-record hero summary — overall record + flat-bet ROI + units + per-tier
  // breakdown for a timeframe (7D/30D/90D/YTD/ALL, default 30D). Same analytics
  // source as the public /track-record page; this one is auth-gated and adds
  // ROI/units/tier detail.
  app.get("/api/track-record/summary", (req, res) => {
    const raw = String(req.query.timeframe || "30D").toUpperCase();
    const tf: Timeframe = (TIMEFRAMES as string[]).includes(raw) ? (raw as Timeframe) : "30D";
    res.json(buildTrackRecordSummary(tf));
  });

  // ── Public track record (NO AUTH) ─────────────────────────────────────────
  // Powers the public /track-record marketing page. Returns aggregate-only
  // lifetime stats: totals + a by-track breakdown ordered by races graded.
  // Deliberately exposes NO picks, NO horse names, and NO race-level detail —
  // it is built from buildLifetimeStats(), which only ever emits aggregates.
  // This path is whitelisted in the basic-auth middleware (server/index.ts).
  app.get("/api/public/track-record", (_req, res) => {
    const { totals, byTrack } = buildLifetimeStats();
    const ranked = [...byTrack].sort(
      (a, b) => b.graded - a.graded || b.races - a.races || a.track.localeCompare(b.track),
    );
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      totals: {
        cards: totals.cards,
        races: totals.races,
        graded: totals.graded,
        win: totals.win,
        place: totals.place,
        show: totals.show,
        itm: totals.itm,
      },
      byTrack: ranked,
      generatedAt: new Date().toISOString(),
    });
  });

  // ── Jarvis (TTS) ─────────────────────────────────────────────────────────
  app.post("/api/jarvis/brief-card", async (_req, res) => {
    const card = storage.getLatestCard();
    if (!card) return res.status(404).json({ error: "No card to brief" });
    try {
      const { voiceId, modelId, speed } = ttsSettings();
      const script = cardBriefingScript(card);
      const { audioUrl } = await generateSpeech(script, voiceId, modelId, speed);
      res.json({ audioUrl });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/api/jarvis/brief-race/:raceId", async (req, res) => {
    const raceId = Number(req.params.raceId);
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    try {
      const { voiceId, modelId, speed } = ttsSettings();
      const script = raceBriefingScript(race, false);
      const { audioUrl } = await generateSpeech(script, voiceId, modelId, speed);
      res.json({ audioUrl });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/api/jarvis/recap-race/:raceId", async (req, res) => {
    const raceId = Number(req.params.raceId);
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    const result = storage.getResultByRace(raceId);
    if (!result)
      return res.status(404).json({ error: "No result logged for this race" });
    try {
      const { voiceId, modelId, speed } = ttsSettings();
      const script = raceRecapScript(race, result);
      const { audioUrl } = await generateSpeech(script, voiceId, modelId, speed);
      res.json({ audioUrl });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/api/jarvis/summary-card/:cardId", async (req, res) => {
    const cardId = Number(req.params.cardId);
    const card = storage.getCardWithRaces(cardId);
    if (!card) return res.status(404).json({ error: "Card not found" });
    try {
      const { voiceId, modelId, speed } = ttsSettings();
      const script = cardSummaryScript(card, buildCardStats(card));
      const { audioUrl } = await generateSpeech(script, voiceId, modelId, speed);
      res.json({ audioUrl });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Arbitrary speech (used by Settings "Test Voice"). Body: { text, voiceId?, modelId?, speed? }
  const speakSchema = z.object({
    text: z.string().min(1),
    voiceId: z.string().optional(),
    modelId: z.string().optional(),
    speed: z.number().optional(),
  });
  app.post("/api/jarvis/speak", async (req, res) => {
    const parsed = speakSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    try {
      const defaults = ttsSettings();
      const voiceId = parsed.data.voiceId ?? defaults.voiceId;
      const modelId = parsed.data.modelId ?? defaults.modelId;
      const speed = parsed.data.speed ?? defaults.speed;
      const { audioUrl } = await generateSpeech(
        parsed.data.text,
        voiceId,
        modelId,
        speed,
      );
      res.json({ audioUrl });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Voice subsystem (live trackside observations) ─────────────────────────
  app.use("/api/voice", voiceRouter());

  // ── Trackside Daily Show ──────────────────────────────────────────────────
  app.use("/api/show", showApiRouter());
  app.use("/show", showFileRouter());

  // ── Equibase PP ingest admin (behind global basic auth) ───────────────────
  app.use("/api/admin/equibase", equibaseAdminRouter());

  // ── Brisnet DRM ingest admin (behind global basic auth) ───────────────────
  app.use("/api/admin/brisnet", brisnetAdminRouter());

  // ── Manual PDF drop ingest (PR #33) ───────────────────────────────────────
  // POST /api/cards/manual-ingest — drop Brisnet (+ optional Equibase) PPs PDFs
  // for a track+date, run the analyze-card pipeline, land a draft card.
  app.use("/api/cards", manualIngestRouter());

  // ── Voices proxy ─────────────────────────────────────────────────────────
  app.get("/api/voices", async (_req, res) => {
    const voices = await fetchVoices();
    res.json(voices);
  });

  // ── Server-Sent Events ───────────────────────────────────────────────────
  app.get("/api/events", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    addSseClient(res);

    // Keep-alive ping so proxies don't drop the connection.
    const ping = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* ignore */
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(ping);
      removeSseClient(res);
    });
  });

  // ── Cached audio files ───────────────────────────────────────────────────
  app.get("/audio/:hash", (req, res) => {
    const hash = req.params.hash.replace(/\.mp3$/i, "");
    const filePath = getCachedFilePath(hash);
    if (!filePath) return res.status(404).json({ error: "Audio not found" });
    res.setHeader("Content-Type", "audio/mpeg");
    res.sendFile(filePath);
  });

  return httpServer;
}

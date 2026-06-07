import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { storage, seedSaratogaCard, seedFormulaVersion } from "./storage";
import {
  insertCardSchema,
  insertRaceSchema,
  resultSubmitSchema,
  updateRaceTextSchema,
  insertSettingsSchema,
  updatePredictionSchema,
} from "@shared/schema";
import type { Card, Settings } from "@shared/schema";
import { z } from "zod";
import { analyzeCard } from "./services/analyze-card";
import { getOrFetchBias, fetchBias } from "./services/bias-fetcher";
import { buildAnalyticsSummary, buildCardStats } from "./analytics";
import {
  cardBriefingScript,
  raceBriefingScript,
  raceRecapScript,
  cardSummaryScript,
} from "./services/scripts";
import { generateSpeech, getCachedFilePath, fetchVoices } from "./services/tts";
import { addSseClient, removeSseClient } from "./services/events";
import { startPoller, runPollerNow } from "./services/poller";

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
  startPoller();

  // ── Cards ────────────────────────────────────────────────────────────────
  app.get("/api/cards", (_req, res) => {
    res.json(storage.getCards());
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

  // Create a card. Body: { card: InsertCard, races: Omit<InsertRace,"cardId">[] }
  const createCardSchema = z.object({
    card: insertCardSchema,
    races: z.array(insertRaceSchema.omit({ cardId: true })).default([]),
  });
  app.post("/api/cards", (req, res) => {
    const parsed = createCardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const created = storage.createCard(parsed.data.card, parsed.data.races);
    res.status(201).json(created);
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
    try {
      const result = storage.logResult(raceId, parsed.data.finishOrder);
      res.status(201).json(result);
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

  // ── EEA: Upload + analyze a card ──────────────────────────────────────────
  const uploadDir = path.resolve(process.cwd(), "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) =>
        cb(null, `${randomUUID()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
    }),
    limits: { fileSize: 64 * 1024 * 1024 },
  });

  // multipart: brisnetPdf, equibasePdf, track, date, provider?
  app.post(
    "/api/upload-pps",
    upload.fields([
      { name: "brisnetPdf", maxCount: 1 },
      { name: "equibasePdf", maxCount: 1 },
    ]),
    async (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const bris = files?.brisnetPdf?.[0];
      const equi = files?.equibasePdf?.[0];
      const track = String(req.body.track || "").trim();
      const date = String(req.body.date || "").trim();
      const provider =
        req.body.provider === "poe" || req.body.provider === "anthropic"
          ? (req.body.provider as "poe" | "anthropic")
          : undefined;
      if (!bris || !equi) {
        return res.status(400).json({ error: "Both brisnetPdf and equibasePdf are required" });
      }
      if (!track || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "track and date (YYYY-MM-DD) are required" });
      }
      try {
        const result = await analyzeCard({
          track,
          date,
          brisnetPath: bris.path,
          equibasePath: equi.path,
          brisnetFilename: bris.originalname,
          equibaseFilename: equi.originalname,
          provider,
        });
        res.status(201).json(result);
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

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

  // Publish: mark the card live (locked = true) so the dashboard + poller act on it.
  app.post("/api/cards/:id/publish", (req, res) => {
    const id = Number(req.params.id);
    const updated = storage.updateCard(id, { locked: true });
    if (!updated) return res.status(404).json({ error: "Card not found" });
    res.json(updated);
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
  app.get("/api/analytics/summary", (_req, res) => {
    res.json(buildAnalyticsSummary());
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

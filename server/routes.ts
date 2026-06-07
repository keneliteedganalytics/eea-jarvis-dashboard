import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage, seedSaratogaCard } from "./storage";
import {
  insertCardSchema,
  insertRaceSchema,
  resultSubmitSchema,
  updateRaceTextSchema,
  insertSettingsSchema,
} from "@shared/schema";
import type { Card, Settings } from "@shared/schema";
import { z } from "zod";
import { buildAnalyticsSummary, buildCardStats } from "./analytics";
import {
  cardBriefingScript,
  raceBriefingScript,
  raceRecapScript,
  cardSummaryScript,
} from "./services/scripts";
import { generateSpeech, getCachedFilePath, fetchVoices } from "./services/tts";
import { addSseClient, removeSseClient } from "./services/events";
import { startPoller } from "./services/poller";

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

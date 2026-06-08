// Voice subsystem routes — the trackside live-update loop.
//
//   transcribe  audio  -> Scribe STT (keyterm-primed) -> clean transcript
//   process     text   -> expert persona -> spoken reply + proposed changes
//   confirm     id     -> apply changes, snapshot history, re-broadcast card
//   undo               -> revert the last applied voice change
//   speak       text   -> reuse existing TTS pipeline for the spoken reply
//   history     cardId -> persisted conversation for the slide-out panel
//
// Tier math is deterministic on apply; the LLM only proposes. Race ids are
// always resolved server-side from race_number so a model hallucination can't
// mutate the wrong row.

import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { storage } from "../storage";
import { transcribeAudio } from "../services/stt";
import {
  processVoiceTurn,
  cardKeyterms,
  resolveRaceId,
  type ConversationTurn,
} from "../services/voice-persona";
import { generateSpeech } from "../services/tts";
import { broadcastEvent } from "../services/events";
import type { TierChange } from "@shared/schema";

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

function ttsSettings() {
  const s = storage.getSettings();
  return {
    voiceId: s.elevenlabsVoiceId, // Jarvis (Brian)
    scarlettVoiceId: s.elevenlabsVoiceIdScarlett, // Scarlett (Sarah)
    modelId: s.elevenlabsModelId,
    speed: s.voiceSpeed,
  };
}

// Resolve the card the voice loop acts on. Prefer an explicit id; fall back to
// the latest card (the dashboard always shows the latest).
function resolveCardId(explicit?: number) {
  if (explicit && Number.isFinite(explicit)) {
    const c = storage.getCardWithRaces(explicit);
    if (c) return c;
  }
  return storage.getLatestCard();
}

export function voiceRouter(): Router {
  const router = Router();

  // ── Transcribe ────────────────────────────────────────────────────────────
  // multipart: audio (file) + cardId (optional). Returns { transcript }.
  router.post("/transcribe", uploadMem.single("audio"), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No audio uploaded" });
    const cardId = req.body.cardId ? Number(req.body.cardId) : undefined;
    const card = resolveCardId(cardId);
    try {
      const transcript = await transcribeAudio(file.buffer, {
        keyterms: card ? cardKeyterms(card) : [],
        mimeType: file.mimetype,
      });
      res.json({ transcript });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Process ───────────────────────────────────────────────────────────────
  // Body: { transcript, cardId?, activeRaceNumber?, history? }
  // Returns the structured persona response + a TTS url for the spoken reply,
  // and persists the exchange so it survives reload.
  const processSchema = z.object({
    transcript: z.string().min(1),
    cardId: z.number().int().optional(),
    activeRaceNumber: z.number().int().optional(),
    history: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
      .optional(),
  });
  router.post("/process", async (req, res) => {
    const parsed = processSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const card = resolveCardId(parsed.data.cardId);
    if (!card) return res.status(404).json({ error: "No active card" });

    try {
      const result = await processVoiceTurn(
        parsed.data.transcript,
        { card, activeRaceNumber: parsed.data.activeRaceNumber },
        (parsed.data.history as ConversationTurn[]) ?? [],
      );

      // Resolve proposed race_number -> raceId now so the client confirm step
      // can't be tricked into editing the wrong race.
      const resolvedChanges: TierChange[] = [];
      for (const c of result.proposedChanges) {
        const race = resolveRaceId(card, c.race_number);
        if (!race) continue;
        resolvedChanges.push({
          raceId: race.id,
          horsePgm: c.horse_pgm,
          horseName: c.horse_name,
          oldTier: c.old_tier,
          newTier: c.new_tier,
          reason: c.reason,
        });
      }

      // Persist the exchange. appliedChanges stays null until confirmed; the
      // /confirm flow looks the conversation up by id.
      const convo = storage.createVoiceConversation({
        cardId: card.id,
        userTranscript: parsed.data.transcript,
        jarvisResponse: result.spokenResponse,
        appliedChanges: null,
        contextSummary: result.contextSummary ?? null,
      });

      // Voice routing: Jarvis (Brian) speaks tier-change actions; Scarlett
      // (Sarah) speaks informational replies. Pass the right voice id to TTS.
      const { voiceId, scarlettVoiceId, modelId, speed } = ttsSettings();
      const speakVoiceId = result.voice === "jarvis" ? voiceId : scarlettVoiceId;

      let audioUrl: string | null = null;
      try {
        const speech = await generateSpeech(result.spokenResponse, speakVoiceId, modelId, speed);
        audioUrl = speech.audioUrl;
      } catch {
        // TTS failure shouldn't kill the text flow — client falls back to text.
        audioUrl = null;
      }

      res.json({
        conversationId: convo.id,
        spokenResponse: result.spokenResponse,
        proposedChanges: resolvedChanges,
        needsConfirmation: result.needsConfirmation && resolvedChanges.length > 0,
        contextSummary: result.contextSummary ?? null,
        voice: result.voice,
        audioUrl,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Confirm ─────────────────────────────────────────────────────────────
  // Body: { conversationId, changes: TierChange[] }. Snapshots each affected
  // race, applies the new tier, marks the conversation as applied, and
  // broadcasts so the dashboard recomputes silently in place.
  const confirmSchema = z.object({
    conversationId: z.number().int(),
    changes: z
      .array(
        z.object({
          raceId: z.number().int(),
          horsePgm: z.string().optional(),
          horseName: z.string().optional(),
          oldTier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
          newTier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
          reason: z.string(),
        }),
      )
      .min(1),
  });
  router.post("/confirm", (req, res) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const convo = storage.getVoiceConversation(parsed.data.conversationId);
    if (!convo) return res.status(404).json({ error: "Conversation not found" });

    for (const change of parsed.data.changes) {
      const race = storage.getRace(change.raceId);
      if (!race) continue;
      // Snapshot BEFORE mutating so undo restores the pre-change state.
      storage.snapshotRace(convo.cardId, change.raceId, "voice_update", convo.id);
      storage.updateRaceFusion(change.raceId, { tier: change.newTier });
    }

    storage.createVoiceConversationApplied(convo.id, JSON.stringify(parsed.data.changes));
    broadcastEvent("card_updated", { cardId: convo.cardId, source: "voice" });

    const card = storage.getCardWithRaces(convo.cardId);
    res.json({ ok: true, card });
  });

  // ── Undo ────────────────────────────────────────────────────────────────
  // Body: { cardId? }. Reverts the most recent applied voice change on the card
  // by restoring each affected race from its snapshot.
  router.post("/undo", (req, res) => {
    const cardId = req.body.cardId ? Number(req.body.cardId) : undefined;
    const card = resolveCardId(cardId);
    if (!card) return res.status(404).json({ error: "No active card" });

    const last = storage.getLastAppliedVoiceConversation(card.id);
    if (!last || !last.appliedChanges) {
      return res.json({ ok: false, reverted: false, message: "Nothing to undo." });
    }

    const changes = JSON.parse(last.appliedChanges) as TierChange[];
    for (const change of changes) {
      const snap = storage.getLatestSnapshot(change.raceId);
      if (snap) {
        const fields = JSON.parse(snap.snapshot) as Record<string, unknown>;
        storage.updateRaceFusion(change.raceId, fields);
      }
    }
    storage.markVoiceConversationReverted(last.id);
    broadcastEvent("card_updated", { cardId: card.id, source: "voice_undo" });

    const updated = storage.getCardWithRaces(card.id);
    res.json({ ok: true, reverted: true, card: updated });
  });

  // ── Speak (TTS passthrough for arbitrary Jarvis text) ─────────────────────
  const speakSchema = z.object({ text: z.string().min(1) });
  router.post("/speak", async (req, res) => {
    const parsed = speakSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const { voiceId, modelId, speed } = ttsSettings();
      const { audioUrl } = await generateSpeech(parsed.data.text, voiceId, modelId, speed);
      res.json({ audioUrl });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── History (per card, for the slide-out panel) ───────────────────────────
  router.get("/history", (req, res) => {
    const cardId = req.query.cardId ? Number(req.query.cardId) : undefined;
    const card = resolveCardId(cardId);
    if (!card) return res.json({ conversations: [] });
    res.json({ conversations: storage.getVoiceConversations(card.id) });
  });

  return router;
}

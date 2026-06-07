import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { audioCache } from "@shared/schema";
import { eq } from "drizzle-orm";

// Resolve a stable on-disk cache directory. In dev (tsx/ESM) and prod (esbuild
// CJS bundle) we anchor to the project working directory so the path is stable.
export const AUDIO_DIR = path.join(process.cwd(), "server", "audio_cache");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const VOICE_SPEED_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };

export function hashScript(voiceId: string, modelId: string, text: string): string {
  return crypto.createHash("sha256").update(`${voiceId}|${modelId}|${text}`).digest("hex");
}

export interface SpeechResult {
  audioUrl: string;
  cached: boolean;
}

export async function generateSpeech(
  text: string,
  voiceId: string,
  modelId: string,
  speed = 1.0,
): Promise<SpeechResult> {
  const scriptHash = hashScript(voiceId, modelId, `${text}::${speed}`);

  // Cache lookup
  const existing = db.select().from(audioCache).where(eq(audioCache.scriptHash, scriptHash)).get();
  if (existing && fs.existsSync(existing.filePath)) {
    return { audioUrl: `/audio/${scriptHash}`, cached: true };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const body: Record<string, unknown> = {
    text,
    model_id: modelId,
    voice_settings: { ...VOICE_SPEED_SETTINGS, speed },
  };

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${errText.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(AUDIO_DIR, `${scriptHash}.mp3`);
  fs.writeFileSync(filePath, buffer);

  // Upsert into cache
  db.delete(audioCache).where(eq(audioCache.scriptHash, scriptHash)).run();
  db.insert(audioCache).values({ scriptHash, voiceId, modelId, text, filePath }).run();

  return { audioUrl: `/audio/${scriptHash}`, cached: false };
}

export function getCachedFilePath(hash: string): string | null {
  const row = db.select().from(audioCache).where(eq(audioCache.scriptHash, hash)).get();
  if (!row) return null;
  if (!fs.existsSync(row.filePath)) return null;
  return row.filePath;
}

// Proxy ElevenLabs voice list. Returns [] on any failure (UI falls back to premades).
export async function fetchVoices(): Promise<{ id: string; name: string; desc: string }[]> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    if (!Array.isArray(data?.voices)) return [];
    return data.voices.map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      desc: v.labels
        ? [v.labels.accent, v.labels.description, v.labels.age].filter(Boolean).join(", ")
        : v.category || "",
    }));
  } catch {
    return [];
  }
}

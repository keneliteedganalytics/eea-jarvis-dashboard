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

// Convert a dollar amount like "$6.82" -> "six dollars and eighty-two cents",
// "$2,542.20" -> "two thousand five hundred forty-two dollars and twenty cents".
function speakMoney(raw: string): string {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return raw;
  const dollars = Math.floor(n);
  const cents = Math.round((n - dollars) * 100);
  if (cents === 0) return `${dollars} dollars`;
  return `${dollars} dollars and ${cents} cents`;
}

// Pre-process recap/briefing text so ElevenLabs reads it naturally.
// - Money: "$6.82" -> "6 dollars and 82 cents"
// - Odds:  "7/2" -> "7 to 2"
// - Finish strings: "2-1-7-5" -> "2, 1, 7, 5"
// - Shorthand: "#3" -> "number 3", "R5" -> "Race 5"
// - Abbreviations: ML, PP, SPD, E1/E2/LP, G1/G2/G3, ITM, ROI
export function sanitizeForTTS(text: string): string {
  let s = text;

  // Money first (before generic number handling).
  s = s.replace(/\$\s?[\d,]+(?:\.\d{1,2})?/g, (m) => speakMoney(m));

  // Morning-line odds like 7/2, 5/2, 9/5, 12/1. Avoid dates by requiring small ints.
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})\b/g, "$1 to $2");

  // Finish strings: 2-1-7-5 or 2-11-9 -> commas. Require at least 2 dashes so we
  // don't mangle hyphenated words.
  s = s.replace(/\b(\d{1,2})-(\d{1,2})-(\d{1,2})(?:-(\d{1,2}))?\b/g, (_m, a, b, c, d) =>
    d ? `${a}, ${b}, ${c}, ${d}` : `${a}, ${b}, ${c}`,
  );

  // Race / horse number shorthand.
  s = s.replace(/#\s?(\d+)/g, "number $1");
  s = s.replace(/\bR(\d{1,2})\b/g, "Race $1");

  // Tier / grade / handicapping abbreviations. Word-boundary safe.
  s = s.replace(/\bML\b/g, "morning line");
  s = s.replace(/\bPP\b/g, "post position");
  s = s.replace(/\bSPD\b/g, "speed");
  s = s.replace(/\bE1\b/g, "early speed one");
  s = s.replace(/\bE2\b/g, "early speed two");
  s = s.replace(/\bLP\b/g, "late pace");
  s = s.replace(/\bG1\b/g, "Grade one");
  s = s.replace(/\bG2\b/g, "Grade two");
  s = s.replace(/\bG3\b/g, "Grade three");
  s = s.replace(/\bITM\b/g, "in the money");
  s = s.replace(/\bROI\b/g, "R O I");
  s = s.replace(/\bW\/P\/S\b/gi, "win, place, show");
  s = s.replace(/\bWPS\b/g, "win, place, show");
  s = s.replace(/\bWIN\b/g, "win");
  s = s.replace(/\bPLACE\b/g, "place");
  s = s.replace(/\bSHOW\b/g, "show");

  // Tier names in caps -> Title case so prosody is natural.
  s = s.replace(/\bSNIPER\b/g, "Sniper");
  s = s.replace(/\bEDGE\b/g, "Edge");
  s = s.replace(/\bRECON\b/g, "Recon");
  s = s.replace(/\bDUAL\b/g, "Dual");
  s = s.replace(/\bPASS\b/g, "pass");

  // Common track / chart shorthand. "6f" / "5.5f" -> "6 furlongs".
  s = s.replace(/\b(\d+(?:\.\d+)?)f\b/g, "$1 furlongs");
  s = s.replace(/\bMSW\b/g, "maiden special weight");
  s = s.replace(/\bMCL\b/g, "maiden claiming");
  s = s.replace(/\bAOC\b/g, "allowance optional claiming");
  s = s.replace(/\bN1X\b/g, "non-winners one other than");
  s = s.replace(/\bN2X\b/g, "non-winners two other than");
  s = s.replace(/\bSTK\b/g, "stakes");

  // Tighten whitespace.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

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
  const speakable = sanitizeForTTS(text);
  const scriptHash = hashScript(voiceId, modelId, `${speakable}::${speed}`);

  // Cache lookup
  const existing = db.select().from(audioCache).where(eq(audioCache.scriptHash, scriptHash)).get();
  if (existing && fs.existsSync(existing.filePath)) {
    return { audioUrl: `/audio/${scriptHash}`, cached: true };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const body: Record<string, unknown> = {
    text: speakable,
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
  db.insert(audioCache).values({ scriptHash, voiceId, modelId, text: speakable, filePath }).run();

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

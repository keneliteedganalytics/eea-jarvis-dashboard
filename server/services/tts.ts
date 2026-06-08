import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { audioCache } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getDictionaryLocator, injectSsmlPhonemes } from "./pronunciation";

// Resolve a stable on-disk cache directory. In dev (tsx/ESM) and prod (esbuild
// CJS bundle) we anchor to the project working directory so the path is stable.
// On Railway (or any container), set AUDIO_DIR to a path on the persistent
// volume (e.g. /data/audio_cache). Falls back to the legacy in-repo path for
// local dev where dotfiles in cwd are fine.
export const AUDIO_DIR =
  process.env.AUDIO_DIR || path.join(process.cwd(), "server", "audio_cache");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const VOICE_SPEED_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };

// ---------------------------------------------------------------------------
// Number-to-words. Spelling out money is far more reliable on ElevenLabs than
// passing raw digits — the model otherwise runs "$6.82" into "six-eighty-two".
// Covers 0 through 999,999,999. Returns lowercase, no commas, no "and".
// ---------------------------------------------------------------------------
const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function intToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return "zero";

  const parts: string[] = [];

  const billions = Math.floor(n / 1_000_000_000);
  if (billions > 0) {
    parts.push(`${intToWords(billions)} billion`);
    n %= 1_000_000_000;
  }
  const millions = Math.floor(n / 1_000_000);
  if (millions > 0) {
    parts.push(`${intToWords(millions)} million`);
    n %= 1_000_000;
  }
  const thousands = Math.floor(n / 1000);
  if (thousands > 0) {
    parts.push(`${intToWords(thousands)} thousand`);
    n %= 1000;
  }
  const hundreds = Math.floor(n / 100);
  if (hundreds > 0) {
    parts.push(`${ONES[hundreds]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    parts.push(o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(" ");
}

// "$6.82" -> "six dollars and eighty-two cents"
// "$2,542.20" -> "two thousand five hundred forty-two dollars and twenty cents"
// "$0.20" -> "twenty cents"
// "$1.00" -> "one dollar"
// "$5" -> "five dollars"
function speakMoney(raw: string): string {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return raw;
  const dollars = Math.floor(n);
  const cents = Math.round((n - dollars) * 100);

  if (dollars === 0 && cents === 0) return "zero dollars";
  if (dollars === 0) return `${intToWords(cents)} cents`;
  if (cents === 0) return dollars === 1 ? "one dollar" : `${intToWords(dollars)} dollars`;
  const dWord = dollars === 1 ? "one dollar" : `${intToWords(dollars)} dollars`;
  const cWord = cents === 1 ? "one cent" : `${intToWords(cents)} cents`;
  return `${dWord} and ${cWord}`;
}

// Pre-process recap/briefing text so ElevenLabs reads it naturally.
// - Money: "$6.82" -> "six dollars and eighty-two cents"
// - Odds:  "7/2" -> "7 to 2"
// - Finish strings: "2-1-7-5" -> "2, 1, 7, 5"
// - Shorthand: "#3" -> "number 3", "R5" -> "Race 5"
// - Abbreviations: ML, PP, SPD, E1/E2/LP, G1/G2/G3, ITM, ROI
export function sanitizeForTTS(text: string): string {
  let s = text;

  // Money first (before generic number handling).
  // Catches: $6, $6.8, $6.82, $2,542.20, $0.20
  s = s.replace(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\$\s?\d+(?:\.\d{1,2})?/g, (m) => speakMoney(m));

  // ---- DISTANCES (run before odds so 1/16 in "1 1/16M" doesn't become "1 to 16M") ----
  // Unicode fractions seen on race cards.
  s = s.replace(/½/g, " and a half");
  s = s.replace(/¼/g, " and a quarter");
  s = s.replace(/¾/g, " and three quarters");
  s = s.replace(/⅛/g, " and an eighth");
  s = s.replace(/⅜/g, " and three eighths");
  s = s.replace(/⅝/g, " and five eighths");
  s = s.replace(/⅞/g, " and seven eighths");

  // Compound mile distances: "1 1/16M" -> "one and one sixteenth miles",
  // "1 1/8M" -> "one and one eighth miles", "1 3/8M" -> "one and three eighths miles".
  const fractionWord: Record<string, string> = {
    "1/16": "one sixteenth", "1/8": "one eighth", "1/4": "a quarter",
    "3/16": "three sixteenths", "5/16": "five sixteenths", "3/8": "three eighths",
    "7/16": "seven sixteenths", "1/2": "a half", "9/16": "nine sixteenths",
    "5/8": "five eighths", "11/16": "eleven sixteenths", "3/4": "three quarters",
    "13/16": "thirteen sixteenths", "7/8": "seven eighths", "15/16": "fifteen sixteenths",
  };
  s = s.replace(/\b(\d)\s+(\d{1,2}\/\d{1,2})\s*M\b/gi, (_m, whole, frac) => {
    const w = fractionWord[frac];
    if (!w) return `${whole} ${frac} miles`;
    return `${whole === "1" ? "one" : whole} and ${w} miles`;
  });
  // Bare "1M" / "2M" / "1.5M" without a fraction prefix.
  s = s.replace(/\b(\d+(?:\.\d+)?)\s*M\b(?!\w)/g, (_m, n) => (n === "1" ? "one mile" : `${n} miles`));

  // Furlongs: "6F" / "6f" / "5.5F" / "5 and a half F" -> "6 furlongs".
  s = s.replace(/\b(\d+(?:\.\d+)?)(?:\s+and\s+(?:a|an|three|five|seven)\s+(?:half|quarter|quarters|eighth|eighths|sixteenths?))?\s*F\b(?!\w)/gi,
    (m, _n) => `${m.slice(0, -1).trimEnd()} furlongs`);

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
  s = s.replace(/\bRR\s*(\d+)/g, "race rating $1");
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

  // Class / race-type shorthand (after distance handling so "M" suffix is already gone).
  s = s.replace(/\bMSW\b/g, "maiden special weight");
  s = s.replace(/\bMCL\b/g, "maiden claiming");
  s = s.replace(/\bAOC\b/g, "allowance optional claiming");
  s = s.replace(/\bAlw\b/gi, "allowance");
  s = s.replace(/\bMdn\b/gi, "maiden");
  s = s.replace(/\bMCl\b/g, "maiden claiming");
  s = s.replace(/\bOptClm\b/gi, "optional claiming");
  s = s.replace(/\bClm\b/gi, "claiming");
  s = s.replace(/\bN1X\b/g, "non-winners one other than");
  s = s.replace(/\bN2X\b/g, "non-winners two other than");
  s = s.replace(/\bN3X\b/g, "non-winners three other than");
  s = s.replace(/\bSTK\b/g, "stakes");
  s = s.replace(/\bS\.(?=\s*\()/g, "Stakes");                    // "Poker S. (G3)" -> "Poker Stakes (G3)"
  s = s.replace(/\b(\d+)YO\b/g, "$1 year olds");                  // "2YO" -> "2 year olds"
  s = s.replace(/\bF&M\b/g, "fillies and mares");
  s = s.replace(/\b(\d+)\s*UP\b/g, "$1 and up");                  // "3UP" -> "3 and up"

  // Purse shorthand: "105k" -> "105 thousand" (after money + distance so no conflict).
  s = s.replace(/\b(\d+(?:\.\d+)?)k\b/g, "$1 thousand");

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

  // Pronunciation overrides (track names, racing terms, surnames). Preferred:
  // an uploaded ElevenLabs dictionary attached via locator (no text change).
  // Fallback: inject SSML <phoneme> tags into the text for this single call.
  // Degrades to a plain pass-through if the dictionary is missing/unreachable.
  const locator = await getDictionaryLocator();
  const finalText = locator ? speakable : injectSsmlPhonemes(speakable);

  // Cache key includes the locator id (or "ssml"/"none") so swapping the
  // pronunciation mechanism never serves stale audio for the same script.
  const dictTag = locator ? locator.pronunciation_dictionary_id : finalText === speakable ? "none" : "ssml";
  const scriptHash = hashScript(voiceId, modelId, `${finalText}::${speed}::${dictTag}`);

  // Cache lookup
  const existing = db.select().from(audioCache).where(eq(audioCache.scriptHash, scriptHash)).get();
  if (existing && fs.existsSync(existing.filePath)) {
    return { audioUrl: `/audio/${scriptHash}`, cached: true };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const body: Record<string, unknown> = {
    text: finalText,
    model_id: modelId,
    voice_settings: { ...VOICE_SPEED_SETTINGS, speed },
  };
  if (locator) {
    body.pronunciation_dictionary_locators = [locator];
  }

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
  db.insert(audioCache).values({ scriptHash, voiceId, modelId, text: finalText, filePath }).run();

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

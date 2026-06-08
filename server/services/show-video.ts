// Daily Show storage + prompt helpers.
//
// ARCHITECTURE: video generation no longer runs in this process. The Railway
// container can't reach the Veo CLI (`asi-generate-video` only exists in the
// Perplexity sandbox — the in-container spawn failed with ENOENT). Instead,
// Computer fetches the authoritative script via GET /api/show/script/:cardId,
// generates the clips locally, and POSTs the MP4s + manifest back to
// POST /api/show/upload/:cardId. Railway just stores and serves.
//
// What remains here: the on-disk layout helpers (showRoot/cardShowDir) and the
// Veo prompt builder — exported so Computer's prompt construction can mirror the
// exact phrasing the dashboard expects, and so the prompt stays unit-testable.

import path from "node:path";
import type { ShowManifest } from "@shared/schema";
import { AUDIO_DIR } from "./tts";
import { dialogueTranscript, type SpeakerLine } from "./show-script";

export const VEO_MODEL = "veo_3_1";
export const CLIP_DURATION_SEC = 8;

// Persistent show root: sibling of AUDIO_DIR (e.g. /data/audio_cache -> /data/show)
// so it lands on the same Railway volume. Falls back to /data/show, then an
// in-repo path for local dev.
export function showRoot(): string {
  const fromAudio = path.join(path.dirname(AUDIO_DIR), "show");
  return process.env.SHOW_DIR || fromAudio;
}

export function cardShowDir(cardId: number): string {
  return path.join(showRoot(), String(cardId));
}

// Build the Veo prompt for one segment: minimal motion, broadcast camera
// language, explicit lip-sync direction, and the embedded dialogue script.
// Kept here (and exported) so Computer can reproduce the exact prompt shape.
export function buildVeoPrompt(
  track: string,
  label: string,
  lines: SpeakerLine[],
): string {
  const dialogue = dialogueTranscript(lines);
  return [
    `Broadcast horse-racing studio segment filmed trackside at ${track}.`,
    `Two on-air hosts stand together in a paddock backdrop: Jarvis (lead analyst) on the left and Scarlett (paddock reporter) on the right.`,
    `Locked medium two-shot, broadcast composition, soft handheld breathing, shallow depth of field.`,
    `Minimal motion: subtle wind in hair and clothing, natural blinks, slight hand gestures while speaking; horses pass softly behind them, out of focus.`,
    `Both hosts speak their lines naturally, clearly lip-synced, alternating turns — Jarvis then Scarlett — matching the dialogue exactly.`,
    `Warm professional broadcast lighting, gold-and-navy lower-third feel, daytime.`,
    `Segment: ${label}.`,
    `Spoken dialogue (lip-synced, in order):`,
    dialogue,
  ].join("\n");
}

// Re-export the manifest type for callers that build/read manifests on disk.
export type { ShowManifest };

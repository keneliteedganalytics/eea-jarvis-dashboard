// Daily Show video pipeline. For each card we build an Overview clip + one clip
// per race using Veo 3.1 (native synced audio + lip-sync), seeded with the
// track-specific trackside keyframe. Clips run SERIALLY to keep memory sane;
// total runtime for a 10-race card is ~10-15 min, which is acceptable for a
// 7am background build. The manifest.json is written LAST so any concurrent
// read sees a consistent (all-or-nothing) ready state.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CardWithRaces, ShowManifest, ShowSegment } from "@shared/schema";
import { AUDIO_DIR } from "./tts";
import { resolveKeyframe } from "./show-keyframes";
import {
  buildShowScript,
  dialogueTranscript,
  type SpeakerLine,
  type ShowScriptSegment,
} from "./show-script";

const execFileAsync = promisify(execFile);

const VEO_MODEL = "veo_3_1";
const CLIP_DURATION_SEC = 8;
const VIDEO_CLI = process.env.SHOW_VIDEO_CLI || "asi-generate-video";

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
function buildVeoPrompt(
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

interface ClipSpec {
  id: string; // "overview" | "r1" ...
  label: string;
  lines: SpeakerLine[];
  durationHintSec: number;
}

// Invoke the video CLI for a single clip. The CLI writes to
// WORKSPACE/<filename>.mp4; we point filename at a unique temp slug, then move
// the result into the card's persistent dir. Returns the final absolute path.
async function generateClip(
  track: string,
  spec: ClipSpec,
  keyframe: string,
  destDir: string,
): Promise<string> {
  const slug = `show-tmp-${randomUUID()}`;
  const params = {
    model: VEO_MODEL,
    prompt: buildVeoPrompt(track, spec.label, spec.lines),
    filename: slug,
    images: [keyframe],
    aspect_ratio: "16:9",
    duration: CLIP_DURATION_SEC,
  };

  const { stdout } = await execFileAsync(VIDEO_CLI, [JSON.stringify(params)], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });

  // The CLI prints a media marker + a "Video saved to <path>" line. Resolve the
  // produced path from the marker if present, else from the conventional slug.
  const produced = resolveProducedPath(stdout, slug);
  if (!produced || !fs.existsSync(produced)) {
    throw new Error(`video CLI did not produce a file for ${spec.id} (looked for ${produced})`);
  }

  const dest = path.join(destDir, `${spec.id}.mp4`);
  fs.renameSync(produced, dest);
  return dest;
}

function resolveProducedPath(stdout: string, slug: string): string {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      const p = obj?.__asi_media__?.path;
      if (typeof p === "string") return p;
    } catch {
      /* not a json line */
    }
  }
  // Fallback to the CLI's default output location.
  const workspace = process.env.ASI_WORKSPACE || "/home/user/workspace";
  return path.join(workspace, `${slug}.mp4`);
}

// Build the full show for a card: overview + every race, serially. Writes the
// manifest last and returns its path. Throws on the first clip failure so the
// caller can record an error state (no partial "ready").
export async function buildCardShow(
  card: CardWithRaces,
): Promise<{ manifestPath: string; manifest: ShowManifest }> {
  const destDir = cardShowDir(card.id);
  fs.mkdirSync(destDir, { recursive: true });

  const keyframe = resolveKeyframe(card.track);
  const script = buildShowScript(card);

  const specs: ClipSpec[] = [
    {
      id: "overview",
      label: "Overview",
      lines: script.overview.speakerLines,
      durationHintSec: script.overview.durationHintSec,
    },
    ...script.races.map((r: ShowScriptSegment) => ({
      id: `r${r.raceNumber}`,
      label: r.label,
      lines: r.speakerLines,
      durationHintSec: r.durationHintSec,
    })),
  ];

  const segments: ShowSegment[] = [];
  for (const spec of specs) {
    await generateClip(card.track, spec, keyframe, destDir);
    segments.push({
      id: spec.id,
      label: spec.label,
      filename: `${spec.id}.mp4`,
      durationSec: CLIP_DURATION_SEC,
    });
  }

  const manifest: ShowManifest = {
    cardId: card.id,
    track: card.track,
    generatedAt: new Date().toISOString(),
    segments,
  };

  // Write atomically: temp file then rename, so readers never see a half file.
  const manifestPath = path.join(destDir, "manifest.json");
  const tmp = path.join(destDir, `.manifest.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestPath);

  return { manifestPath, manifest };
}

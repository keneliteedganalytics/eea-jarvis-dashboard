// Manual PDF drop ingest (PR #33).
//
// Live Brisnet/Equibase auth is being debugged in parallel; this gives Ken a
// path to validate Fusion v3 right now by manually dropping the PPs PDFs he has
// already downloaded. It bypasses Playwright auth entirely: the uploaded bytes
// are written to disk and handed to the SAME analyze-card pipeline the cron and
// on-demand-ingest use, so parsing (Brisnet glyph-cipher decode via
// parsers/brisnet decodeBrisnet, Equibase speed-figure parse), fusion, LLM
// handoff and persistence are all identical to a live pull.
//
// The Brisnet Ultimate PP PDF is required (it alone is enough to tier the card).
// The Equibase PDF is optional: analyze-card already treats an unparseable /
// absent Equibase source as a graceful degrade (errors collected, card still
// built), so when no Equibase file is dropped we hand analyze-card the Brisnet
// PDF for both paths and the Equibase parse simply yields no extra races.
//
// Idempotent on (track, raceDate): a re-drop of a corrected PDF replaces the
// existing card for that track+date rather than erroring or duplicating.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storage } from "../storage";
import { analyzeCard, type AnalyzeInput } from "./analyze-card";
import { resolveTrack } from "./on-demand-ingest";
import { broadcastEvent } from "./events";

export interface ManualIngestRequest {
  track: string; // track name or code, fuzzy-resolved (e.g. "FL" -> "Finger Lakes")
  raceDate: string; // ISO YYYY-MM-DD
  brisnetBuffer: Buffer;
  brisnetFilename?: string;
  equibaseBuffer?: Buffer | null;
  equibaseFilename?: string;
}

export interface ManualIngestResult {
  ok: boolean;
  cardId?: number;
  track: string;
  raceDate: string;
  raceCount?: number;
  conviction?: string;
  source: "manual";
  errors: string[];
}

export interface ManualIngestDeps {
  analyze?: typeof analyzeCard;
}

// On-disk home for manually-dropped PDFs, so a card can be re-parsed later.
function manualDropDir(): string {
  if (process.env.MANUAL_DROP_DIR) return process.env.MANUAL_DROP_DIR;
  const audioDir = process.env.AUDIO_DIR;
  const base = audioDir
    ? path.join(path.dirname(audioDir), "manual-drops")
    : path.join(os.tmpdir(), "eea-manual-drops");
  return base;
}

function isoDateValid(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

// Remove any existing card for (track, date) so a re-drop replaces cleanly.
// Mirrors the discard route: drop predictions first, then the card (which
// cascades races + pp_uploads).
function deleteExistingCard(track: string, date: string): number | null {
  const existing = storage.getCards().find((c) => c.track === track && c.date === date);
  if (!existing) return null;
  storage.deletePredictionsByCard(existing.id);
  storage.deleteCard(existing.id);
  return existing.id;
}

export async function runManualIngest(
  req: ManualIngestRequest,
  deps: ManualIngestDeps = {},
): Promise<ManualIngestResult> {
  const analyze = deps.analyze ?? analyzeCard;

  const canon = resolveTrack(req.track);
  const trackName = canon?.name ?? req.track.trim();
  const trackCode = canon?.code ?? req.track.trim().toUpperCase();

  if (!isoDateValid(req.raceDate)) {
    return {
      ok: false,
      track: trackName,
      raceDate: req.raceDate,
      source: "manual",
      errors: [`raceDate must be a real YYYY-MM-DD date, got "${req.raceDate}".`],
    };
  }
  if (!req.brisnetBuffer || req.brisnetBuffer.length === 0) {
    return {
      ok: false,
      track: trackName,
      raceDate: req.raceDate,
      source: "manual",
      errors: ["brisnetPdf is required"],
    };
  }

  broadcastEvent("manual-ingest:started", { track: trackName, date: req.raceDate });

  // Persist the dropped bytes to disk so analyze-card can parse them by path
  // (the parsers read files, going through the Brisnet glyph-cipher decode).
  const dir = path.join(manualDropDir(), `${trackCode}-${req.raceDate}`);
  fs.mkdirSync(dir, { recursive: true });
  const brisnetFilename = req.brisnetFilename || `${trackCode}-${req.raceDate}-brisnet.pdf`;
  const brisnetPath = path.join(dir, brisnetFilename);
  fs.writeFileSync(brisnetPath, req.brisnetBuffer);

  let equibasePath = brisnetPath;
  let equibaseFilename = brisnetFilename;
  const haveEquibase = !!req.equibaseBuffer && req.equibaseBuffer.length > 0;
  if (haveEquibase) {
    equibaseFilename = req.equibaseFilename || `${trackCode}-${req.raceDate}-equibase.pdf`;
    equibasePath = path.join(dir, equibaseFilename);
    fs.writeFileSync(equibasePath, req.equibaseBuffer!);
  }

  // Idempotency: drop any prior card for this track+date before re-ingesting.
  deleteExistingCard(trackName, req.raceDate);

  const input: AnalyzeInput = {
    track: trackName,
    date: req.raceDate,
    brisnetPath,
    equibasePath,
    brisnetFilename,
    equibaseFilename,
  };

  const analysis = await analyze(input);
  const errors = [...analysis.errors];
  // When no Equibase file was dropped we reused the Brisnet PDF for the Equibase
  // path; that parse can't yield Equibase races. Note it rather than alarm.
  if (!haveEquibase) {
    errors.push("No Equibase PDF dropped — tiered on Brisnet PPs only.");
  }

  const card = storage.getCard(analysis.cardId);
  const result: ManualIngestResult = {
    ok: true,
    cardId: analysis.cardId,
    track: trackName,
    raceDate: req.raceDate,
    raceCount: storage.getCardWithRaces(analysis.cardId)?.races.length,
    conviction: card?.cardConviction ?? undefined,
    source: "manual",
    errors,
  };
  broadcastEvent("manual-ingest:completed", { result });
  return result;
}

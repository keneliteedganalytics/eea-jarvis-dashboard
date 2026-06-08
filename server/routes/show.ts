// Daily Show routes.
//
//   GET  /api/show/script/:cardId -> deterministic script payload (buildShowScript)
//                                    so Computer can build matching Veo prompts.
//   POST /api/show/upload/:cardId -> multipart upload of MP4 segments (+ optional
//                                    manifest) from Computer; writes atomically and
//                                    marks the row ready.
//   POST /api/show/build/:cardId  -> mark the row as "requested"; Computer builds
//                                    out-of-band (returns 202, no local Veo spawn).
//   POST /api/show/build/active   -> cron entry; mark stale active cards "requested",
//                                    return the requested cardIds for Computer.
//   GET  /api/show/:cardId        -> manifest + status (404 until first build)
//   DELETE /api/show/:cardId      -> wipe state + files so a rebuild starts clean
//   GET  /show/:cardId/:filename  -> serve a clip/manifest (range-capable for
//                                    video scrubbing). Basic auth is applied
//                                    globally in index.ts, so all of these are
//                                    protected.
//
// Video generation does NOT run in this process — see server/services/show-video.ts
// for the architecture note. Railway hosts/serves; Computer builds and uploads.

import express, { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { storage } from "../storage";
import { cardShowDir } from "../services/show-video";
import { buildShowScript } from "../services/show-script";
import { cardNeedsShow } from "../services/show-cron";
import type { CardWithRaces, ShowManifest, ShowSegment } from "@shared/schema";

const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB per file
const MAX_FILES = 50; // segments per request
const SEGMENT_ID_RE = /^[a-z0-9_-]+$/i;

function readManifestFromDisk(cardId: number): ShowManifest | null {
  const p = path.join(cardShowDir(cardId), "manifest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ShowManifest;
  } catch {
    return null;
  }
}

// Shape the script payload Computer consumes. Mirrors buildShowScript's output
// 1:1 (overview + one entry per race) plus the card-level track/cardId so
// Computer can address uploads. This is the regression contract for PR #10.
function scriptPayload(card: CardWithRaces) {
  const script = buildShowScript(card);
  return {
    cardId: card.id,
    track: card.track,
    overview: {
      segmentId: "overview",
      label: "Overview",
      speakerLines: script.overview.speakerLines,
      durationHintSec: script.overview.durationHintSec,
    },
    races: script.races.map((r) => ({
      segmentId: `r${r.raceNumber}`,
      raceId: r.raceId,
      raceNumber: r.raceNumber,
      label: r.label,
      speakerLines: r.speakerLines,
      durationHintSec: r.durationHintSec,
    })),
  };
}

// Derive a segment id from a multer file. Computer may either:
//   - name the form field `segment[<id>]` (e.g. segment[overview], segment[r1]), or
//   - upload via the `segments` array with the filename encoding the id
//     (overview.mp4, r1.mp4).
// Returns null if no valid id can be derived.
function segmentIdFromFile(file: Express.Multer.File): string | null {
  const field = file.fieldname || "";
  const bracket = /^segment\[([^\]]+)\]$/.exec(field);
  if (bracket && SEGMENT_ID_RE.test(bracket[1])) return bracket[1];
  if (field === "segment" || field === "segments") {
    const base = path.basename(file.originalname || "", ".mp4");
    if (base && SEGMENT_ID_RE.test(base)) return base;
  }
  // A bare custom field name is also accepted as the id (e.g. field "overview").
  if (field && field !== "manifest" && SEGMENT_ID_RE.test(field)) return field;
  return null;
}

// Mounted at /api/show. Returns the API router.
export function showApiRouter(): Router {
  const router = Router();

  // Multer: disk storage into the OS temp dir; we move each file into the card's
  // persistent dir atomically (.tmp -> rename) after validation so a partial or
  // rejected upload can never corrupt a live manifest/clip.
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      filename: (_req, _file, cb) => cb(null, `show-upload-${randomUUID()}.tmp`),
    }),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
    fileFilter: (_req, file, cb) => {
      // Only accept MP4 video for file parts; the manifest comes through as a
      // text field, not a file. Reject anything else up front.
      const ok = file.mimetype === "video/mp4" || file.mimetype === "application/mp4";
      cb(null, ok);
    },
  });

  // Authoritative deterministic script so Computer builds matching prompts.
  router.get("/script/:cardId", (req, res) => {
    const cardId = Number(req.params.cardId);
    if (!Number.isFinite(cardId)) return res.status(400).json({ error: "Bad cardId" });
    const card = storage.getCardWithRaces(cardId);
    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json(scriptPayload(card));
  });

  // Multipart upload of MP4 segments (+ optional manifest text field) from
  // Computer. Field shape (see segmentIdFromFile):
  //   - file field `segment[<id>]` per clip (segment[overview], segment[r1]…), and/or
  //   - files under `segments` / `segment` with filename `<id>.mp4`.
  //   - optional text field `manifest` carrying the full manifest.json contents.
  // Writes each file to /data/show/<cardId>/<id>.mp4 atomically, then the manifest,
  // then marks the row ready. Rejected files are cleaned up.
  // Wrap multer so its limit/parse errors become clean JSON status codes
  // (413 oversize, 400 too-many-files/bad-part) instead of a generic 500.
  const handleUpload: express.RequestHandler = (req, res, next) => {
    upload.any()(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "Segment exceeds 200MB limit" });
        }
        if (err.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({ error: "Too many segments (max 50)" });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err) return res.status(400).json({ error: (err as Error).message });
      next();
    });
  };

  router.post("/upload/:cardId", handleUpload, (req, res) => {
    const cardId = Number(req.params.cardId);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const cleanup = () => {
      for (const f of files) {
        try {
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        } catch {
          /* best effort */
        }
      }
    };

    if (!Number.isFinite(cardId)) {
      cleanup();
      return res.status(400).json({ error: "Bad cardId" });
    }
    if (!storage.getCard(cardId)) {
      cleanup();
      return res.status(404).json({ error: "Card not found" });
    }
    if (files.length === 0) {
      cleanup();
      return res.status(400).json({ error: "No MP4 segments uploaded" });
    }

    // Resolve every file to a segment id before writing anything.
    const resolved: { id: string; tmp: string }[] = [];
    for (const f of files) {
      const id = segmentIdFromFile(f);
      if (!id) {
        cleanup();
        return res.status(400).json({ error: `Cannot derive segment id from field "${f.fieldname}"` });
      }
      resolved.push({ id, tmp: f.path });
    }

    const destDir = cardShowDir(cardId);
    fs.mkdirSync(destDir, { recursive: true });

    const written: ShowSegment[] = [];
    try {
      for (const { id, tmp } of resolved) {
        const finalPath = path.join(destDir, `${id}.mp4`);
        const stageTmp = path.join(destDir, `.${id}.${process.pid}.tmp`);
        fs.renameSync(tmp, stageTmp);
        fs.renameSync(stageTmp, finalPath);
        written.push({ id, label: id, filename: `${id}.mp4`, durationSec: 0 });
      }
    } catch (e) {
      cleanup();
      return res.status(500).json({ error: `Failed to store segments: ${(e as Error).message}` });
    }

    // Manifest: prefer the uploaded one (it carries real labels/durations); else
    // synthesize a minimal one from the files we wrote so the player still works.
    let manifest: ShowManifest;
    const rawManifest = typeof req.body?.manifest === "string" ? req.body.manifest : null;
    if (rawManifest) {
      try {
        const parsed = JSON.parse(rawManifest) as ShowManifest;
        manifest = {
          cardId,
          track: parsed.track,
          generatedAt: parsed.generatedAt || new Date().toISOString(),
          segments: Array.isArray(parsed.segments) && parsed.segments.length ? parsed.segments : written,
        };
      } catch {
        return res.status(400).json({ error: "manifest field is not valid JSON" });
      }
    } else {
      const card = storage.getCard(cardId);
      manifest = {
        cardId,
        track: card?.track ?? "",
        generatedAt: new Date().toISOString(),
        segments: written,
      };
    }

    // Write manifest atomically (temp + rename) so readers never see a half file.
    const manifestPath = path.join(destDir, "manifest.json");
    const manifestTmp = path.join(destDir, `.manifest.${process.pid}.tmp`);
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(manifestTmp, manifestPath);

    storage.completeCardShow(cardId, manifest);
    res.json({ status: "ready", segments: manifest.segments.length, manifest });
  });

  // Cron entry. Mark every stale active card "requested" and return the list so
  // Computer can build + upload them. No local builds. Declared BEFORE
  // /build/:cardId so the literal "active" path isn't captured as a cardId.
  router.post("/build/active", (_req, res) => {
    const active = storage.getActiveCards();
    const requested: number[] = [];
    const skipped: number[] = [];
    for (const card of active) {
      const show = storage.getCardShow(card.id);
      if (cardNeedsShow(card, show)) {
        storage.requestCardShow(card.id);
        requested.push(card.id);
      } else {
        skipped.push(card.id);
      }
    }
    res.status(202).json({ ok: true, requested, skipped });
  });

  // Build a single card. No local Veo spawn — mark the row "requested" so
  // Computer picks it up out-of-band. Idempotent for already-ready/requested.
  router.post("/build/:cardId", (req, res) => {
    const cardId = Number(req.params.cardId);
    if (!Number.isFinite(cardId)) return res.status(400).json({ error: "Bad cardId" });

    const existing = storage.getCardShow(cardId);
    if (existing?.status === "ready" && existing.manifestJson) {
      return res.json({ status: "ready", manifest: JSON.parse(existing.manifestJson) });
    }
    if (existing?.status === "requested" || existing?.status === "building") {
      return res.status(202).json({ status: "requested" });
    }
    if (!storage.getCard(cardId)) return res.status(404).json({ error: "Card not found" });

    storage.requestCardShow(cardId);
    res.status(202).json({ status: "requested" });
  });

  // Manifest + status. 404 until the first build has produced a manifest so the
  // client shows the empty/building state while polling.
  router.get("/:cardId", (req, res) => {
    const cardId = Number(req.params.cardId);
    if (!Number.isFinite(cardId)) return res.status(400).json({ error: "Bad cardId" });
    const show = storage.getCardShow(cardId);

    if (show?.status === "ready" && show.manifestJson) {
      return res.json({ status: "ready", manifest: JSON.parse(show.manifestJson) });
    }
    if (show?.status === "requested") return res.json({ status: "building" });
    if (show?.status === "building") return res.json({ status: "building" });
    if (show?.status === "error") return res.json({ status: "error", error: show.error });

    // No row yet — but a manifest may exist on disk from a prior upload.
    const disk = readManifestFromDisk(cardId);
    if (disk) {
      storage.completeCardShow(cardId, disk);
      return res.json({ status: "ready", manifest: disk });
    }
    return res.status(404).json({ status: "missing" });
  });

  // Wipe state + files so the next build starts clean.
  router.delete("/:cardId", (req, res) => {
    const cardId = Number(req.params.cardId);
    if (!Number.isFinite(cardId)) return res.status(400).json({ error: "Bad cardId" });
    storage.deleteCardShow(cardId);
    const dir = cardShowDir(cardId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  });

  return router;
}

// Serve a file from the card's show dir with HTTP range support so the browser
// can scrub the video. Filenames are constrained to a safe whitelist pattern.
function serveShowFile(cardId: number, filename: string, req: any, res: any): void {
  if (!/^[a-z0-9._-]+$/i.test(filename) || filename.includes("..")) {
    res.status(400).json({ error: "Bad filename" });
    return;
  }
  const filePath = path.join(cardShowDir(cardId), filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const stat = fs.statSync(filePath);
  const isVideo = filename.endsWith(".mp4");
  const contentType = isVideo ? "video/mp4" : filename.endsWith(".json") ? "application/json" : "application/octet-stream";

  const range = req.headers.range;
  if (isVideo && range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", end - start + 1);
    res.setHeader("Content-Type", contentType);
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Type", contentType);
  if (isVideo) res.setHeader("Accept-Ranges", "bytes");
  fs.createReadStream(filePath).pipe(res);
}

// Mounted at /show — serves the actual files. Separate from the API router so
// it can live at the top-level path the spec requires.
export function showFileRouter(): Router {
  const router = Router();
  router.get("/:cardId/:filename", (req, res) => {
    const cardId = Number(req.params.cardId);
    if (!Number.isFinite(cardId)) return res.status(400).json({ error: "Bad cardId" });
    serveShowFile(cardId, req.params.filename, req, res);
  });
  return router;
}

// Daily Show routes.
//
//   POST /api/show/build/:cardId  -> kick off a build (idempotent: returns the
//                                    existing ready manifest if present)
//   POST /api/show/build/active   -> cron entry; builds active cards that are
//                                    missing or stale, in series
//   GET  /api/show/:cardId        -> manifest + status (404 until first build)
//   DELETE /api/show/:cardId      -> wipe state + files so a rebuild starts clean
//   GET  /show/:cardId/:filename  -> serve a clip/manifest (range-capable for
//                                    video scrubbing). Basic auth is applied
//                                    globally in index.ts, so this is protected.
//
// Builds run in the background; the POST returns immediately and the client
// polls GET /api/show/:cardId until status === "ready".

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { storage } from "../storage";
import { buildCardShow, cardShowDir } from "../services/show-video";
import { cardNeedsShow } from "../services/show-cron";
import type { ShowManifest } from "@shared/schema";

// Guard against two concurrent builds for the same card within this process.
const inFlight = new Set<number>();

function readManifestFromDisk(cardId: number): ShowManifest | null {
  const p = path.join(cardShowDir(cardId), "manifest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ShowManifest;
  } catch {
    return null;
  }
}

// Run a build in the background, recording state transitions. Never rejects to
// the caller — failures are persisted as status="error".
async function runBuild(cardId: number): Promise<void> {
  if (inFlight.has(cardId)) return;
  inFlight.add(cardId);
  storage.startCardShow(cardId);
  try {
    const card = storage.getCardWithRaces(cardId);
    if (!card) throw new Error(`Card ${cardId} not found`);
    const { manifest } = await buildCardShow(card);
    storage.completeCardShow(cardId, manifest);
    console.log(`[show] build complete for card ${cardId} (${manifest.segments.length} segments)`);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[show] build FAILED for card ${cardId}:`, msg);
    storage.failCardShow(cardId, msg);
  } finally {
    inFlight.delete(cardId);
  }
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

// Mounted at /api/show. Returns the API router.
export function showApiRouter(): Router {
  const router = Router();

  // Build a single card. Idempotent: if a ready manifest exists, return it.
  router.post("/build/:cardId", (req, res) => {
    const cardId = Number(req.params.cardId);
    if (!Number.isFinite(cardId)) return res.status(400).json({ error: "Bad cardId" });

    const existing = storage.getCardShow(cardId);
    if (existing?.status === "ready" && existing.manifestJson) {
      return res.json({ status: "ready", manifest: JSON.parse(existing.manifestJson) });
    }
    if (existing?.status === "building" || inFlight.has(cardId)) {
      return res.json({ status: "building" });
    }
    const card = storage.getCard(cardId);
    if (!card) return res.status(404).json({ error: "Card not found" });

    void runBuild(cardId);
    res.status(202).json({ status: "queued" });
  });

  // Cron entry. Build every active card that's missing or stale, in series.
  router.post("/build/active", async (_req, res) => {
    const active = storage.getActiveCards();
    const built: number[] = [];
    const skipped: number[] = [];
    for (const card of active) {
      const show = storage.getCardShow(card.id);
      if (cardNeedsShow(card, show)) {
        built.push(card.id);
        await runBuild(card.id); // serial — keep memory + Veo concurrency sane
      } else {
        skipped.push(card.id);
      }
    }
    res.json({ ok: true, built, skipped });
  });

  // Manifest + status. 404 until the first build has produced a manifest so the
  // client shows the "Building today's show…" state while polling.
  router.get("/:cardId", (req, res) => {
    const cardId = Number(req.params.cardId);
    if (!Number.isFinite(cardId)) return res.status(400).json({ error: "Bad cardId" });
    const show = storage.getCardShow(cardId);

    if (show?.status === "ready" && show.manifestJson) {
      return res.json({ status: "ready", manifest: JSON.parse(show.manifestJson) });
    }
    if (show?.status === "building") return res.json({ status: "building" });
    if (show?.status === "error") return res.json({ status: "error", error: show.error });

    // No row yet — but a manifest may exist on disk from a prior process.
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

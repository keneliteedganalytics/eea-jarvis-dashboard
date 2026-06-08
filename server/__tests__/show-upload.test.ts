import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Isolated throwaway SQLite file + show dir — must be set before importing the
// db/storage or the show routes (which read SHOW_DIR via show-video.showRoot).
const TMP_DB = path.join(os.tmpdir(), `eea-show-upload-${Date.now()}.db`);
const TMP_SHOW = path.join(os.tmpdir(), `eea-show-dir-${Date.now()}`);
process.env.DATABASE_FILE = TMP_DB;
process.env.SHOW_DIR = TMP_SHOW;

async function startShowServer(): Promise<{ base: string; server: Server }> {
  const { showApiRouter, showFileRouter } = await import("../routes/show");
  const app = express();
  app.use("/api/show", showApiRouter());
  app.use("/show", showFileRouter());
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

function mp4Blob(sizeBytes = 1024): Blob {
  // Minimal MP4-ish payload — content-type is what the route validates.
  return new Blob([new Uint8Array(sizeBytes)], { type: "video/mp4" });
}

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(TMP_SHOW, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("Daily Show upload-from-Computer routes", () => {
  let base: string;
  let server: Server;
  let cardId: number;

  beforeAll(async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard(
      { track: "Finger Lakes", date: "2026-06-08", cardConviction: "HIGH" },
      [
        { raceNumber: 1, tier: "SNIPER", winPgm: "1", winName: "Test Horse", winScore: 92, placeName: "Second", flags: "[]" },
        { raceNumber: 2, tier: "EDGE", winPgm: "3", winName: "Edge Horse", winScore: 88, placeName: "Runner Up", flags: "[]" },
        { raceNumber: 3, tier: "PASS", flags: "[]" },
      ],
    );
    cardId = card.id;
    const started = await startShowServer();
    base = started.base;
    server = started.server;
  });

  afterAll(() => {
    server?.close();
  });

  // ── GET /api/show/script/:cardId (PR #10 contract regression) ──────────────

  describe("GET /api/show/script/:cardId", () => {
    it("returns the buildShowScript shape: overview + one entry per race in order", async () => {
      const { storage } = await import("../storage");
      const { buildShowScript } = await import("../services/show-script");
      const card = storage.getCardWithRaces(cardId)!;
      const expected = buildShowScript(card);

      const res = await fetch(`${base}/api/show/script/${cardId}`);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.cardId).toBe(cardId);
      expect(body.track).toBe("Finger Lakes");
      // Overview speaker lines must match buildShowScript verbatim.
      expect(body.overview.speakerLines).toEqual(expected.overview.speakerLines);
      expect(body.overview.durationHintSec).toBe(expected.overview.durationHintSec);
      // One race entry per race, in race order, with matching lines + ids.
      expect(body.races).toHaveLength(expected.races.length);
      expect(body.races.map((r: any) => r.raceNumber)).toEqual([1, 2, 3]);
      expect(body.races.map((r: any) => r.segmentId)).toEqual(["r1", "r2", "r3"]);
      body.races.forEach((r: any, i: number) => {
        expect(r.speakerLines).toEqual(expected.races[i].speakerLines);
        expect(r.raceId).toBe(expected.races[i].raceId);
      });
    });

    it("404s for an unknown card", async () => {
      const res = await fetch(`${base}/api/show/script/99999`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/show/build/:cardId (no local Veo spawn) ──────────────────────

  describe("POST /api/show/build/:cardId", () => {
    it("marks the row 'requested' and returns 202 — no Veo spawn", async () => {
      const { storage } = await import("../storage");
      storage.deleteCardShow(cardId);

      const res = await fetch(`${base}/api/show/build/${cardId}`, { method: "POST" });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe("requested");

      const row = storage.getCardShow(cardId);
      expect(row?.status).toBe("requested");
      expect(row?.startedAt).toBeTruthy();
      // No clips were generated locally.
      expect(fs.existsSync(path.join(TMP_SHOW, String(cardId), "overview.mp4"))).toBe(false);
    });

    it("build/active marks stale active cards 'requested' and lists them", async () => {
      const { storage } = await import("../storage");
      storage.deleteCardShow(cardId);
      const res = await fetch(`${base}/api/show/build/active`, { method: "POST" });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.requested).toContain(cardId);
      expect(storage.getCardShow(cardId)?.status).toBe("requested");
    });
  });

  // ── POST /api/show/upload/:cardId ──────────────────────────────────────────

  describe("POST /api/show/upload/:cardId", () => {
    it("writes MP4 segments + manifest atomically and marks the row ready", async () => {
      const { storage } = await import("../storage");
      storage.deleteCardShow(cardId);

      const fd = new FormData();
      fd.append("segment[overview]", mp4Blob(2048), "overview.mp4");
      fd.append("segment[r1]", mp4Blob(2048), "r1.mp4");
      const manifest = {
        cardId,
        track: "Finger Lakes",
        generatedAt: "2026-06-08T13:00:00.000Z",
        segments: [
          { id: "overview", label: "Overview", filename: "overview.mp4", durationSec: 8 },
          { id: "r1", label: "R1", filename: "r1.mp4", durationSec: 8 },
        ],
      };
      fd.append("manifest", JSON.stringify(manifest));

      const res = await fetch(`${base}/api/show/upload/${cardId}`, { method: "POST", body: fd });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ready");
      expect(body.segments).toBe(2);

      // Files landed in the persistent dir; no leftover .tmp files.
      const dir = path.join(TMP_SHOW, String(cardId));
      expect(fs.existsSync(path.join(dir, "overview.mp4"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "r1.mp4"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
      expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);

      // Row is ready and serves through the existing GET endpoint.
      expect(storage.getCardShow(cardId)?.status).toBe("ready");
      const get = await fetch(`${base}/api/show/${cardId}`);
      const getBody = await get.json();
      expect(getBody.status).toBe("ready");
      expect(getBody.manifest.segments).toHaveLength(2);
    });

    it("accepts the `segments` array form with filename-encoded ids", async () => {
      const { storage } = await import("../storage");
      storage.deleteCardShow(cardId);
      const fd = new FormData();
      fd.append("segments", mp4Blob(512), "overview.mp4");
      fd.append("segments", mp4Blob(512), "r2.mp4");

      const res = await fetch(`${base}/api/show/upload/${cardId}`, { method: "POST", body: fd });
      expect(res.status).toBe(200);
      const dir = path.join(TMP_SHOW, String(cardId));
      expect(fs.existsSync(path.join(dir, "overview.mp4"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "r2.mp4"))).toBe(true);
    });

    it("rejects a non-MP4 content type (no file stored)", async () => {
      const { storage } = await import("../storage");
      storage.deleteCardShow(cardId);
      const fd = new FormData();
      fd.append("segment[overview]", new Blob(["not a video"], { type: "text/plain" }), "overview.txt");

      const res = await fetch(`${base}/api/show/upload/${cardId}`, { method: "POST", body: fd });
      // multer's fileFilter drops the part, so no segments arrive -> 400.
      expect(res.status).toBe(400);
      expect(storage.getCardShow(cardId)?.status).not.toBe("ready");
    });

    it("rejects an oversize file (>200MB) with a 413", async () => {
      const { storage } = await import("../storage");
      storage.deleteCardShow(cardId);
      // 201 MB — exceeds the 200MB per-file limit. Allocate lazily via a stream-y
      // Blob of zeroed bytes; Node can hold this transiently for the test.
      const tooBig = new Blob([new Uint8Array(201 * 1024 * 1024)], { type: "video/mp4" });
      const fd = new FormData();
      fd.append("segment[overview]", tooBig, "overview.mp4");

      const res = await fetch(`${base}/api/show/upload/${cardId}`, { method: "POST", body: fd });
      expect(res.status).toBe(413);
      const dir = path.join(TMP_SHOW, String(cardId));
      const overview = path.join(dir, "overview.mp4");
      if (fs.existsSync(overview)) {
        expect(fs.statSync(overview).size).toBeLessThan(200 * 1024 * 1024);
      }
      expect(storage.getCardShow(cardId)?.status).not.toBe("ready");
    });
  });
});

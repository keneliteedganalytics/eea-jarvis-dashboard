import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Isolated throwaway SQLite file — must be set before importing the db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-lifetime-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

// Mirrors the real GET /api/stats/lifetime handler from server/routes.ts without
// booting the poller / seeds / vite that registerRoutes pulls in.
async function startStatsServer(): Promise<{ base: string; server: Server }> {
  const { buildLifetimeStats } = await import("../analytics");
  const app = express();
  app.get("/api/stats/lifetime", (_req, res) => {
    res.json(buildLifetimeStats());
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe("GET /api/stats/lifetime", () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const started = await startStatsServer();
    base = started.base;
    server = started.server;
  });

  afterAll(() => {
    server?.close();
  });

  it("returns zeros and an empty byTrack on an empty DB", async () => {
    const res = await fetch(`${base}/api/stats/lifetime`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.cards).toBe(0);
    expect(body.totals.races).toBe(0);
    expect(body.totals.graded).toBe(0);
    expect(body.totals.win).toBeNull();
    expect(body.totals.itm).toBeNull();
    expect(body.byTrack).toEqual([]);
  });

  it("aggregates across active + archived cards, sorted by track alphabetically", async () => {
    const { storage } = await import("../storage");

    // Active card (Saratoga, 11 races) — leave it active.
    const saratoga = storage.createCard({ track: "Saratoga", date: "2026-06-07" },
      Array.from({ length: 11 }, (_, i) => ({ raceNumber: i + 1, tier: "EDGE", flags: "[]" })),
    );
    // Archived card (Finger Lakes, 8 races).
    const fingerLakes = storage.createCard({ track: "Finger Lakes", date: "2025-08-15" },
      Array.from({ length: 8 }, (_, i) => ({ raceNumber: i + 1, tier: "PASS", flags: "[]" })),
    );
    storage.archiveCard(fingerLakes.id, new Date().toISOString());

    // Grade one race so graded > 0 reflects the union, not just the active card.
    const fl = storage.getCardWithRaces(fingerLakes.id)!;
    storage.logResult(fl.races[0].id, ["1", "2", "3", "4"]);

    const res = await fetch(`${base}/api/stats/lifetime`);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Totals span BOTH the active and archived card (no status filter).
    expect(body.totals.cards).toBe(2);
    expect(body.totals.races).toBe(19);
    expect(body.totals.graded).toBe(1);

    // byTrack is sorted alphabetically: Finger Lakes before Saratoga.
    expect(body.byTrack.map((t: { track: string }) => t.track)).toEqual([
      "Finger Lakes",
      "Saratoga",
    ]);
    const flRow = body.byTrack.find((t: { track: string }) => t.track === "Finger Lakes");
    expect(flRow.cards).toBe(1);
    expect(flRow.races).toBe(8);
    expect(flRow.graded).toBe(1);
    const satRow = body.byTrack.find((t: { track: string }) => t.track === "Saratoga");
    expect(satRow.races).toBe(11);
    expect(satRow.graded).toBe(0);
    expect(satRow.win).toBeNull();

    void saratoga;
  });
});

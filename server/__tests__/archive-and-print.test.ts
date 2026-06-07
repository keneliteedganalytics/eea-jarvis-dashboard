import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Isolated throwaway SQLite file — must be set before importing the db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-archive-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

// Mirrors the real GET /api/cards/:id/print handler from server/routes.ts so the
// test exercises the exact storage calls (including getRaceSummary, which used
// to 500 because the race_summaries table was missing) without booting the
// poller / seeds / vite that registerRoutes pulls in.
async function startPrintServer(): Promise<{ base: string; server: Server }> {
  const { storage } = await import("../storage");
  const { sizeRaceBets } = await import("../services/bet-sizer");
  const app = express();
  app.get("/api/cards/:id/print", (req, res) => {
    try {
      const id = Number(req.params.id);
      const card = storage.getCardWithRaces(id);
      if (!card) return res.status(404).json({ error: "Card not found" });
      const settings = storage.getSettings();
      const racesOnCard = card.races.length;
      const dailyCap = settings.bankroll * settings.dailyRiskCapPct;
      const races = card.races.map((r) => {
        const top = [r.winPgm, r.placePgm, r.showPgm, r.fourthPgm].filter(
          (p): p is string => !!p,
        );
        const bets = sizeRaceBets({
          tier: r.tier,
          racesOnCard,
          settings: { bankroll: settings.bankroll, dailyRiskCapPct: settings.dailyRiskCapPct },
          top,
        });
        const cached = storage.getRaceSummary(r.id);
        return { ...r, bets, summary: cached?.summary ?? null };
      });
      res.json({
        ...card,
        races,
        sizing: { bankroll: settings.bankroll, dailyRiskCapPct: settings.dailyRiskCapPct, dailyCap, racesOnCard },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
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

describe("GET /api/cards/:id/print", () => {
  let base: string;
  let server: Server;
  let cardId: number;

  beforeAll(async () => {
    const { storage } = await import("../storage");
    // A card whose every score / post / conviction / flags field is null — the
    // exact shape that crashed the print renderer before the fix.
    const card = storage.createCard(
      { track: "Finger Lakes", date: "2025-08-15" },
      [
        { raceNumber: 1, tier: "PASS", flags: "[]" },
        { raceNumber: 2, tier: "EDGE", winPgm: "3", winName: "Some Horse", flags: "[]" },
      ],
    );
    cardId = card.id;
    const started = await startPrintServer();
    base = started.base;
    server = started.server;
  });

  afterAll(() => {
    server?.close();
  });

  it("returns 200 with a non-empty body for a card with all-null score fields", async () => {
    const res = await fetch(`${base}/api/cards/${cardId}/print`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(cardId);
    expect(Array.isArray(body.races)).toBe(true);
    expect(body.races.length).toBe(2);
    // Null score fields survive serialization as null (renderer shows "—").
    expect(body.races[0].winScore).toBeNull();
    // Bet sizing is always present per race.
    expect(body.races[0].bets).toBeTruthy();
    expect(body.sizing.racesOnCard).toBe(2);
  });

  it("returns 404 for a missing card", async () => {
    const res = await fetch(`${base}/api/cards/999999/print`);
    expect(res.status).toBe(404);
  });
});

describe("archive sweep + active filter", () => {
  it("auto-archives past cards, is idempotent, and excludes them from active", async () => {
    const { storage } = await import("../storage");
    const { sweepArchive } = await import("../services/card-finishing");

    const past = storage.createCard({ track: "Saratoga", date: "2024-08-01" }, [
      { raceNumber: 1, tier: "SNIPER", flags: "[]" },
    ]);
    const future = storage.createCard({ track: "Belmont", date: "2099-01-01" }, [
      { raceNumber: 1, tier: "PASS", flags: "[]" },
    ]);

    const beforeActiveIds = storage.getActiveCards().map((c) => c.id);
    expect(beforeActiveIds).toContain(past.id);
    expect(beforeActiveIds).toContain(future.id);

    const firstSweep = sweepArchive(storage);
    expect(firstSweep).toBeGreaterThanOrEqual(1);

    // Idempotent: a second sweep with no new past cards archives nothing more.
    const secondSweep = sweepArchive(storage);
    expect(secondSweep).toBe(0);

    // GET /api/cards default (active) excludes the archived past card.
    const activeIds = storage.getActiveCards().map((c) => c.id);
    expect(activeIds).not.toContain(past.id);
    expect(activeIds).toContain(future.id);

    // The archived card carries an archivedAt timestamp and shows up grouped.
    const archivedPast = storage.getCard(past.id);
    expect(archivedPast?.status).toBe("archived");
    expect(archivedPast?.archivedAt).toBeTruthy();

    const grouped = storage.getArchivedCardsGrouped();
    const saratoga = grouped.tracks.find((t) => t.track === "Saratoga");
    expect(saratoga).toBeTruthy();
    expect(saratoga!.cards.some((c) => c.id === past.id)).toBe(true);

    // Read-only detail returns the full card for an archived id, undefined else.
    expect(storage.getArchivedCardById(past.id)?.id).toBe(past.id);
    expect(storage.getArchivedCardById(future.id)).toBeUndefined();
  });
});

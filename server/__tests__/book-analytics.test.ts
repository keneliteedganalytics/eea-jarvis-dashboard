import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const TMP_DB = path.join(os.tmpdir(), `eea-book-analytics-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

// The canonical book-bets export lives alongside the repo. Resolve a couple of
// likely locations so the test runs both locally and in CI checkouts.
function resolveBookBetsJson(): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "eea_analytics", "book_bets.json"),
    path.resolve(process.cwd(), "..", "..", "eea_analytics", "book_bets.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`book_bets.json not found in: ${candidates.join(", ")}`);
}

interface RawBet {
  bet_id: string | number;
  placed_at: string;
  date: string;
  track: string;
  race: number;
  bet_type: string;
  bet_subtype?: string | null;
  wager_desc: string;
  base_amount?: number;
  total_cost: number;
  payout?: number;
  result: string;
  source: string;
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

describe("Book Bets analytics", () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const {
      buildBookSummary,
      buildBookByTrack,
      buildBookByBetType,
      buildBookByTrackAndType,
      buildBookBankrollCurve,
      buildBookBets,
    } = await import("../book-analytics");
    const { storage } = await import("../storage");

    // Seed real_bets from the canonical dump via the same upsert path the
    // ingestion endpoint uses.
    const raw = JSON.parse(fs.readFileSync(resolveBookBetsJson(), "utf-8")) as RawBet[];
    const mapped = raw.map((r) => ({
      betId: String(r.bet_id),
      placedAt: r.placed_at,
      date: r.date,
      track: r.track,
      race: r.race,
      betType: r.bet_type,
      betSubtype: r.bet_subtype ?? null,
      wagerDesc: r.wager_desc,
      baseAmount: r.base_amount ?? 0,
      totalCost: r.total_cost,
      payout: r.payout ?? 0,
      result: r.result as "WIN" | "LOSS" | "REFUND",
      source: r.source,
    }));
    storage.bulkUpsertRealBets(mapped);

    const app = express();
    app.get("/api/analytics/book/summary", (_req, res) => res.json(buildBookSummary()));
    app.get("/api/analytics/book/by-track", (_req, res) => res.json(buildBookByTrack()));
    app.get("/api/analytics/book/by-bet-type", (_req, res) => res.json(buildBookByBetType()));
    app.get("/api/analytics/book/by-track-and-type", (_req, res) => res.json(buildBookByTrackAndType()));
    app.get("/api/analytics/book/bankroll-curve", (_req, res) => res.json(buildBookBankrollCurve()));
    app.get("/api/analytics/book/bets", (req, res) => {
      const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
      res.json(buildBookBets({ limit }));
    });

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("summary reports the expected totals across 138 bets", async () => {
    const res = await fetch(`${base}/api/analytics/book/summary`);
    const body = await res.json();
    expect(body.totalBets).toBe(138);
    expect(body.totalCost).toBeCloseTo(3366, 0);
    expect(body.totalPayout).toBeCloseTo(3098.41, 1);
    expect(body.totalPnl).toBeCloseTo(-267.59, 1);
    // ROI = pnl / cost * 100
    expect(body.roi).toBeCloseTo(-7.9, 0);
  });

  it("by-track is sorted by P/L desc and matches known per-track P/L", async () => {
    const res = await fetch(`${base}/api/analytics/book/by-track`);
    const rows: { track: string; totalPnl: number }[] = await res.json();
    const pnl = Object.fromEntries(rows.map((r) => [r.track, r.totalPnl]));
    expect(pnl["Belmont at the Big A"]).toBeCloseTo(248.74, 1);
    expect(pnl["Churchill Downs"]).toBeCloseTo(86.42, 1);
    expect(pnl["Charles Town"]).toBeCloseTo(-112.0, 1);
    expect(pnl["Penn National"]).toBeCloseTo(-124.4, 1);
    expect(pnl["Thistledown"]).toBeCloseTo(-156.0, 1);
    expect(pnl["Assiniboia Downs"]).toBeCloseTo(-210.35, 1);
    // Sorted by P/L descending.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].totalPnl).toBeGreaterThanOrEqual(rows[i].totalPnl);
    }
  });

  it("by-bet-type is sorted by P/L desc", async () => {
    const res = await fetch(`${base}/api/analytics/book/by-bet-type`);
    const rows: { betType: string; totalPnl: number }[] = await res.json();
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].totalPnl).toBeGreaterThanOrEqual(rows[i].totalPnl);
    }
  });

  it("by-track-and-type returns a populated matrix", async () => {
    const res = await fetch(`${base}/api/analytics/book/by-track-and-type`);
    const rows: { track: string; betType: string; totalBets: number }[] = await res.json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.track && r.betType && r.totalBets > 0)).toBe(true);
  });

  it("bankroll-curve is chronological and ends at total P/L", async () => {
    const res = await fetch(`${base}/api/analytics/book/bankroll-curve`);
    const pts: { placedAt: string; cumulativePnl: number }[] = await res.json();
    expect(pts.length).toBe(138);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i - 1].placedAt <= pts[i].placedAt).toBe(true);
    }
    expect(pts[pts.length - 1].cumulativePnl).toBeCloseTo(-267.59, 1);
  });

  it("bets is paginated and most-recent first", async () => {
    const res = await fetch(`${base}/api/analytics/book/bets?limit=50`);
    const body = await res.json();
    expect(body.total).toBe(138);
    expect(body.bets.length).toBe(50);
    for (let i = 1; i < body.bets.length; i++) {
      expect(body.bets[i - 1].placedAt >= body.bets[i].placedAt).toBe(true);
    }
  });
});

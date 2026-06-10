import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Isolated throwaway SQLite file — set before importing the db/storage so the
// runtime CREATE TABLE bootstrap runs against this file.
const TMP_DB = path.join(os.tmpdir(), `eea-backtest-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

const PIN = "5811"; // admin-pin.ts default when ADMIN_PIN is unset
const METHOD = "card10-v1";

// Mirror the real wiring from server/routes.ts: PIN gate on /api before the
// mutating routes, then mount exactly the backtest endpoints.
async function startServer(): Promise<{ base: string; server: Server }> {
  const { adminPinGate } = await import("../middleware/admin-pin");
  const { storage } = await import("../storage");
  const { upsertSnapshot, recordOutcomes, listSnapshots, computeRoi, DEFAULT_METHODOLOGY_VERSION } =
    await import("../services/backtest");
  const { snapshotSubmitSchema, outcomesSubmitSchema } = await import("@shared/schema");

  const app = express();
  app.use(express.json());
  app.use("/api", adminPinGate);

  app.post("/api/cards/:id/snapshot", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    const parsed = snapshotSubmitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    res.status(201).json(upsertSnapshot(id, parsed.data));
  });

  app.post("/api/cards/:id/outcomes", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    const parsed = outcomesSubmitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const rows = recordOutcomes(id, parsed.data.outcomes);
    res.status(201).json({ recorded: rows.length, outcomes: rows });
  });

  app.get("/api/backtest/snapshots", (req, res) => {
    const v = typeof req.query.methodologyVersion === "string" && req.query.methodologyVersion
      ? req.query.methodologyVersion
      : DEFAULT_METHODOLOGY_VERSION;
    res.json(listSnapshots(v));
  });

  app.get("/api/backtest/roi", (req, res) => {
    const v = typeof req.query.methodologyVersion === "string" && req.query.methodologyVersion
      ? req.query.methodologyVersion
      : DEFAULT_METHODOLOGY_VERSION;
    res.json(computeRoi(v));
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

describe("backtest snapshot harness — schema", () => {
  it("creates card_snapshots and card_outcomes tables at runtime", async () => {
    const { sqlite } = await import("../db");
    const tables = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain("card_snapshots");
    expect(tables).toContain("card_outcomes");

    const snapCols = (
      sqlite.prepare("PRAGMA table_info(card_snapshots)").all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of [
      "card_id",
      "snapshot_at",
      "methodology_version",
      "raw_data",
      "scoring",
      "bankroll_allocated",
      "bankroll_cap",
    ]) {
      expect(snapCols).toContain(col);
    }
    const outCols = (
      sqlite.prepare("PRAGMA table_info(card_outcomes)").all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of [
      "card_id",
      "race_num",
      "horse_id",
      "finish_position",
      "win_payout",
      "place_payout",
      "show_payout",
      "exacta_payout",
    ]) {
      expect(outCols).toContain(col);
    }
  });
});

describe("backtest API contract", () => {
  let base: string;
  let server: Server;
  let cardId: number;

  beforeAll(async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "Assiniboia Downs", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "SNIPER", flags: "[]" },
    ]);
    cardId = card.id;
    const started = await startServer();
    base = started.base;
    server = started.server;
  });

  afterAll(() => server?.close());

  it("rejects snapshot POST without the admin PIN (401 + code)", async () => {
    const res = await fetch(`${base}/api/cards/${cardId}/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawData: {}, scoring: {}, bankrollAllocated: 0, bankrollCap: 0 }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("ADMIN_PIN_REQUIRED");
  });

  it("rejects outcomes POST without the admin PIN", async () => {
    const res = await fetch(`${base}/api/cards/${cardId}/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcomes: [{ raceNum: 1, horseId: "5" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("allows GET reads without the PIN", async () => {
    const snaps = await fetch(`${base}/api/backtest/snapshots?methodologyVersion=${METHOD}`);
    expect(snaps.status).toBe(200);
    const roi = await fetch(`${base}/api/backtest/roi?methodologyVersion=${METHOD}`);
    expect(roi.status).toBe(200);
  });

  it("404s a snapshot for a non-existent card", async () => {
    const res = await fetch(`${base}/api/cards/999999/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ rawData: {}, scoring: {}, bankrollAllocated: 0, bankrollCap: 0 }),
    });
    expect(res.status).toBe(404);
  });

  it("is idempotent on (cardId, methodologyVersion)", async () => {
    const body = {
      methodologyVersion: METHOD,
      rawData: { entries: [] },
      scoring: { races: [{ raceNum: 1, tier: "SNIPER" }] },
      bankrollAllocated: 21000,
      bankrollCap: 100000,
    };
    const post = () =>
      fetch(`${base}/api/cards/${cardId}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
        body: JSON.stringify(body),
      });
    await post();
    await post(); // second snapshot must REPLACE, not duplicate

    const { sqlite } = await import("../db");
    const count = (
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM card_snapshots WHERE card_id = ? AND methodology_version = ?",
        )
        .get(cardId, METHOD) as { n: number }
    ).n;
    expect(count).toBe(1);

    const snaps = await (
      await fetch(`${base}/api/backtest/snapshots?methodologyVersion=${METHOD}`)
    ).json();
    const row = snaps.find((s: { cardId: number }) => s.cardId === cardId);
    expect(row).toBeTruthy();
    expect(row.raceCount).toBe(1);
    expect(row.tiersByCount.SNIPER).toBe(1);
  });
});

describe("backtest end-to-end ROI", () => {
  let base: string;
  let server: Server;
  let cardId: number;

  beforeAll(async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "Assiniboia Downs", date: "2026-06-10" }, [
      { raceNumber: 1, tier: "SNIPER", flags: "[]" },
      { raceNumber: 2, tier: "EDGE", flags: "[]" },
    ]);
    cardId = card.id;
    const started = await startServer();
    base = started.base;
    server = started.server;
  });

  afterAll(() => server?.close());

  it("create snapshot → POST outcomes → GET roi returns expected per-tier numbers", async () => {
    const e2eMethod = "e2e-v1";
    // R1 SNIPER: $200 WIN on #5, which wins paying $8.00 ($2 base) → return $800.
    // R2 EDGE:   $100 WIN on #3, which loses → return $0.
    const snapshot = {
      methodologyVersion: e2eMethod,
      rawData: { entries: ["5", "3"] },
      scoring: {
        races: [
          { raceNum: 1, tier: "SNIPER", bet: { type: "WIN", horseId: "5", stake: 200 } },
          { raceNum: 2, tier: "EDGE", bet: { type: "WIN", horseId: "3", stake: 100 } },
        ],
      },
      bankrollAllocated: 30000,
      bankrollCap: 100000,
    };
    const snapRes = await fetch(`${base}/api/cards/${cardId}/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify(snapshot),
    });
    expect(snapRes.status).toBe(201);

    const outRes = await fetch(`${base}/api/cards/${cardId}/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({
        outcomes: [
          { raceNum: 1, horseId: "5", finishPosition: 1, winPayout: 8.0 },
          { raceNum: 1, horseId: "3", finishPosition: 4 },
          { raceNum: 2, horseId: "3", finishPosition: 5 },
          { raceNum: 2, horseId: "7", finishPosition: 1, winPayout: 12.0 },
        ],
      }),
    });
    expect(outRes.status).toBe(201);
    expect((await outRes.json()).recorded).toBe(4);

    const roi = await (
      await fetch(`${base}/api/backtest/roi?methodologyVersion=${e2eMethod}`)
    ).json();

    expect(roi.cardCount).toBe(1);
    expect(roi.raceCount).toBe(2);
    expect(roi.settledBetCount).toBe(2);

    // SNIPER: 1 bet, 1 win, staked $200, returned (200/2)*8 = $800, ROI +300%.
    const sniper = roi.tiers.SNIPER;
    expect(sniper.bets).toBe(1);
    expect(sniper.wins).toBe(1);
    expect(sniper.totalStaked).toBe(200);
    expect(sniper.totalReturned).toBe(800);
    expect(sniper.roi).toBe(300);

    // EDGE: 1 bet, 0 wins, staked $100, returned $0, ROI -100%.
    const edge = roi.tiers.EDGE;
    expect(edge.bets).toBe(1);
    expect(edge.wins).toBe(0);
    expect(edge.totalStaked).toBe(100);
    expect(edge.totalReturned).toBe(0);
    expect(edge.roi).toBe(-100);

    // Untouched tiers report null ROI (nothing staked).
    expect(roi.tiers.DUAL.roi).toBeNull();
  });
});

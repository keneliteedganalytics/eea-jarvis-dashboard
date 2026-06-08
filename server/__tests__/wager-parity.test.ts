import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Isolated throwaway SQLite file — must be set before importing db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-wager-parity-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

// Mirrors the per-race shape the real GET /api/cards/:id/print handler builds:
// it reuses the bets already attached by storage.withRaces and only layers in
// the cached summary. We replicate that here to assert the Print payload's bets
// equal the Race Detail payload's bets (both come from storage.getCardWithRaces).
async function printPayload(cardId: number) {
  const { storage } = await import("../storage");
  const card = storage.getCardWithRaces(cardId)!;
  const races = card.races.map((r) => {
    const cached = storage.getRaceSummary(r.id);
    return { ...r, summary: cached?.summary ?? null };
  });
  return { ...card, races };
}

// The Race Detail view reads /api/cards/latest, which returns getLatestCard().
// For a single card that is the same data as getCardWithRaces(id).
async function raceDetailPayload(cardId: number) {
  const { storage } = await import("../storage");
  return storage.getCardWithRaces(cardId)!;
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

describe("buildWagers determinism", () => {
  it("returns identical output for identical input", async () => {
    const { buildWagers } = await import("../services/wagers");
    const race = { tier: "SNIPER", winPgm: "5", placePgm: "1", showPgm: "3", fourthPgm: "7" };
    const settings = { bankroll: 2000, dailyRiskCapPct: 0.03 };
    const a = buildWagers(race, settings, 9);
    const b = buildWagers(race, settings, 9);
    expect(a).toEqual(b);
  });

  it("PASS tier produces no legs", async () => {
    const { buildWagers } = await import("../services/wagers");
    const bets = buildWagers(
      { tier: "PASS", winPgm: "5", placePgm: "1", showPgm: "3", fourthPgm: "7" },
      { bankroll: 2000, dailyRiskCapPct: 0.03 },
      9,
    );
    expect(bets.pass).toBe(true);
    expect(bets.legs).toEqual([]);
  });
});

describe("Race Detail ↔ Print wager parity", () => {
  let cardId: number;

  beforeAll(async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard(
      { track: "Finger Lakes", date: "2025-09-01" },
      [
        {
          raceNumber: 1, tier: "SNIPER", flags: "[]",
          winPgm: "5", winName: "Alpha", winScore: 92.1,
          placePgm: "1", placeName: "Bravo", placeScore: 88.0,
          showPgm: "3", showName: "Charlie", showScore: 85.4,
          fourthPgm: "7", fourthName: "Delta", fourthScore: 80.2,
        },
        {
          raceNumber: 2, tier: "EDGE", flags: "[]",
          winPgm: "4", winName: "Echo", winScore: 90.0,
          placePgm: "2", placeName: "Foxtrot", placeScore: 84.1,
          showPgm: "6", showName: "Golf", showScore: 81.0,
        },
        { raceNumber: 3, tier: "PASS", flags: "[]" },
      ],
    );
    cardId = card.id;
  });

  it("returns byte-identical wager arrays from both surfaces for every race", async () => {
    const print = await printPayload(cardId);
    const detail = await raceDetailPayload(cardId);
    expect(print.races.length).toBe(detail.races.length);
    for (let i = 0; i < print.races.length; i++) {
      expect(print.races[i].bets).toBeTruthy();
      expect(print.races[i].bets).toEqual(detail.races[i].bets);
    }
  });

  it("stays in parity and updates after a voice re-rank changes a race", async () => {
    const { storage } = await import("../storage");

    const before = (await raceDetailPayload(cardId)).races[0].bets;
    expect(before?.tier).toBe("SNIPER");

    // Simulate the voice /confirm path: drop race 1 from SNIPER to RECON.
    const race1 = storage.getCardWithRaces(cardId)!.races[0];
    storage.updateRaceFusion(race1.id, { tier: "RECON" });

    const print = await printPayload(cardId);
    const detail = await raceDetailPayload(cardId);

    // Both surfaces reflect the new tier...
    expect(detail.races[0].bets?.tier).toBe("RECON");
    expect(print.races[0].bets?.tier).toBe("RECON");
    // ...the wagers actually changed from the pre-rerank snapshot...
    expect(detail.races[0].bets).not.toEqual(before);
    // ...and the two surfaces remain identical to each other.
    for (let i = 0; i < print.races.length; i++) {
      expect(print.races[i].bets).toEqual(detail.races[i].bets);
    }
  });
});

// PR #42 — PASS-WIN MISS detection: a PASS race whose actual winner was on our
// board grid (we rated it via a prediction row) but tiered PASS.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Isolated throwaway SQLite file — must be set before importing db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-pr42-passwin-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe("PR #42 PASS-WIN MISS detection (via card summary)", () => {
  it("flags a PASS race whose winner we rated, and ignores winners off our board", async () => {
    const { storage } = await import("../storage");

    // Card with two PASS races. Race 1's winner (#5) is on our board (a
    // prediction row), so it's a MISS. Race 2's winner (#9) was never rated, so
    // it is NOT a miss.
    const card = storage.createCard(
      { track: "Test Downs", date: "2026-06-09", betBudgetVersion: 2 },
      [
        { raceNumber: 1, tier: "PASS", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
        { raceNumber: 2, tier: "PASS", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
      ],
    );
    const [r1, r2] = card.races;

    // Board grid for race 1 includes #5 (the eventual winner), tiered PASS.
    storage.createPrediction({
      raceId: r1.id,
      horsePgm: "5",
      horseName: "Sleeper Five",
      tierAssigned: "PASS",
      createdAt: new Date(),
    });
    // Board grid for race 2 does NOT include its winner (#9).
    storage.createPrediction({
      raceId: r2.id,
      horsePgm: "2",
      horseName: "Rated Two",
      tierAssigned: "PASS",
      createdAt: new Date(),
    });

    storage.logResult(r1.id, ["5", "1", "2", "3"]); // winner #5 — on our board → miss
    storage.logResult(r2.id, ["9", "1", "2", "3"]); // winner #9 — off our board → not a miss

    const summary = storage.completeCard(card.id)!;
    expect(summary.passWinMissCount).toBe(1);

    const horses = JSON.parse(summary.passWinMissHorses) as Array<{
      raceNumber: number;
      horseNumber: string;
      name: string | null;
      ourTier: string;
    }>;
    expect(horses).toHaveLength(1);
    expect(horses[0]).toMatchObject({
      raceNumber: 1,
      horseNumber: "5",
      name: "Sleeper Five",
      ourTier: "PASS",
    });
  });

  it("regradeCard refreezes the summary and is idempotent on the miss count", async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard(
      { track: "Test Downs", date: "2026-06-10", betBudgetVersion: 2 },
      [{ raceNumber: 1, tier: "PASS", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" }],
    );
    const [r1] = card.races;
    storage.createPrediction({
      raceId: r1.id,
      horsePgm: "7",
      horseName: "Board Seven",
      tierAssigned: "PASS",
      createdAt: new Date(),
    });
    storage.logResult(r1.id, ["7", "1", "2", "3"]);

    const first = storage.completeCard(card.id)!;
    expect(first.passWinMissCount).toBe(1);
    const regraded = storage.regradeCard(card.id)!;
    expect(regraded.passWinMissCount).toBe(1);
  });
});

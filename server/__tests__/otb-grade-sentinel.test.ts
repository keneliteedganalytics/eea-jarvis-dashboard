// PR #45 — phantom-grade sentinel, phantom bankroll cleanup, and grade-time
// PASS-WIN MISS detection.

import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { isGradableOtbRace } from "../services/results-poller-cron";
import type { OtbRaceResult } from "../services/otb-results";

const TMP_DB = path.join(os.tmpdir(), `eea-pr45-sentinel-${Date.now()}.db`);
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

function otbRace(over: Partial<OtbRaceResult>): OtbRaceResult {
  return {
    raceNumber: 1,
    scheduledPost: "",
    finishOrder: [],
    finishers: [],
    payoutsRaw: {},
    isOfficial: false,
    ...over,
  };
}

describe("PR #45 phantom-grade sentinel", () => {
  it("rejects a not-yet-official stub race", () => {
    expect(isGradableOtbRace(otbRace({ isOfficial: false }))).toBe(false);
  });

  it("rejects an official-but-empty race (no finish order, no winner)", () => {
    expect(isGradableOtbRace(otbRace({ isOfficial: true, finishOrder: [] }))).toBe(false);
  });

  it("rejects a race with a finish order but no declared winner pgm", () => {
    expect(
      isGradableOtbRace(otbRace({ isOfficial: true, finishOrder: ["1", "2"], winPgm: undefined })),
    ).toBe(false);
  });

  it("accepts a genuine official race with a winner + payout", () => {
    expect(
      isGradableOtbRace(
        otbRace({
          isOfficial: true,
          finishOrder: ["7", "3", "1", "5"],
          winPgm: "7",
          winPayout: 6.4,
        }),
      ),
    ).toBe(true);
  });
});

describe("PR #45 phantom bankroll cleanup", () => {
  it("wipes a race-grade event whose race has no result and recomputes balance", async () => {
    const { storage } = await import("../storage");
    const { appendBankrollEvent, getCardLedger } = await import("../services/bankroll");
    const card = storage.createCard({ track: "Phantom Test", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "SNIPER", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
      { raceNumber: 4, tier: "EDGE", winPgm: "5", placePgm: "6", showPgm: "7", fourthPgm: "8" },
    ]);
    const r1 = card.races[0];
    const r4 = card.races[1];

    // R1 graded for real.
    storage.logResult(r1.id, ["1", "2", "3", "4"], { winPayout: 5.0 });
    // R4 phantom: a race-grade event with NO result row behind it (the Card #9
    // R4 −$167 scenario — cron fired on a stub page and logged a delta).
    appendBankrollEvent(card.id, r4.id, "race-grade", -167, "phantom");

    const before = getCardLedger(card.id);
    expect(before.some((e) => e.raceId === r4.id && e.source === "race-grade")).toBe(true);

    const { removed, balance } = storage.cleanupPhantomBankroll(card.id);
    expect(removed.length).toBe(1);

    const after = getCardLedger(card.id);
    expect(after.some((e) => e.raceId === r4.id && e.source === "race-grade")).toBe(false);
    // Phantom −167 is gone; balance is seed + real R1 net only.
    expect(balance).toBe(storage.getCardBankroll(card.id).balance);
    expect(after.some((e) => e.raceId === r1.id && e.source === "race-grade")).toBe(true);
  });
});

describe("PR #45 grade-time PASS-WIN MISS", () => {
  it("logs a PASS-WIN MISS when a PASS race's winner was on our board grid", async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "PassWin Test", date: "2026-06-09" }, [
      { raceNumber: 6, tier: "PASS", winPgm: "2", placePgm: "3", showPgm: "4", fourthPgm: "1" },
    ]);
    const r6 = card.races[0];

    // We rated #7 (the eventual winner) but tiered the race PASS — a true miss.
    storage.createPrediction({
      raceId: r6.id,
      horsePgm: "7",
      horseName: "Not for Hire",
      tierAssigned: "RECON",
      rank: 1,
      createdAt: new Date(),
    });

    // #7 wins.
    storage.logResult(r6.id, ["7", "2", "3", "4"], { winPayout: 9.2 });

    const summary = storage.getCardSummary(card.id);
    expect(summary).toBeDefined();
    expect(summary!.passWinMissCount).toBe(1);
    const horses = JSON.parse(summary!.passWinMissHorses) as Array<{
      raceNumber: number;
      horseNumber: string;
      name: string | null;
    }>;
    expect(horses).toHaveLength(1);
    expect(horses[0]).toMatchObject({ raceNumber: 6, horseNumber: "7", name: "Not for Hire" });
  });

  it("does not log a miss when the winner was off our board (no prediction)", async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "PassWin Clean", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "PASS", winPgm: "2", placePgm: "3", showPgm: "4", fourthPgm: "1" },
    ]);
    const r1 = card.races[0];
    storage.logResult(r1.id, ["9", "2", "3", "4"], { winPayout: 12.0 }); // #9 never rated

    const summary = storage.getCardSummary(card.id);
    // No summary row, or a row with zero misses — either is acceptable.
    expect(summary?.passWinMissCount ?? 0).toBe(0);
  });

  it("is idempotent per race on re-grade (no duplicate entry)", async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "PassWin Idem", date: "2026-06-09" }, [
      { raceNumber: 6, tier: "PASS", winPgm: "2", placePgm: "3", showPgm: "4", fourthPgm: "1" },
    ]);
    const r6 = card.races[0];
    storage.createPrediction({
      raceId: r6.id,
      horsePgm: "7",
      horseName: "Not for Hire",
      tierAssigned: "RECON",
      rank: 1,
      createdAt: new Date(),
    });
    storage.logResult(r6.id, ["7", "2", "3", "4"], { winPayout: 9.2 });
    storage.logResult(r6.id, ["7", "2", "3", "4"], { winPayout: 9.2 }); // re-grade

    const summary = storage.getCardSummary(card.id);
    expect(summary!.passWinMissCount).toBe(1);
  });
});

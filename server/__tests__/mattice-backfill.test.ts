import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import os from "node:os";

// Isolated throwaway SQLite file — set before importing db/storage so the runtime
// CREATE TABLE bootstrap runs against this file (mirrors backtest.integration.test).
const TMP_DB = path.join(os.tmpdir(), `eea-mattice-backfill-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

describe("runMatticeBackfill", () => {
  let runMatticeBackfill: typeof import("../services/mattice-backfill").runMatticeBackfill;
  let storage: typeof import("../storage").storage;
  let cardId: number;

  beforeAll(async () => {
    ({ runMatticeBackfill } = await import("../services/mattice-backfill"));
    ({ storage } = await import("../storage"));

    // Seed a 2-race card. R1: top two within the tiebreak band where #2 has the
    // stronger Mattice profile → tiebreak should flip the win pick. R2: a clean
    // leader, no flip. R1 carries a graded result so it auto-grades.
    const card = storage.createCard(
      { track: "Test Downs", date: "2026-06-10" },
      [
        { raceNumber: 1, tier: "SNIPER", winPgm: "1", winName: "Leader One" },
        { raceNumber: 2, tier: "EDGE", winPgm: "1", winName: "Solo Lead" },
      ],
    );
    cardId = card.id;
    const [r1, r2] = card.races;

    const now = new Date();
    const mkPred = (raceId: number, p: Record<string, unknown>) =>
      storage.createPrediction({
        raceId,
        horsePgm: String(p.pgm),
        horseName: String(p.name),
        eeas: p.eeas as number,
        eeap: p.eeap as number,
        eeac: p.eeac as number,
        eeaRating: p.eeaRating as number,
        rank: p.rank as number,
        createdAt: now,
      });

    // R1 — within-band tie; #2 has the dominant Mattice profile.
    mkPred(r1.id, { pgm: "1", name: "Leader One", eeas: 100, eeap: 100, eeac: 100, eeaRating: 101, rank: 1 });
    mkPred(r1.id, { pgm: "2", name: "Mattice Pick", eeas: 120, eeap: 120, eeac: 120, eeaRating: 100, rank: 2 });

    // R2 — a clear leader; no tiebreak.
    mkPred(r2.id, { pgm: "1", name: "Solo Lead", eeas: 130, eeap: 130, eeac: 130, eeaRating: 130, rank: 1 });
    mkPred(r2.id, { pgm: "2", name: "Backmarker", eeas: 70, eeap: 70, eeac: 70, eeaRating: 70, rank: 2 });

    // Grade R1 so the backfill auto-grades it and bumps the running record.
    storage.logResult(r1.id, ["2", "1"], {});
  });

  it("returns the card info, per-race results, distribution, graded count, and stats", () => {
    const out = runMatticeBackfill(cardId);

    expect(out.card).toEqual({ id: cardId, track: "Test Downs", date: "2026-06-10" });
    expect(out.races).toHaveLength(2);
    expect(out.skippedRaces).toEqual([]);

    const r1 = out.races.find((r) => r.raceNumber === 1)!;
    expect(r1.oldTier).toBe("SNIPER");
    expect(r1.tiebreakApplied).toBe(true); // #2 promoted over #1 within the band
    expect(typeof r1.note).toBe("string");
    expect(r1.matticeTopPgm).not.toBeNull();

    const r2 = out.races.find((r) => r.raceNumber === 2)!;
    expect(r2.tiebreakApplied).toBe(false);

    // R1 had a result → exactly one graded race this run.
    expect(out.gradedRaces).toBe(1);

    // Distribution only lists tiers that appear; SNIPER + EDGE were seeded.
    expect(out.tierDistribution.before.SNIPER).toBe(1);
    expect(out.tierDistribution.before.EDGE).toBe(1);

    // Stats are the refreshed roll-up.
    expect(out.stats.n).toBeGreaterThanOrEqual(1);
    expect(typeof out.stats.weightPhase).toBe("number");
    expect(typeof out.stats.phaseLabel).toBe("string");
  });

  it("persists the tiebreak win-pick swap to the race row", () => {
    const card = storage.getCardWithRaces(cardId)!;
    const r1 = card.races.find((r) => r.raceNumber === 1)!;
    expect(r1.winPgm).toBe("2");
    expect(r1.winName).toBe("Mattice Pick");
  });

  it("throws for a non-existent card", () => {
    expect(() => runMatticeBackfill(999999)).toThrow(/not found/i);
  });
});

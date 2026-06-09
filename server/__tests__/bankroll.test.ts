// PR #44 — per-card bankroll ledger + idempotent retier-after-scratch.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Isolated throwaway SQLite file — must be set before importing db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-pr44-bankroll-${Date.now()}.db`);
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

describe("PR #44 per-card bankroll ledger", () => {
  it("seeds a new card with a $1000 starting bankroll", async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "Bank Test", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "SNIPER", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
    ]);
    const { balance, events } = storage.getCardBankroll(card.id);
    expect(balance).toBe(1000);
    expect(events.some((e) => e.source === "card-start" && e.delta === 1000)).toBe(true);
  });

  it("applies a manual adjustment as a delta on the running balance", async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "Adjust Test", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "EDGE", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
    ]);
    storage.adjustCardBankroll(card.id, -250, "test debit");
    expect(storage.getCardBankroll(card.id).balance).toBe(750);
    storage.adjustCardBankroll(card.id, 100, "test credit");
    expect(storage.getCardBankroll(card.id).balance).toBe(850);
  });

  it("records exactly one race-grade event per race and is idempotent on re-grade", async () => {
    const { storage } = await import("../storage");
    const { getCardLedger } = await import("../services/bankroll");
    const card = storage.createCard({ track: "Grade Test", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "SNIPER", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
    ]);
    const r1 = card.races[0];

    storage.logResult(r1.id, ["1", "2", "3", "4"]);
    storage.logResult(r1.id, ["1", "2", "3", "4"]); // re-grade with identical net → no double-count

    const raceGradeEvents = getCardLedger(card.id).filter(
      (e) => e.source === "race-grade" && e.raceId === r1.id,
    );
    expect(raceGradeEvents).toHaveLength(1);
  });

  it("removes the race-grade event when the result is cleared", async () => {
    const { storage } = await import("../storage");
    const { getCardLedger } = await import("../services/bankroll");
    const card = storage.createCard({ track: "Clear Test", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "SNIPER", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
    ]);
    const r1 = card.races[0];
    storage.logResult(r1.id, ["1", "2", "3", "4"]);
    expect(getCardLedger(card.id).some((e) => e.source === "race-grade")).toBe(true);

    const removed = storage.deleteResult(r1.id);
    expect(removed).toBe(true);
    expect(storage.getResultByRace(r1.id)).toBeUndefined();
    expect(getCardLedger(card.id).some((e) => e.source === "race-grade")).toBe(false);
    // Balance returns to the $1000 seed.
    expect(storage.getCardBankroll(card.id).balance).toBe(1000);
  });
});

describe("PR #44 idempotent retier after scratch", () => {
  it("drops a scratched runner from the picks and re-tiers without it", async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "Scratch Test", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "SNIPER", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
    ]);
    const r1 = card.races[0];

    const after = storage.setHorseScratched(r1.id, "1", true)!;
    // #1 is gone from every pick slot; survivors shift up.
    expect([after.winPgm, after.placePgm, after.showPgm, after.fourthPgm]).not.toContain("1");
    expect(after.winPgm).toBe("2");
    expect(after.placePgm).toBe("3");
    expect(after.showPgm).toBe("4");

    // A result posted after the scratch grades cleanly against the survivors.
    const result = storage.logResult(r1.id, ["2", "3", "4", "5"]);
    expect(result.winHit).toBe(true);
  });

  it("is reversible: un-scratching restores the original picks", async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "Unscratch Test", date: "2026-06-09" }, [
      { raceNumber: 1, tier: "SNIPER", winPgm: "1", placePgm: "2", showPgm: "3", fourthPgm: "4" },
    ]);
    const r1 = card.races[0];
    storage.setHorseScratched(r1.id, "1", true);
    const restored = storage.setHorseScratched(r1.id, "1", false)!;
    expect(restored.winPgm).toBe("1");
    expect(restored.placePgm).toBe("2");
    expect(restored.showPgm).toBe("3");
    expect(restored.fourthPgm).toBe("4");
  });
});

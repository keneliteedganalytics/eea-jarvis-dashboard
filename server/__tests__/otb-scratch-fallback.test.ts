import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Isolated throwaway SQLite file — set before importing db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-otb-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

// Mock the OTB source so the fallback is deterministic + offline.
vi.mock("../services/otb-finger-lakes", () => ({
  fetchOtbFingerLakes: vi.fn(async () => ({
    date: "2026-06-08",
    scratches: [{ race: 1, program: "2", horse: "Horse 2" }],
    conditions: null,
    results: [],
    payouts: [],
    purses: [],
    fetchedAt: "2026-06-08T18:00:00.000Z",
  })),
}));

import { sqlite } from "../db";
import { storage } from "../storage";
import { mergeOtbScratches } from "../services/scratch-refresh";
import { fetchOtbFingerLakes } from "../services/otb-finger-lakes";

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
});

beforeEach(() => {
  sqlite.exec("DELETE FROM predictions; DELETE FROM pp_uploads; DELETE FROM races; DELETE FROM cards;");
  vi.clearAllMocks();
});

function seedFlxCard(track = "Finger Lakes"): { cardId: number; raceId: number } {
  const card = storage.createCard(
    { track, date: "2026-06-08", locked: true },
    [{ raceNumber: 1, tier: "SNIPER", conditions: "Alw 26500 · 6F Dirt", flags: "[]" }],
  );
  const raceId = storage.getRacesByCard(card.id)[0].id;
  const now = new Date();
  ["1", "2"].forEach((pgm, i) => {
    storage.createPrediction({
      raceId,
      horsePgm: pgm,
      horseName: `Horse ${pgm}`,
      eeas: 100 - i * 5,
      eeap: 100 - i * 5,
      eeac: 100 - i * 5,
      eeaRating: 100 - i * 5,
      tierAssigned: "SNIPER",
      rank: i + 1,
      createdAt: now,
    });
  });
  storage.updateRaceFusion(raceId, { tier: "SNIPER", winPgm: "1", winName: "Horse 1", winScore: 100 });
  return { cardId: card.id, raceId };
}

describe("mergeOtbScratches — Finger Lakes OTB fallback (PR #23)", () => {
  it("scratches a roster horse OTB lists that we hadn't flagged", async () => {
    const { cardId, raceId } = seedFlxCard();
    const merged = await mergeOtbScratches(cardId);
    expect(fetchOtbFingerLakes).toHaveBeenCalledOnce();
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ raceNumber: 1, horsePgm: "2", horseName: "Horse 2" });
    const two = storage.getPredictionsByRace(raceId).find((p) => p.horsePgm === "2")!;
    expect(two.scratched).toBe(true);
  });

  it("is idempotent — a second pass merges nothing", async () => {
    const { cardId } = seedFlxCard();
    await mergeOtbScratches(cardId);
    const second = await mergeOtbScratches(cardId);
    expect(second).toHaveLength(0);
  });

  it("does nothing for a non-Finger-Lakes card (and never fetches OTB)", async () => {
    const { cardId } = seedFlxCard("Saratoga");
    const merged = await mergeOtbScratches(cardId);
    expect(merged).toHaveLength(0);
    expect(fetchOtbFingerLakes).not.toHaveBeenCalled();
  });
});

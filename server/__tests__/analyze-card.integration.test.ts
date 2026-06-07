import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Use an isolated throwaway SQLite file so the integration run never touches the
// dev database. Must be set before importing anything that opens the db.
const TMP_DB = path.join(os.tmpdir(), `eea-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

const FIXTURES = path.resolve(process.cwd(), "test-fixtures");
const BRIS = path.join(FIXTURES, "brisnet-fingerlakes.pdf");
const EQUI = path.join(FIXTURES, "equibase-saratoga.pdf");
const haveFixtures = fs.existsSync(BRIS) && fs.existsSync(EQUI);

describe.skipIf(!haveFixtures)("analyzeCard integration", () => {
  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(TMP_DB + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  it("parses both PDFs and persists predictions for at least one race", async () => {
    const { analyzeCard } = await import("../services/analyze-card");
    const { storage } = await import("../storage");

    // No LLM keys → per-race LLM calls fail and are captured in errors, but
    // fusion still writes one prediction row per horse. That's what we assert.
    const result = await analyzeCard({
      track: "Finger Lakes",
      date: "2026-06-08",
      brisnetPath: BRIS,
      equibasePath: EQUI,
      brisnetFilename: "brisnet-fingerlakes.pdf",
      equibaseFilename: "equibase-saratoga.pdf",
      provider: "anthropic",
    });

    expect(result.cardId).toBeGreaterThan(0);

    const card = storage.getCardWithRaces(result.cardId);
    expect(card).toBeTruthy();
    expect(card!.races.length).toBeGreaterThan(0);

    const racesWithPredictions = card!.races.filter(
      (r) => storage.getPredictionsByRace(r.id).length > 0,
    );
    expect(racesWithPredictions.length).toBeGreaterThanOrEqual(1);

    // Predictions carry the fused composites.
    const preds = storage.getPredictionsByRace(racesWithPredictions[0].id);
    expect(preds[0].horsePgm.length).toBeGreaterThan(0);
    expect(preds[0].horseName.length).toBeGreaterThan(0);
  }, 60_000);
});

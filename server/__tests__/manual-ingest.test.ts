import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Isolated throwaway SQLite file — set before importing db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-manual-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;
process.env.MANUAL_DROP_DIR = path.join(os.tmpdir(), `eea-manual-drops-${Date.now()}`);

import {
  runManualIngest,
  type ManualIngestDeps,
} from "../services/manual-ingest";
import { storage } from "../storage";
import type { AnalyzeInput } from "../services/analyze-card";

// A fake analyze that exercises the real persistence layer (mirrors
// analyzeCard's contract) so the idempotency / replace path is real.
function fakeAnalyze(conviction = "HIGH", races = 8): ManualIngestDeps["analyze"] {
  return async (input: AnalyzeInput) => {
    const card = storage.createCard(
      { track: input.track, date: input.date, locked: false, cardConviction: conviction },
      Array.from({ length: races }, (_, i) => ({
        raceNumber: i + 1,
        tier: i === 0 ? "SNIPER" : "PASS",
        flags: "[]",
      })),
    );
    return { cardId: card.id, racesAnalyzed: races, errors: [] };
  };
}

const BRIS = Buffer.from("%PDF-1.4 fake-brisnet");
const EQUI = Buffer.from("%PDF-1.4 fake-equibase");

beforeEach(() => {
  for (const c of storage.getCards()) {
    storage.deletePredictionsByCard(c.id);
    storage.deleteCard(c.id);
  }
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe("runManualIngest", () => {
  it("persists a card from a Brisnet PDF and routes are tier-able", async () => {
    const res = await runManualIngest(
      { track: "FL", raceDate: "2026-06-09", brisnetBuffer: BRIS },
      { analyze: fakeAnalyze("HIGH", 8) },
    );

    expect(res.ok).toBe(true);
    expect(res.cardId).toBeTypeOf("number");
    expect(res.source).toBe("manual");
    expect(res.raceCount).toBe(8);
    // "FL" resolves to the canonical track name so it dedupes like a live pull.
    expect(res.track).toBe("Finger Lakes");
    // No Equibase dropped → a note, not a hard error.
    expect(res.errors.join(" ")).toMatch(/Brisnet PPs only/i);

    const card = storage.getCardWithRaces(res.cardId!);
    expect(card?.races.length).toBe(8);
  });

  it("writes the dropped Brisnet (and Equibase) bytes to disk", async () => {
    let seen: AnalyzeInput | null = null;
    const analyze: ManualIngestDeps["analyze"] = async (input) => {
      seen = input;
      const card = storage.createCard(
        { track: input.track, date: input.date, locked: false },
        [{ raceNumber: 1, tier: "PASS", flags: "[]" }],
      );
      return { cardId: card.id, racesAnalyzed: 1, errors: [] };
    };

    await runManualIngest(
      { track: "Finger Lakes", raceDate: "2026-06-09", brisnetBuffer: BRIS, equibaseBuffer: EQUI },
      { analyze },
    );

    expect(seen).not.toBeNull();
    expect(fs.existsSync(seen!.brisnetPath)).toBe(true);
    expect(fs.existsSync(seen!.equibasePath)).toBe(true);
    // Distinct paths when both files are provided.
    expect(seen!.brisnetPath).not.toBe(seen!.equibasePath);
    expect(fs.readFileSync(seen!.brisnetPath).equals(BRIS)).toBe(true);
    expect(fs.readFileSync(seen!.equibasePath).equals(EQUI)).toBe(true);
  });

  it("is idempotent on (track, raceDate): a re-drop replaces the prior card", async () => {
    const first = await runManualIngest(
      { track: "FL", raceDate: "2026-06-09", brisnetBuffer: BRIS },
      { analyze: fakeAnalyze("HIGH", 8) },
    );
    const second = await runManualIngest(
      { track: "FL", raceDate: "2026-06-09", brisnetBuffer: BRIS },
      { analyze: fakeAnalyze("LOW", 6) },
    );

    expect(second.cardId).not.toBe(first.cardId);
    // Only one card for (Finger Lakes, 2026-06-09) survives.
    const matches = storage
      .getCards()
      .filter((c) => c.track === "Finger Lakes" && c.date === "2026-06-09");
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe(second.cardId);
    expect(storage.getCard(first.cardId!)).toBeUndefined();
  });

  it("rejects a missing Brisnet buffer and a bad date", async () => {
    const noBris = await runManualIngest(
      { track: "FL", raceDate: "2026-06-09", brisnetBuffer: Buffer.alloc(0) },
      { analyze: fakeAnalyze() },
    );
    expect(noBris.ok).toBe(false);
    expect(noBris.errors.join(" ")).toMatch(/brisnetPdf is required/i);

    const badDate = await runManualIngest(
      { track: "FL", raceDate: "06/09/2026", brisnetBuffer: BRIS },
      { analyze: fakeAnalyze() },
    );
    expect(badDate.ok).toBe(false);
    expect(badDate.errors.join(" ")).toMatch(/YYYY-MM-DD/i);
  });
});

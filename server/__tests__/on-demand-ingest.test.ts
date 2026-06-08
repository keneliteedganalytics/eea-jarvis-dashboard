import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Isolated throwaway SQLite file — set before importing db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-ondemand-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

import {
  runOnDemandIngest,
  resolveTrack,
  validateDate,
  type OnDemandIngestDeps,
} from "../services/on-demand-ingest";
import { storage } from "../storage";
import type { IngestResult } from "../services/equibase-ingest";

// A real on-disk PDF so the service's fs.existsSync(equibasePath) check passes.
const TMP_PDF = path.join(os.tmpdir(), `eea-ondemand-${Date.now()}.pdf`);

// Build a per-source IngestResult for track code FL.
function okResult(code: string, raceCount: number, extra: Record<string, unknown> = {}): IngestResult {
  return {
    raceDate: "06/09/2026",
    status: "ok",
    results: [{ trackCode: code, status: "ok", raceCount, ...extra }],
  };
}
function errResult(code: string, error: string): IngestResult {
  return {
    raceDate: "06/09/2026",
    status: "error",
    results: [{ trackCode: code, status: "error", error }],
    error,
  };
}

// A fake analyze that creates a real card via storage so dedupe/partial paths
// exercise the actual persistence layer (mirrors analyzeCard's contract).
function fakeAnalyze(conviction = "HIGH", races = 8): OnDemandIngestDeps["analyze"] {
  return async (input) => {
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

beforeAll(() => {
  fs.writeFileSync(TMP_PDF, "%PDF-1.4 fake");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.unlinkSync(TMP_PDF);
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  // Clear cards between tests so dedupe assertions are isolated.
  for (const c of storage.getCards()) {
    storage.deletePredictionsByCard(c.id);
    storage.deleteCard(c.id);
  }
});

describe("resolveTrack", () => {
  it("resolves exact, alias, and fuzzy names", () => {
    expect(resolveTrack("Finger Lakes")?.code).toBe("FL");
    expect(resolveTrack("finger lake")?.code).toBe("FL"); // typo alias
    expect(resolveTrack("saratoga springs")?.code).toBe("SAR");
    expect(resolveTrack("SAR")?.code).toBe("SAR");
    expect(resolveTrack("gulfstream park")?.code).toBe("GP");
  });
  it("returns null for unknown tracks", () => {
    expect(resolveTrack("nowhere downs")).toBeNull();
  });
});

describe("validateDate", () => {
  it("accepts a near-future ISO date", () => {
    const out = validateDate("2026-06-09");
    expect("date" in out).toBe(true);
  });
  it("rejects non-ISO, impossible, too-far, and too-old dates", () => {
    expect("error" in validateDate("June 9")).toBe(true);
    expect("error" in validateDate("2026-13-40")).toBe(true);
    expect("error" in validateDate("2099-01-01")).toBe(true);
    expect("error" in validateDate("2000-01-01")).toBe(true);
  });
});

describe("runOnDemandIngest", () => {
  const deps = (over: Partial<OnDemandIngestDeps> = {}): OnDemandIngestDeps => ({
    runEquibase: async () => okResult("FL", 8, { pdfPath: TMP_PDF }),
    runBrisnet: async () => okResult("FL", 8, { zipPath: "/nonexistent/FL.zip" }),
    analyze: fakeAnalyze(),
    ...over,
  });

  it("success: both sources land → draft card created", async () => {
    const r = await runOnDemandIngest({ track: "Finger Lakes", date: "2026-06-09" }, deps());
    expect(r.status).toBe("success");
    expect(r.cardId).toBeGreaterThan(0);
    expect(r.raceCount).toBe(8);
    expect(r.conviction).toBe("HIGH");
    const card = storage.getCard(r.cardId!);
    expect(card?.locked).toBe(false); // draft, not locked
  });

  it("dedupe: a second pull for same track+date returns the existing card", async () => {
    const first = await runOnDemandIngest({ track: "Finger Lakes", date: "2026-06-09" }, deps());
    const before = storage.getCards().length;
    const second = await runOnDemandIngest({ track: "finger lake", date: "2026-06-09" }, deps());
    expect(second.status).toBe("success");
    expect(second.cardId).toBe(first.cardId);
    expect(second.warnings).toContain("existing card returned, ingest skipped");
    expect(storage.getCards().length).toBe(before); // no duplicate row
  });

  it("partial: Brisnet fails but Equibase succeeds → partial draft persists", async () => {
    const r = await runOnDemandIngest(
      { track: "Finger Lakes", date: "2026-06-09" },
      deps({ runBrisnet: async () => errResult("FL", "503 from Brisnet") }),
    );
    expect(r.status).toBe("partial");
    expect(r.cardId).toBeGreaterThan(0);
    expect(r.sources.equibase.ok).toBe(true);
    expect(r.sources.brisnet.ok).toBe(false);
    expect(r.warnings.some((w) => w.includes("Brisnet"))).toBe(true);
    const card = storage.getCard(r.cardId!);
    expect(card?.notes ?? "").toContain("Brisnet unavailable");
  });

  it("failed: unknown track returns a clean error, no card", async () => {
    const r = await runOnDemandIngest({ track: "Nowhere Downs", date: "2026-06-09" }, deps());
    expect(r.status).toBe("failed");
    expect(r.cardId).toBeUndefined();
    expect(storage.getCards().length).toBe(0);
  });

  it("failed: both sources empty → 'No races found' error", async () => {
    const r = await runOnDemandIngest(
      { track: "Finger Lakes", date: "2026-06-09" },
      deps({
        runEquibase: async () => errResult("FL", "not listed for date"),
        runBrisnet: async () => errResult("FL", "not listed for date"),
      }),
    );
    expect(r.status).toBe("failed");
    expect(r.warnings.join(" ")).toMatch(/No races found|not listed/);
  });
});

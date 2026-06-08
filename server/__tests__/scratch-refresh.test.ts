import { describe, it, expect, beforeEach, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";

// Isolated throwaway SQLite file — set before importing db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-scratch-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

import { sqlite } from "../db";
import { storage } from "../storage";
import {
  refreshScratchesForCard,
  recomputeTierIfNeeded,
  isScratchRefreshError,
} from "../services/scratch-refresh";
import { inRacingWindow } from "../services/scratch-refresh-cron";

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
});

// Wipe the mutable tables between tests so each builds its own fixture.
beforeEach(() => {
  sqlite.exec(
    "DELETE FROM predictions; DELETE FROM pp_uploads; DELETE FROM races; DELETE FROM cards;",
  );
});

// Build a one-race locked card with `dbPgms` predictions and a Brisnet source
// blob listing `sourcePgms`. eeaRating descends with the pgm order so the first
// listed pgm is the leader. Returns { cardId, raceId }.
function seedCard(opts: {
  locked?: boolean;
  dbPgms: string[];
  sourcePgms: string[];
  ratings?: Record<string, number>;
  conditions?: string;
}): { cardId: number; raceId: number } {
  const card = storage.createCard(
    { track: "Finger Lakes", date: "2026-06-08", locked: opts.locked ?? true },
    [{ raceNumber: 1, tier: "PASS", conditions: opts.conditions ?? "Alw 26500 N2L · 6F Dirt", flags: "[]" }],
  );
  const raceId = storage.getRacesByCard(card.id)[0].id;

  const now = new Date();
  opts.dbPgms.forEach((pgm, i) => {
    const rating = opts.ratings?.[pgm] ?? 100 - i * 5;
    storage.createPrediction({
      raceId,
      horsePgm: pgm,
      horseName: `Horse ${pgm}`,
      eeas: rating,
      eeap: rating,
      eeac: rating,
      eeaRating: rating,
      tierAssigned: "PASS",
      rank: i + 1,
      createdAt: now,
    });
  });

  // Persist the source roster as a Brisnet parsed_json blob (the shape
  // sourceRosterByRace reads). Only race/horse pgms matter for the diff.
  const brisnet = {
    track: "Finger Lakes",
    date: "2026-06-08",
    races: [
      {
        raceNumber: 1,
        conditions: { type: "ALW", raw: opts.conditions ?? "" },
        horses: opts.sourcePgms.map((pgm) => ({ pgm, name: `Horse ${pgm}`, pace: {} })),
      },
    ],
  };
  storage.createPpUpload({
    cardId: card.id,
    source: "brisnet",
    filename: "x.zip",
    storagePath: "/tmp/x.zip",
    parsedJson: JSON.stringify(brisnet),
    parseStatus: "ok",
    parseError: null,
    uploadedAt: now,
  });

  // Set initial picks/tier as if analysis ran (leader = first db pgm).
  storage.updateRaceFusion(raceId, {
    tier: "SNIPER",
    winPgm: opts.dbPgms[0],
    winName: `Horse ${opts.dbPgms[0]}`,
    winScore: opts.ratings?.[opts.dbPgms[0]] ?? 100,
  });

  return { cardId: card.id, raceId };
}

describe("refreshScratchesForCard — detection", () => {
  it("flags a DB horse no longer in the source as scratched, leaves the rest", () => {
    const { cardId, raceId } = seedCard({ dbPgms: ["1", "2"], sourcePgms: ["1"] });

    const result = refreshScratchesForCard(cardId);
    expect(isScratchRefreshError(result)).toBe(false);
    if (isScratchRefreshError(result)) return;

    expect(result.racesChecked).toBe(1);
    expect(result.newScratches).toHaveLength(1);
    expect(result.newScratches[0]).toMatchObject({ raceNumber: 1, horsePgm: "2" });
    expect(result.reinstated).toHaveLength(0);
    expect(result.unchangedCount).toBe(1);

    const preds = storage.getPredictionsByRace(raceId);
    const two = preds.find((p) => p.horsePgm === "2")!;
    const one = preds.find((p) => p.horsePgm === "1")!;
    expect(two.scratched).toBe(true);
    expect(two.scratchedAt).toBeTruthy();
    expect(one.scratched).toBe(false);
  });

  it("is idempotent — a second run reports no new scratches", () => {
    const { cardId } = seedCard({ dbPgms: ["1", "2"], sourcePgms: ["1"] });
    refreshScratchesForCard(cardId);
    const second = refreshScratchesForCard(cardId);
    if (isScratchRefreshError(second)) throw new Error("unexpected error");
    expect(second.newScratches).toHaveLength(0);
    expect(second.reinstated).toHaveLength(0);
  });
});

describe("refreshScratchesForCard — reinstatement", () => {
  it("un-scratches a horse that is back in the source", () => {
    const { cardId, raceId } = seedCard({ dbPgms: ["1", "2"], sourcePgms: ["1"] });
    refreshScratchesForCard(cardId); // scratch #2
    expect(storage.getPredictionsByRace(raceId).find((p) => p.horsePgm === "2")!.scratched).toBe(true);

    // Source now lists #2 again.
    const brisnet = {
      track: "Finger Lakes",
      date: "2026-06-08",
      races: [
        {
          raceNumber: 1,
          conditions: { type: "ALW", raw: "" },
          horses: [
            { pgm: "1", name: "Horse 1", pace: {} },
            { pgm: "2", name: "Horse 2", pace: {} },
          ],
        },
      ],
    };
    sqlite
      .prepare("UPDATE pp_uploads SET parsed_json = ? WHERE card_id = ?")
      .run(JSON.stringify(brisnet), cardId);

    const result = refreshScratchesForCard(cardId);
    if (isScratchRefreshError(result)) throw new Error("unexpected error");
    expect(result.reinstated).toHaveLength(1);
    expect(result.reinstated[0]).toMatchObject({ horsePgm: "2" });

    const two = storage.getPredictionsByRace(raceId).find((p) => p.horsePgm === "2")!;
    expect(two.scratched).toBe(false);
    expect(two.scratchedAt).toBeNull();
  });
});

describe("refreshScratchesForCard — early returns / safe failure", () => {
  it("returns an error for an unlocked card without writing", () => {
    const { cardId, raceId } = seedCard({ locked: false, dbPgms: ["1", "2"], sourcePgms: ["1"] });
    const result = refreshScratchesForCard(cardId);
    expect(isScratchRefreshError(result)).toBe(true);
    if (!isScratchRefreshError(result)) return;
    expect(result.reason).toBe("card-not-locked");
    // No prediction was scratched.
    expect(storage.getPredictionsByRace(raceId).every((p) => !p.scratched)).toBe(true);
  });

  it("returns source-unavailable when no parseable source blob exists", () => {
    const { cardId, raceId } = seedCard({ dbPgms: ["1", "2"], sourcePgms: ["1"] });
    // Remove the source blob.
    sqlite.prepare("DELETE FROM pp_uploads WHERE card_id = ?").run(cardId);

    const result = refreshScratchesForCard(cardId);
    expect(isScratchRefreshError(result)).toBe(true);
    if (!isScratchRefreshError(result)) return;
    expect(result.reason).toBe("source-unavailable");
    // DB untouched.
    expect(storage.getPredictionsByRace(raceId).every((p) => !p.scratched)).toBe(true);
  });

  it("returns card-not-found for an unknown id", () => {
    const result = refreshScratchesForCard(99999);
    expect(isScratchRefreshError(result)).toBe(true);
    if (!isScratchRefreshError(result)) return;
    expect(result.reason).toBe("card-not-found");
  });
});

describe("recomputeTierIfNeeded — scratching the top runner changes the tier", () => {
  it("promotes a new leader and recomputes the race tier from survivors", () => {
    // 3 runners; leader #1 well clear → SNIPER. Scratch #1 and the field
    // tightens, so the tier recomputes off #2 and #3.
    const { cardId, raceId } = seedCard({
      dbPgms: ["1", "2", "3"],
      sourcePgms: ["2", "3"],
      ratings: { "1": 120, "2": 100, "3": 99 },
    });

    const before = storage.getRace(raceId)!;
    expect(before.winPgm).toBe("1");

    const result = refreshScratchesForCard(cardId);
    if (isScratchRefreshError(result)) throw new Error("unexpected error");
    expect(result.newScratches.map((s) => s.horsePgm)).toContain("1");

    const after = storage.getRace(raceId)!;
    // The scratched top runner is no longer the win pick.
    expect(after.winPgm).toBe("2");
    expect(after.placePgm).toBe("3");
    // #2 over #3 by only 1 pt → no longer a SNIPER-sized gap.
    expect(after.tier).not.toBe("SNIPER");
  });

  it("marks the race PASS and clears picks when every runner is scratched", () => {
    const { cardId, raceId } = seedCard({ dbPgms: ["1", "2"], sourcePgms: [] });
    // Source roster has the race key but no horses → mark via empty-horse blob.
    const brisnet = {
      track: "Finger Lakes",
      date: "2026-06-08",
      races: [{ raceNumber: 1, conditions: { type: "ALW", raw: "" }, horses: [] }],
    };
    sqlite
      .prepare("UPDATE pp_uploads SET parsed_json = ? WHERE card_id = ?")
      .run(JSON.stringify(brisnet), cardId);

    // A race with no source horses is ambiguous and skipped by the diff, so to
    // exercise the all-scratched path we scratch both directly then recompute.
    for (const p of storage.getPredictionsByRace(raceId)) {
      storage.updatePrediction(p.id, { scratched: true, scratchedAt: new Date().toISOString() });
    }
    recomputeTierIfNeeded(raceId);

    const after = storage.getRace(raceId)!;
    expect(after.tier).toBe("PASS");
    expect(after.winPgm).toBeNull();
  });
});

describe("inRacingWindow", () => {
  const TZ = "America/New_York"; // June → UTC-4
  it("is true between 10am local and last post + 1h", () => {
    // Post 14:00Z = 10am EDT. 'now' 16:00Z = noon EDT → inside window.
    const posts = ["2026-06-08T18:00:00Z"]; // last race 2pm EDT
    expect(inRacingWindow(posts, TZ, new Date("2026-06-08T16:00:00Z"))).toBe(true);
  });
  it("is false before 10am local", () => {
    const posts = ["2026-06-08T18:00:00Z"];
    // 13:00Z = 9am EDT → before window open.
    expect(inRacingWindow(posts, TZ, new Date("2026-06-08T13:00:00Z"))).toBe(false);
  });
  it("is false more than 1h after the last post", () => {
    const posts = ["2026-06-08T18:00:00Z"]; // 2pm EDT
    // 19:30Z = 3:30pm EDT, > 1h after last post → window closed.
    expect(inRacingWindow(posts, TZ, new Date("2026-06-08T19:30:00Z"))).toBe(false);
  });
  it("is false with no parseable posts", () => {
    expect(inRacingWindow([], TZ, new Date("2026-06-08T16:00:00Z"))).toBe(false);
  });
});

describe("POST /api/cards/:id/refresh-scratches endpoint shape", () => {
  it("returns the summary JSON shape for a locked card", async () => {
    const { cardId } = seedCard({ dbPgms: ["1", "2"], sourcePgms: ["1"] });

    // Mount just the one route against the real storage (avoids booting crons).
    const app = express();
    app.use(express.json());
    app.post("/api/cards/:id/refresh-scratches", (req, res) => {
      const id = Number(req.params.id);
      if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
      const result = refreshScratchesForCard(id);
      if (isScratchRefreshError(result)) return res.status(409).json(result);
      res.json(result);
    });

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/cards/${cardId}/refresh-scratches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toMatchObject({
        cardId,
        racesChecked: 1,
        unchangedCount: 1,
      });
      expect(Array.isArray(body.newScratches)).toBe(true);
      expect(Array.isArray(body.reinstated)).toBe(true);
      expect(body.newScratches[0]).toMatchObject({ raceNumber: 1, horsePgm: "2", horseName: "Horse 2" });
    } finally {
      server.close();
    }
  });

  it("returns 409 with a reason for an unlocked card", async () => {
    const { cardId } = seedCard({ locked: false, dbPgms: ["1", "2"], sourcePgms: ["1"] });
    const app = express();
    app.use(express.json());
    app.post("/api/cards/:id/refresh-scratches", (req, res) => {
      const id = Number(req.params.id);
      if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
      const result = refreshScratchesForCard(id);
      if (isScratchRefreshError(result)) return res.status(409).json(result);
      res.json(result);
    });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/cards/${cardId}/refresh-scratches`, {
        method: "POST",
      });
      expect(resp.status).toBe(409);
      const body = await resp.json();
      expect(body.reason).toBe("card-not-locked");
    } finally {
      server.close();
    }
  });
});

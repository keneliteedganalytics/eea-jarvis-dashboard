import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Isolate this suite on its own temp DB so it doesn't collide with other tests.
const TMP_DB = path.join(os.tmpdir(), `eea-expert-picks-test-${Date.now()}.db`);
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

// ── HTML parser fixtures (no live URLs are ever hit in tests) ───────────────
const RACING_DUDES_HTML = `
<html><body>
<table>
  <tr><th>Race</th><th>Pick</th><th>Odds</th><th>Trainer</th><th>Jockey</th></tr>
  <tr><td>1</td><td>2 Holiday Cash</td><td>5-2</td><td>Smith</td><td>Ortiz</td></tr>
  <tr><td>2</td><td>5 Lucky Strike</td><td>3-1</td><td>Jones</td><td>Rosario</td></tr>
</table>
</body></html>`;

const NYRA_SERLING_HTML = `
<html><body>
<div class="talking-horses">
  <p>Race 1 7 - 5 - 4 - 2</p>
  <p>Race 2 3 - 1 - 6</p>
</div>
</body></html>`;

const CHURCHILL_HTML = `
<html><body>
<table>
  <tr><th>Race</th><th>Kevin Kilroy</th><th>Other Guy</th></tr>
  <tr><td>1</td><td>1-5/3-6</td><td>2-4</td></tr>
  <tr><td>2</td><td>4-2</td><td>1-3</td></tr>
</table>
</body></html>`;

describe("expert-picks parsers (fixtures)", () => {
  it("parses Racing Dudes top picks (leading int of the pick cell)", async () => {
    const { parseRacingDudes } = await import(
      "../expert-picks-fetchers/racing-dudes"
    );
    const rows = parseRacingDudes(RACING_DUDES_HTML, "Belmont", "2026-06-12");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      track: "Belmont",
      race: 1,
      topPick: 2,
      source: "racingdudes",
      picks24: [],
    });
    expect(rows[1].topPick).toBe(5);
  });

  it("parses NYRA/Serling ranked selections into top + picks_2_4", async () => {
    const { parseNyraSerling } = await import(
      "../expert-picks-fetchers/nyra-serling"
    );
    const rows = parseNyraSerling(NYRA_SERLING_HTML, "2026-06-12");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      track: "Belmont",
      race: 1,
      topPick: 7,
      picks24: [5, 4, 2],
      source: "nyra_serling",
      sourceHandicapper: "Andy Serling",
    });
    expect(rows[1]).toMatchObject({ race: 2, topPick: 3, picks24: [1, 6] });
  });

  it("parses Churchill official (Kilroy) selections", async () => {
    const { parseChurchillOfficial } = await import(
      "../expert-picks-fetchers/churchill-official"
    );
    const rows = parseChurchillOfficial(CHURCHILL_HTML, "2026-06-12");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      track: "Churchill Downs",
      race: 1,
      topPick: 1,
      picks24: [5, 3, 6],
      source: "churchill_official",
      sourceHandicapper: "Kevin Kilroy",
    });
    expect(rows[1]).toMatchObject({ race: 2, topPick: 4, picks24: [2] });
  });
});

describe("expert-picks storage + reconcile", () => {
  it("bulkUpsertExpertPicks is idempotent on (track,date,race,source)", async () => {
    const { storage } = await import("../storage");
    const pick = {
      track: "Belmont",
      date: "2026-06-12",
      race: 1,
      source: "racingdudes",
      sourceHandicapper: "Racing Dudes",
      topPick: 2,
      picks24: [],
      rawText: "1 | 2 Holiday Cash",
    };
    const first = storage.bulkUpsertExpertPicks([pick]);
    expect(first.inserted).toBe(1);
    expect(first.updated).toBe(0);

    // Re-upsert the same key with a changed top pick → update, not insert.
    const second = storage.bulkUpsertExpertPicks([{ ...pick, topPick: 9 }]);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);

    const rows = storage.getExpertPicks({ track: "Belmont", date: "2026-06-12" });
    expect(rows).toHaveLength(1);
    expect(rows[0].topPick).toBe(9);
  });

  it("gradeExpertPick maps the winner to WIN/PLACE/SHOW/4TH/OUT", async () => {
    const { gradeExpertPick } = await import("../expert-picks");
    const row = { topPick: 7, picks24: [5, 4, 2] };
    expect(gradeExpertPick(row, 7)).toBe("WIN");
    expect(gradeExpertPick(row, 5)).toBe("PLACE");
    expect(gradeExpertPick(row, 4)).toBe("SHOW");
    expect(gradeExpertPick(row, 2)).toBe("4TH");
    expect(gradeExpertPick(row, 9)).toBe("OUT");
  });

  it("updateExpertPickResult persists the graded result + winner", async () => {
    const { storage } = await import("../storage");
    storage.bulkUpsertExpertPicks([
      {
        track: "Aqueduct",
        date: "2026-06-12",
        race: 3,
        source: "nyra_serling",
        sourceHandicapper: "Andy Serling",
        topPick: 7,
        picks24: [5, 4, 2],
        rawText: "Race 3 7 - 5 - 4 - 2",
      },
    ]);
    const [row] = storage.getExpertPicks({ track: "Aqueduct", date: "2026-06-12" });
    storage.updateExpertPickResult(row.id, "PLACE", 5);
    const [updated] = storage.getExpertPicks({ track: "Aqueduct", date: "2026-06-12" });
    expect(updated.result).toBe("PLACE");
    expect(updated.winner).toBe(5);
  });
});

describe("expert comparison math", () => {
  it("computes edge deltas from EEA book bets vs graded expert picks", async () => {
    const { storage } = await import("../storage");
    const { buildExpertComparison } = await import("../expert-picks");

    const DATE = "2026-06-13";
    const TRACK = "Saratoga";

    // EEA: 2 book bets, 1 WIN. wagered 20, payout 30 → net +10, roi +50%,
    // win% 50.
    storage.bulkUpsertRealBets([
      {
        betId: "cmp-1",
        placedAt: `${DATE}T13:00`,
        date: DATE,
        track: TRACK,
        race: 1,
        betType: "WIN",
        betSubtype: null,
        wagerDesc: "#3",
        baseAmount: 10,
        totalCost: 10,
        payout: 30,
        result: "WIN",
        source: "test",
      },
      {
        betId: "cmp-2",
        placedAt: `${DATE}T13:30`,
        date: DATE,
        track: TRACK,
        race: 2,
        betType: "WIN",
        betSubtype: null,
        wagerDesc: "#1",
        baseAmount: 10,
        totalCost: 10,
        payout: 0,
        result: "LOSS",
        source: "test",
      },
    ]);

    // Expert: 2 graded picks, 1 WIN → win% 50, flat-bet sim wagers $2/pick=$4,
    // returns 1*$7=$7 → roi +75%.
    storage.bulkUpsertExpertPicks([
      {
        track: TRACK,
        date: DATE,
        race: 1,
        source: "racingdudes",
        sourceHandicapper: "Racing Dudes",
        topPick: 3,
        picks24: [],
        rawText: "",
      },
      {
        track: TRACK,
        date: DATE,
        race: 2,
        source: "racingdudes",
        sourceHandicapper: "Racing Dudes",
        topPick: 8,
        picks24: [],
        rawText: "",
      },
    ]);
    const r1 = storage.getExpertPicks({ track: TRACK, date: DATE }).find((p) => p.race === 1)!;
    const r2 = storage.getExpertPicks({ track: TRACK, date: DATE }).find((p) => p.race === 2)!;
    storage.updateExpertPickResult(r1.id, "WIN", 3);
    storage.updateExpertPickResult(r2.id, "OUT", 5);

    const cmp = buildExpertComparison({ track: TRACK, date: DATE });

    expect(cmp.eea.bets).toBe(2);
    expect(cmp.eea.wins).toBe(1);
    expect(cmp.eea.net).toBeCloseTo(10, 1);
    expect(cmp.eea.roi).toBeCloseTo(50, 1);
    expect(cmp.eea.winPct).toBeCloseTo(50, 1);

    expect(cmp.expert.graded).toBe(2);
    expect(cmp.expert.wins).toBe(1);
    expect(cmp.expert.win_pct).toBeCloseTo(50, 1);
    expect(cmp.expert.flat_bet_roi).toBeCloseTo(75, 1);

    // win_pct_delta = 50 - 50 = 0; roi_delta = 50 - 75 = -25.
    expect(cmp.edge.win_pct_delta).toBeCloseTo(0, 1);
    expect(cmp.edge.roi_delta).toBeCloseTo(-25, 1);
  });
});

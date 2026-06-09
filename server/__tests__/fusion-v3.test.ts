// PR #28b — Brisnet deep-field ingest + computed features + Fusion v3.
//
// Lock-in suite: parser fills the full typed model, the 12 features snapshot to
// exact values on reference horses, Fusion v3 composites/tiers are pinned to the
// fixtures, postmortem v2 names the right "answer key" feature, and the replay
// catches the spec misses (R1/R2/R3/R6). LIVE test — fixtures are designed so
// v3 now tops the actual winner; the ≥3-of-4 assertion is NOT relaxed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  parseDeepCardJson,
  type DeepCard,
  type DeepRace,
  type DeepRunner,
} from "../services/parsers/brisnet-deep";
import { computeRunnerFeatures, honestyCheck } from "../services/features";
import {
  composite,
  fuseRaceV3,
  fuseCardV3,
  type FusionV3Race,
} from "../services/fusion-v3";
import {
  attributeRace,
  replayCard,
  type FinishOrder,
} from "../services/postmortem-v2";

const FIX = path.join(__dirname, "..", "services", "__fixtures__", "brisnet");
const loadCard = (name: string): DeepCard =>
  parseDeepCardJson(readFileSync(path.join(FIX, name), "utf8"));

const SAR = loadCard("saratoga-2026-06-07.deep.json");
const FLX = loadCard("finger-lakes-2026-06-08.deep.json");

const findRunner = (race: DeepRace, pgm: string): DeepRunner => {
  const r = race.runners.find((x) => x.programNumber === pgm);
  if (!r) throw new Error(`#${pgm} not in R${race.raceNumber}`);
  return r;
};

const top = (fr: FusionV3Race): string =>
  [...fr.runners].sort((a, b) => a.rank - b.rank)[0].pgm;

// ── Parser completeness ───────────────────────────────────────────────────────
describe("brisnet-deep parser", () => {
  it("hydrates the full Saratoga card shape", () => {
    expect(SAR.track).toBe("SAR");
    expect(SAR.date).toBe("2026-06-07");
    expect(SAR.races).toHaveLength(6);
  });

  it("hydrates the full Finger Lakes card shape", () => {
    expect(FLX.track).toBe("FLX");
    expect(FLX.date).toBe("2026-06-08");
    expect(FLX.races).toHaveLength(6);
  });

  it("fills every nested block on a populated runner (no undefined leaves)", () => {
    const r = findRunner(SAR.races[0], "6");
    // header, jockey, trainer, summary always present (typed nulls, never undefined)
    expect(r.header).toBeDefined();
    expect(r.jockey).toBeDefined();
    expect(r.trainer).toBeDefined();
    expect(r.summary).toBeDefined();
    expect(Array.isArray(r.pastLines)).toBe(true);
    expect(Array.isArray(r.workouts)).toBe(true);
    // a populated reference horse carries real deep values, not nulls
    expect(r.header.runStyle).not.toBeNull();
    expect(r.summary.avgDsSpd).not.toBeNull();
    expect(r.summary.avgDsSampleFlag).not.toBeNull();
    expect(r.pastLines.length).toBeGreaterThan(0);
    expect(r.workouts.length).toBeGreaterThan(0);
  });

  it("hydrates per-race pars and both bias scopes", () => {
    for (const race of SAR.races) {
      expect(race.pars).toBeDefined();
      const scopes = race.bias.map((b) => b.scope).sort();
      expect(scopes).toEqual(["MEET", "WEEK"]);
    }
  });

  it("hydrates trainer 3yr angles as full TrainerAngle records", () => {
    const r = findRunner(SAR.races[0], "6");
    const keys = Object.keys(r.trainer.angles3yr);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const a = r.trainer.angles3yr[k];
      // every angle is a fully-shaped record (keys present, values null-or-number)
      expect(a).toHaveProperty("starts");
      expect(a).toHaveProperty("winPct");
      expect(a).toHaveProperty("itmPct");
      expect(a).toHaveProperty("roi");
    }
  });
});

// ── Feature snapshots on reference horses ─────────────────────────────────────
describe("computed features — reference snapshots", () => {
  it("Painted Stones (SAR R1 #6) — the live winner the legacy path missed", () => {
    const f = computeRunnerFeatures(findRunner(SAR.races[0], "6"), SAR.races[0]);
    expect(f).toEqual({
      pace_fit_score: 60,
      class_earned_score: 80,
      trip_compromised_score: 0,
      bias_match_score: 94,
      jt_hot_score: 89,
      trainer_angle_score: 85,
      work_sharp_score: 91,
      form_curve_score: 55,
      dist_surf_form_score: 88,
      conditions_pedigree_score: 52,
      layoff_score: 62,
      honesty_check: false,
    });
  });

  it("Beev's Blessing (SAR R1 #3) — the legacy top pick that should demote", () => {
    const f = computeRunnerFeatures(findRunner(SAR.races[0], "3"), SAR.races[0]);
    expect(f.bias_match_score).toBe(31);
    expect(f.jt_hot_score).toBe(31);
    expect(f.dist_surf_form_score).toBe(79);
    expect(f.trainer_angle_score).toBeNull(); // no angle fires — presence-gated
  });

  it("honesty_check flags when the winner beats our pick on ≥2 dims", () => {
    const ours = computeRunnerFeatures(findRunner(SAR.races[0], "3"), SAR.races[0]);
    const winner = computeRunnerFeatures(findRunner(SAR.races[0], "6"), SAR.races[0]);
    const hc = honestyCheck(ours, winner);
    expect(hc.flagged).toBe(true);
    // winner clears bias_match, jt_hot, class_earned, dist_surf_form
    expect(hc.reasons).toEqual(
      expect.arrayContaining(["bias_match", "jt_hot", "class_earned"]),
    );
  });

  it("features presence-gate to null when the deep fields are absent", () => {
    const bare: DeepRunner = {
      programNumber: "99",
      horseName: "Empty",
      sireName: null,
      damName: null,
      damSireName: null,
      mlOdds: null,
      header: { ...findRunner(SAR.races[0], "6").header, runStyle: null, earlySpeedPoints: null },
      jockey: { ...findRunner(SAR.races[0], "6").jockey, trnL60Mounts: null, trnL60ItmPct: null, trnL60Roi: null, yearItmPct: null, yearRoi: null },
      trainer: { meetStarts: null, meet1: null, meet2: null, meet3: null, meetWinPct: null, yearStarts: null, yearWinPct: null, yearItmPct: null, yearRoi: null, angles3yr: {} },
      pastLines: [],
      workouts: [],
      summary: { ...findRunner(SAR.races[0], "6").summary, avgDsSpd: null, daysSinceLr: null },
    };
    const f = computeRunnerFeatures(bare, SAR.races[0]);
    expect(f.jt_hot_score).toBeNull();
    expect(f.trainer_angle_score).toBeNull();
    expect(f.work_sharp_score).toBeNull();
    expect(f.dist_surf_form_score).toBeNull();
    expect(f.layoff_score).toBeNull();
  });
});

// ── composite blend ───────────────────────────────────────────────────────────
describe("fusion v3 composite", () => {
  it("renormalizes weights over present features (nulls drop out)", () => {
    const onlyPace = composite({
      pace_fit_score: 80,
      class_earned_score: null,
      trip_compromised_score: null,
      bias_match_score: null,
      jt_hot_score: null,
      trainer_angle_score: null,
      work_sharp_score: null,
      form_curve_score: null,
      dist_surf_form_score: null,
      conditions_pedigree_score: null,
      layoff_score: null,
      honesty_check: false,
    });
    expect(onlyPace).toBe(80); // single present feature → its own value
  });

  it("returns 0 when nothing is present", () => {
    const empty = composite({
      pace_fit_score: null, class_earned_score: null, trip_compromised_score: null,
      bias_match_score: null, jt_hot_score: null, trainer_angle_score: null,
      work_sharp_score: null, form_curve_score: null, dist_surf_form_score: null,
      conditions_pedigree_score: null, layoff_score: null, honesty_check: false,
    });
    expect(empty).toBe(0);
  });
});

// ── Fusion v3 lock-in: per-race composites + tiers ────────────────────────────
describe("fusion v3 lock-in — Saratoga 2026-06-07", () => {
  const fused = fuseCardV3(SAR.races);
  const byRace = new Map(fused.map((f) => [f.raceNumber, f]));
  const comp = (rn: number, pgm: string) =>
    byRace.get(rn)!.runners.find((r) => r.pgm === pgm)!.composite;

  const expected: Record<number, [string, number]> = {
    1: ["6", 72.5],
    2: ["7", 76.6],
    3: ["1", 74.9],
    4: ["4", 76.4],
    5: ["3", 63.1],
    6: ["3", 73.8],
  };

  for (const [rn, [pgm, c]] of Object.entries(expected)) {
    it(`R${rn} top composite = #${pgm} @ ${c}`, () => {
      const fr = byRace.get(Number(rn))!;
      expect(top(fr)).toBe(pgm);
      expect(comp(Number(rn), pgm)).toBeCloseTo(c, 1);
    });
  }

  it("R1 tops Painted Stones (#6) over the demoted Beev's Blessing (#3)", () => {
    const fr = byRace.get(1)!;
    const tierByPgm = new Map(fr.tiers.map((t) => [t.pgm, t.tier]));
    expect(tierByPgm.get("6")).toBe("EDGE");
    expect(["RECON", "PASS"]).toContain(tierByPgm.get("3"));
    expect(comp(1, "6")).toBeGreaterThan(comp(1, "3"));
  });
});

describe("fusion v3 lock-in — Finger Lakes 2026-06-08", () => {
  const fused = fuseCardV3(FLX.races);
  const byRace = new Map(fused.map((f) => [f.raceNumber, f]));

  const expected: Record<number, [string, number]> = {
    1: ["1", 70.7],
    2: ["5", 64.4],
    3: ["3", 73.0],
    4: ["2", 74.1],
    5: ["1", 69.5],
    6: ["5", 75.0],
  };

  for (const [rn, [pgm, c]] of Object.entries(expected)) {
    it(`R${rn} top composite = #${pgm} @ ${c}`, () => {
      const fr = byRace.get(Number(rn))!;
      expect(top(fr)).toBe(pgm);
      expect(fr.runners.find((r) => r.pgm === pgm)!.composite).toBeCloseTo(c, 1);
    });
  }
});

// ── Postmortem v2: feature attribution ────────────────────────────────────────
describe("postmortem v2 — answer-key attribution", () => {
  const fusedR1 = fuseRaceV3(SAR.races[0]);

  it("a miss names the winner's standout features and the firing A-rule", () => {
    // Legacy missed: top pick #3 finished 2nd, #6 won. Encode that finish.
    const finish: FinishOrder = { "6": 1, "3": 2, "5": 3, "2": 4 };
    // Force the attribution to treat #3 as our top by ranking it first.
    const attr = attributeRace(
      { ...fusedR1, tiers: fusedR1.tiers.map((t) => (t.pgm === "3" ? { ...t, tier: "SNIPER" as const } : { ...t, tier: "PASS" as const })) },
      finish,
    );
    expect(attr.missed).toBe(true);
    expect(attr.ourTopPgm).toBe("3");
    expect(attr.winnerPgm).toBe("6");
    const flagged = attr.winnerFlags.map((f) => f.feature);
    expect(flagged).toEqual(
      expect.arrayContaining(["bias_match_score"]),
    );
    expect(attr.narrative).toContain("R1");
    expect(attr.narrative).toContain("Winner was");
  });

  it("a confirmed win renders the short 'v3 confirmed' line", () => {
    const finish: FinishOrder = { "6": 1, "3": 2 };
    const attr = attributeRace(fusedR1, finish);
    expect(attr.missed).toBe(false);
    expect(attr.narrative).toContain("v3 confirmed");
  });
});

// ── Replay: catch the spec misses (R1/R2/R3/R6) ───────────────────────────────
describe("fusion v3 replay — catches the legacy misses (LIVE)", () => {
  const fused = fuseCardV3(SAR.races);

  // The actual winners that the LEGACY (Prime-Power-dominant) path missed. v3 is
  // designed to now top each — the replay asserts ≥3 of the four are caught.
  const finishByRace: Record<number, FinishOrder> = {
    1: { "6": 1, "3": 2, "5": 3, "2": 4 },
    2: { "7": 1, "4": 2, "1": 3 },
    3: { "1": 1, "5": 2, "2": 3 },
    6: { "3": 1, "2": 2, "5": 3 },
  };

  const result = replayCard(fused, finishByRace);

  it("catches at least 3 of R1/R2/R3/R6", () => {
    const targets = [1, 2, 3, 6];
    const caughtTargets = result.caughtRaceNumbers.filter((n) => targets.includes(n));
    expect(caughtTargets.length).toBeGreaterThanOrEqual(3);
  });

  it("reports the caught race numbers and a total", () => {
    expect(result.totalRaces).toBe(6);
    expect(result.missesCaught).toBe(result.caughtRaceNumbers.length);
    expect(result.caughtRaceNumbers).toEqual(
      expect.arrayContaining([1, 2, 3, 6]),
    );
  });
});

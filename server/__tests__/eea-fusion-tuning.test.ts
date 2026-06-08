// PR #27 — Fusion tier-tuning v2 (A1-A5). One test per rule, exercised both at
// the pure-function level and through the live assignTierV2 path so we know the
// rules are actually wired into tier assignment, not just defined.

import { describe, it, expect } from "vitest";
import {
  assignTierV2,
  canQualifyAsDual,
  ratingGapPenalty,
  passCompressionPromotion,
  runHonestyCheck,
  softTierLazyBucket,
  emptyFactors,
  type FusionFactors,
  type FusedRace,
  type FusedHorse,
  type Tier,
} from "../services/eea-fusion";
import { DEFAULT_WEIGHTS } from "../services/eea-config";
import type { RaceConditions } from "../services/parsers/types";

const W = DEFAULT_WEIGHTS;
const ALW: RaceConditions = { type: "ALW", raw: "Allowance", purse: 60000, distance: "6F", surface: "DIRT" };

// Minimal FusedHorse builder — only the fields the tier rules read.
function horse(pgm: string, rating: number, opts: Partial<FusedHorse> = {}): FusedHorse {
  return {
    pgm,
    name: `H${pgm}`,
    isMaiden: false,
    eeas: opts.eeas ?? rating,
    eeap: opts.eeap ?? rating,
    eeapFit: opts.eeapFit ?? rating,
    eeac: opts.eeac ?? rating,
    eeaRating: rating,
    mlOdds: opts.mlOdds ?? null,
    rank: 0,
    flags: opts.flags ?? [],
    bloodstockAdjustment: opts.bloodstockAdjustment ?? {
      applied: false,
      composite: 50,
      reasonCodes: [],
      confidence: "none",
      ratingDelta: 0,
    },
  };
}

function race(horses: FusedHorse[], shapeNote = "honest pace", raceType: FusedRace["raceType"] = "allowance"): FusedRace {
  const ranked = [...horses].sort((a, b) => (b.eeaRating ?? 0) - (a.eeaRating ?? 0));
  ranked.forEach((h, i) => (h.rank = i + 1));
  return {
    raceNumber: 1,
    raceType,
    conditions: ALW,
    shapeNote,
    horses,
    weatherAdjustment: { applied: false, surface: "unknown", reasonCodes: [] },
  };
}

// A factors record with everything "on" (used as the strong baseline).
function strongFactors(): FusionFactors {
  return {
    tripContextFlags: ["needed lone speed"],
    paceRole: "E",
    earnedClassAtLevel: true,
    surfaceFitGrade: "A",
    distanceFitGrade: "A",
    bloodstockSurfaceYes: true,
    bloodstockDistanceYes: true,
    classTrend: "+",
    paceFit: 80,
  };
}

describe("A1 — earned-class gate on DUAL", () => {
  it("downgrades a DUAL candidate with no trip/pace/earned-class; keeps it with one", () => {
    const f = race([], "honest pace");
    const h = horse("2", 90);

    // No supporting factor → cannot qualify.
    const bare = { ...emptyFactors() };
    expect(canQualifyAsDual(h, f, bare)).toBe(false);

    // Any one of the three gates qualifies it.
    const withTrip = { ...emptyFactors(), tripContextFlags: ["wide trip last"] };
    expect(canQualifyAsDual(h, f, withTrip)).toBe(true);
    const withClass = { ...emptyFactors(), earnedClassAtLevel: true };
    expect(canQualifyAsDual(h, f, withClass)).toBe(true);
  });

  it("wired live: DUAL slot reverts to RECON when the #2 has no earned class", () => {
    // #1 commanding, #2 a bare figure horse (class below the field median so it
    // has NO earned class), #3 carries the class that lifts the median past #2.
    const leader = horse("1", 100, { eeac: 100, eeap: 95, eeapFit: 99 });
    const second = horse("2", 92, { eeac: 50, eeap: 50, eeapFit: 50 });
    const third = horse("3", 70, { eeac: 80, eeap: 60, eeapFit: 60 });
    const f = race([leader, second, third], "honest pace");
    const { tiers, raceFlags } = assignTierV2(f, 2000, W);
    const t2 = tiers.find((t) => t.pgm === "2")!;
    expect(t2.tier).not.toBe("DUAL");
    expect(raceFlags.some((x) => x.includes("A1_DUAL_DOWNGRADE"))).toBe(true);
  });
});

describe("A2 — rating-gap penalty on thin top picks", () => {
  it("demotes one tier on a 20-pt gap with no earned class; not when class is earned", () => {
    const leader = horse("1", 120);
    const second = horse("2", 95); // 25-pt gap
    const thin = { ...emptyFactors(), earnedClassAtLevel: false };
    const earned = { ...emptyFactors(), earnedClassAtLevel: true };

    expect(ratingGapPenalty("SNIPER", leader, second, thin)).toEqual({ tier: "EDGE", applied: true });
    expect(ratingGapPenalty("SNIPER", leader, second, earned)).toEqual({ tier: "SNIPER", applied: false });
  });

  it("wired live: a SNIPER-sized gap with a thin top demotes SNIPER→EDGE", () => {
    // 25-pt gap, leader has the field-low class (no earned class), no support.
    const leader = horse("1", 120, { eeac: 40, eeap: 40, eeapFit: 40 });
    const second = horse("2", 95, { eeac: 90 });
    const third = horse("3", 80, { eeac: 88 });
    const f = race([leader, second, third]);
    const { tiers, raceFlags } = assignTierV2(f, 2000, W);
    const t1 = tiers.find((t) => t.pgm === "1")!;
    expect(t1.tier).not.toBe("SNIPER");
    expect(raceFlags.some((x) => x.includes("RATING_GAP_PENALTY"))).toBe(true);
  });
});

describe("A3 — PASS-tier compression", () => {
  it("promotes the best non-rating horse from a tight PASS cluster to RECON", () => {
    // Three horses within 4 points; the middle one carries bloodstock.
    const a = horse("7", 60);
    const b = horse("8", 58, {
      bloodstockAdjustment: { applied: true, composite: 72, reasonCodes: ["sire-dirt(CURLIN)", "sire-route"], confidence: "high", ratingDelta: 2 },
    });
    const c = horse("9", 57);
    const factors = new Map<string, FusionFactors>([
      ["7", emptyFactors()],
      ["8", { ...emptyFactors(), bloodstockSurfaceYes: true, bloodstockDistanceYes: true, surfaceFitGrade: "A", distanceFitGrade: "A", paceFit: 60 }],
      ["9", emptyFactors()],
    ]);
    const promo = passCompressionPromotion([a, b, c], factors);
    expect(promo).not.toBeNull();
    expect(promo!.pgm).toBe("8");
  });

  it("wired live: a buried-but-live PASS horse is promoted PASS→RECON", () => {
    const leader = horse("1", 100, { eeac: 100, flags: ["projected-lone-speed"], eeap: 95, eeapFit: 99 });
    const second = horse("2", 96, { eeac: 95 });
    const third = horse("3", 80, { eeac: 80 });
    // PASS cluster: 4,5,6 within 4 pts; #5 carries bloodstock chips.
    const p4 = horse("4", 62, { eeac: 60 });
    const p5 = horse("5", 60, {
      eeac: 70,
      bloodstockAdjustment: { applied: true, composite: 74, reasonCodes: ["sire-dirt(TAPIT)", "sire-route"], confidence: "high", ratingDelta: 2 },
    });
    const p6 = horse("6", 59, { eeac: 58 });
    const f = race([leader, second, third, p4, p5, p6]);
    const { tiers, raceFlags } = assignTierV2(f, 2000, W);
    expect(raceFlags.some((x) => x.includes("PASS_COMPRESSION_PROMOTION"))).toBe(true);
    const promoted = tiers.find((t) => raceFlags.join(" ").includes(`on #${t.pgm}`) && t.tier === "RECON");
    expect(tiers.filter((t) => t.tier === "RECON").length).toBeGreaterThanOrEqual(1);
  });
});

describe("A4 — top-pick honesty check", () => {
  it("fires HONESTY_CHECK + demotes when #2 is stronger on 2+ dimensions", () => {
    const top: FusionFactors = { ...emptyFactors(), paceFit: 50, surfaceFitGrade: "C", distanceFitGrade: "C" };
    const second: FusionFactors = { ...emptyFactors(), paceFit: 80, surfaceFitGrade: "A", distanceFitGrade: "A" };
    const hc = runHonestyCheck(race([]), "SNIPER", top, second);
    expect(hc.flag).toBe(true);
    expect(hc.demotedTier).toBe("EDGE");
    expect(hc.reasons.length).toBeGreaterThanOrEqual(2);

    // Only one dimension stronger → no flag.
    const second1: FusionFactors = { ...emptyFactors(), paceFit: 80, surfaceFitGrade: "C", distanceFitGrade: "C" };
    expect(runHonestyCheck(race([]), "SNIPER", top, second1).flag).toBe(false);
  });

  it("wired live: honesty check demotes the leader's tier and logs the flag", () => {
    // Leader top-rated but factor-poor; #2 close in rating, factor-rich.
    const leader = horse("1", 100, { eeac: 100, eeap: 50, eeapFit: 50 });
    const second = horse("2", 98, {
      eeac: 98,
      eeap: 95,
      eeapFit: 95,
      bloodstockAdjustment: { applied: true, composite: 75, reasonCodes: ["sire-dirt(CURLIN)", "sire-route"], confidence: "high", ratingDelta: 2 },
    });
    const third = horse("3", 80, { eeac: 80 });
    const f = race([leader, second, third]);
    const { raceFlags } = assignTierV2(f, 2000, W);
    expect(raceFlags.some((x) => x.includes("HONESTY_CHECK"))).toBe(true);
  });
});

describe("A5 — soft-tier minimum content", () => {
  it("flags a RECON/PASS horse with no structured factor; not one with a factor", () => {
    expect(softTierLazyBucket("4", "RECON", emptyFactors())).toMatch(/SOFT_TIER_LAZY_BUCKET on #4/);
    expect(softTierLazyBucket("4", "PASS", emptyFactors())).toMatch(/SOFT_TIER_LAZY_BUCKET/);
    // A non-soft tier is never flagged.
    expect(softTierLazyBucket("1", "SNIPER", emptyFactors())).toBeNull();
    // A soft tier WITH a factor is not lazy.
    expect(softTierLazyBucket("4", "RECON", strongFactors())).toBeNull();
  });

  it("wired live: a factorless RECON horse surfaces SOFT_TIER_LAZY_BUCKET", () => {
    // #3 lands RECON by rank with no flags/bloodstock/class signal at all.
    const leader = horse("1", 100, { eeac: 100, flags: ["projected-lone-speed"] });
    // Give #2 a trip flag so it stays DUAL and doesn't steal the RECON slot focus.
    const second = horse("2", 96, { eeac: 95, flags: ["projected-lone-speed"] });
    // #3 must have GENUINELY null figures (the horse() builder coalesces null →
    // rating, which would manufacture a class trend). Build it by hand so every
    // structured factor stays empty and A5 can flag the lazy bucket.
    const third: FusedHorse = {
      pgm: "3",
      name: "H3",
      isMaiden: false,
      eeas: null,
      eeap: null,
      eeapFit: null,
      eeac: null,
      eeaRating: 50,
      mlOdds: null,
      rank: 0,
      flags: [],
      bloodstockAdjustment: {
        applied: false,
        composite: 50,
        reasonCodes: [],
        confidence: "none",
        ratingDelta: 0,
      },
    };
    const f = race([leader, second, third]);
    const { tiers, raceFlags } = assignTierV2(f, 2000, W);
    expect(tiers.find((t) => t.pgm === "3")!.tier).toBe("RECON");
    expect(raceFlags.some((x) => x.includes("SOFT_TIER_LAZY_BUCKET"))).toBe(true);
  });
});

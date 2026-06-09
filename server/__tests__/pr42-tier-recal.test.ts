// PR #42 — tier recalibration, Maiden-Claim EX-only gate, ml_favorite_matched
// (+5 conviction), and speed_figure_gap demotion.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIER_WEIGHTS,
  isMaidenClaiming,
  shouldGateMaidenClaim,
  buildBudgetedBets,
  configFromSettings,
  type BudgetedRace,
} from "../services/budgeted-bets";
import {
  assignTiersV3,
  type RunnerScore,
} from "../services/fusion-v3";
import type { RunnerFeatures } from "../services/features";

// ── Item 1: tier weight recalibration ───────────────────────────────────────
describe("PR #42 tier weights", () => {
  it("recalibrates EDGE up to 25 and DUAL down to 6", () => {
    expect(DEFAULT_TIER_WEIGHTS.SNIPER).toBe(30);
    expect(DEFAULT_TIER_WEIGHTS.EDGE).toBe(25);
    expect(DEFAULT_TIER_WEIGHTS.DUAL).toBe(6);
    expect(DEFAULT_TIER_WEIGHTS.RECON).toBe(4);
    expect(DEFAULT_TIER_WEIGHTS.PASS).toBe(0);
  });

  it("now funds EDGE strictly above DUAL (the inversion this PR fixes)", () => {
    expect(DEFAULT_TIER_WEIGHTS.EDGE).toBeGreaterThan(DEFAULT_TIER_WEIGHTS.DUAL);
  });

  it("preserves the descending weight ordering SNIPER>EDGE>DUAL>RECON>PASS", () => {
    const w = DEFAULT_TIER_WEIGHTS;
    expect(w.SNIPER).toBeGreaterThan(w.EDGE);
    expect(w.EDGE).toBeGreaterThan(w.DUAL);
    expect(w.DUAL).toBeGreaterThan(w.RECON);
    expect(w.RECON).toBeGreaterThan(w.PASS);
  });

  it("configFromSettings falls back to the recalibrated defaults on bad JSON", () => {
    const cfg = configFromSettings({
      dailyRiskBudget: 1000,
      chaosDemotionMode: "floor-recon",
      tierWeightsJson: "not-json",
      legPatternsJson: "not-json",
    });
    expect(cfg.tierWeights.EDGE).toBe(25);
    expect(cfg.tierWeights.DUAL).toBe(6);
  });
});

// ── Item 5: Maiden Claim 9+ EX-only gate ─────────────────────────────────────
describe("PR #42 Maiden Claim field-size gate", () => {
  it("detects Maiden Claiming from conditions text", () => {
    expect(isMaidenClaiming("Maiden Claiming $25,000")).toBe(true);
    expect(isMaidenClaiming("Mdn Clm 16000")).toBe(true);
    expect(isMaidenClaiming("Allowance Optional Claiming")).toBe(false);
    expect(isMaidenClaiming("Maiden Special Weight")).toBe(false);
    expect(isMaidenClaiming(null)).toBe(false);
  });

  it("gates only when Maiden Claiming AND field >= 9", () => {
    expect(shouldGateMaidenClaim("Maiden Claiming $25,000", 9)).toBe(true);
    expect(shouldGateMaidenClaim("Maiden Claiming $25,000", 12)).toBe(true);
    expect(shouldGateMaidenClaim("Maiden Claiming $25,000", 8)).toBe(false);
    expect(shouldGateMaidenClaim("Allowance", 12)).toBe(false);
    expect(shouldGateMaidenClaim("Maiden Claiming $25,000", null)).toBe(false);
  });

  it("buildBudgetedBets forces EX-only legs (100% exacta) with the gate tag", () => {
    const races: BudgetedRace[] = [
      {
        id: 1,
        tier: "SNIPER",
        flags: "[]",
        winPgm: "3",
        placePgm: "5",
        showPgm: "1",
        fourthPgm: "7",
        conditions: "Maiden Claiming $16,000",
        fieldSize: 10,
      },
    ];
    const bets = buildBudgetedBets(races, {
      dailyBudget: 1000,
      tierWeights: { ...DEFAULT_TIER_WEIGHTS },
      legPatterns: configFromSettings({
        dailyRiskBudget: 1000,
        chaosDemotionMode: "floor-recon",
        tierWeightsJson: "{}",
        legPatternsJson: "{}",
      }).legPatterns,
      chaosDemotionMode: "floor-recon",
    });
    const race = bets.get(1)!;
    expect(race.gates).toContain("field_size_maiden_claim_9plus");
    // Every produced leg is an EXACTA — no WIN/PLACE/SHOW/TRI/SUPER dollars.
    expect(race.legs.length).toBeGreaterThan(0);
    for (const leg of race.legs) {
      expect(leg.type).toBe("EXACTA");
      expect(leg.gates).toContain("field_size_maiden_claim_9plus");
    }
  });

  it("does NOT gate a Maiden Claiming race under the field threshold", () => {
    const races: BudgetedRace[] = [
      {
        id: 2,
        tier: "EDGE",
        flags: "[]",
        winPgm: "2",
        placePgm: "4",
        showPgm: "6",
        fourthPgm: "8",
        conditions: "Maiden Claiming $16,000",
        fieldSize: 7,
      },
    ];
    const bets = buildBudgetedBets(races, {
      dailyBudget: 1000,
      tierWeights: { ...DEFAULT_TIER_WEIGHTS },
      legPatterns: configFromSettings({
        dailyRiskBudget: 1000,
        chaosDemotionMode: "floor-recon",
        tierWeightsJson: "{}",
        legPatternsJson: "{}",
      }).legPatterns,
      chaosDemotionMode: "floor-recon",
    });
    const race = bets.get(2)!;
    expect(race.gates).toBeUndefined();
    expect(race.legs.some((l) => l.type === "WIN")).toBe(true);
  });
});

// ── Items 3 & 4: conviction modifiers in fusion-v3 ──────────────────────────
function feat(overrides: Partial<RunnerFeatures> = {}): RunnerFeatures {
  return {
    pace_fit_score: 60,
    class_earned_score: 60,
    trip_compromised_score: 50,
    bias_match_score: 50,
    jt_hot_score: 50,
    trainer_angle_score: 50,
    work_sharp_score: 50,
    form_curve_score: 50,
    dist_surf_form_score: 50,
    conditions_pedigree_score: 50,
    layoff_score: 50,
    honesty_check: false,
    ...overrides,
  };
}

function runner(
  pgm: string,
  composite: number,
  rank: number,
  extra: Partial<RunnerScore> = {},
): RunnerScore {
  return {
    pgm,
    horseName: `Horse ${pgm}`,
    features: feat(),
    composite,
    rank,
    mlOdds: null,
    speedFig: null,
    ...extra,
  };
}

describe("PR #42 ml_favorite_matched (+5 conviction)", () => {
  it("bumps the top pick when it is the morning-line favorite", () => {
    // #1 is both our top (composite 85 → SNIPER) and the ML favorite (2.0).
    const scored: RunnerScore[] = [
      runner("1", 85, 1, { mlOdds: 2.0, speedFig: 90 }),
      runner("2", 55, 2, { mlOdds: 5.0, speedFig: 88 }),
      runner("3", 40, 3, { mlOdds: 8.0, speedFig: 80 }),
    ];
    const { tiers, raceFlags } = assignTiersV3(scored);
    const top = tiers.find((t) => t.pgm === "1")!;
    expect(top.mlFavoriteMatched).toBe(true);
    expect(top.modifiers?.some((m) => m.reason === "ml_favorite_matched" && m.delta === 5)).toBe(true);
    // conviction = composite + 5 (clamped 0-100)
    expect(top.conviction).toBe(90);
    expect(raceFlags.some((f) => f.includes("ML_FAVORITE_MATCHED"))).toBe(true);
  });

  it("does not bump when our top pick is NOT the ML favorite", () => {
    const scored: RunnerScore[] = [
      runner("1", 85, 1, { mlOdds: 6.0, speedFig: 90 }),
      runner("2", 55, 2, { mlOdds: 2.0, speedFig: 88 }), // ML fav is #2
      runner("3", 40, 3, { mlOdds: 8.0, speedFig: 80 }),
    ];
    const { tiers } = assignTiersV3(scored);
    const top = tiers.find((t) => t.pgm === "1")!;
    expect(top.mlFavoriteMatched).toBeUndefined();
    expect(top.modifiers?.some((m) => m.reason === "ml_favorite_matched")).toBeFalsy();
  });
});

describe("PR #42 speed_figure_gap demotion", () => {
  it("demotes a SNIPER/EDGE top pick to RECON when it gives up >5 speed pts", () => {
    // #1 is our top (composite 85 → SNIPER) but slowest on speed; field top is 95.
    const scored: RunnerScore[] = [
      runner("1", 85, 1, { mlOdds: 3.0, speedFig: 80 }), // gap = 95-80 = 15 > 5
      runner("2", 55, 2, { mlOdds: 4.0, speedFig: 95 }),
      runner("3", 40, 3, { mlOdds: 9.0, speedFig: 70 }),
    ];
    const { tiers, raceFlags } = assignTiersV3(scored);
    const top = tiers.find((t) => t.pgm === "1")!;
    expect(top.tier).toBe("RECON");
    expect(top.demotions?.some((d) => d.reason === "speed_gap" && d.to === "RECON")).toBe(true);
    expect(raceFlags.some((f) => f.includes("SPEED_GAP_DEMOTION"))).toBe(true);
  });

  it("does NOT demote when the speed gap is within 5 points", () => {
    const scored: RunnerScore[] = [
      runner("1", 85, 1, { mlOdds: 3.0, speedFig: 92 }), // gap = 95-92 = 3 <= 5
      runner("2", 55, 2, { mlOdds: 4.0, speedFig: 95 }),
      runner("3", 40, 3, { mlOdds: 9.0, speedFig: 70 }),
    ];
    const { tiers } = assignTiersV3(scored);
    const top = tiers.find((t) => t.pgm === "1")!;
    expect(top.tier).toBe("SNIPER");
    expect(top.demotions).toBeUndefined();
  });
});

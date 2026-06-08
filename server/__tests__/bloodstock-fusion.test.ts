import { describe, it, expect } from "vitest";
import { fuseRace, type WeatherInput } from "../services/eea-fusion";
import { DEFAULT_WEIGHTS } from "../services/eea-config";
import type { BrisnetRace, RaceConditions } from "../services/parsers/types";

const W = DEFAULT_WEIGHTS;
const DIRT_ROUTE: RaceConditions = { type: "ALW", raw: "Allowance", purse: 80000, distance: "1 1/16M", surface: "DIRT" };

const DRY: WeatherInput = { surfaceImpact: "dry" };
const SLOPPY: WeatherInput = { surfaceImpact: "sloppy" };

function horse(
  pgm: string,
  name: string,
  opts: Partial<{
    speedLast: number;
    classRating: number;
    sire: string;
    damSire: string;
    lifetimeStarts: number;
    wetWinPct: number;
  }> = {},
): BrisnetRace["horses"][number] {
  return {
    pgm,
    name,
    speedLast: opts.speedLast ?? 80,
    classRating: opts.classRating ?? 100,
    wetWinPct: opts.wetWinPct ?? null,
    lifetimeStarts: opts.lifetimeStarts ?? 20,
    sire: opts.sire ? { name: opts.sire } : null,
    damSire: opts.damSire ? { name: opts.damSire } : null,
    pace: { e1Last: 70, e2Last: 70, lpLast: 70 },
  };
}

function bris(horses: BrisnetRace["horses"]): BrisnetRace {
  return { raceNumber: 1, conditions: DIRT_ROUTE, horses };
}

function ratingOf(race: ReturnType<typeof fuseRace>, pgm: string): number {
  return race.horses.find((x) => x.pgm === pgm)?.eeaRating ?? 0;
}
function adjOf(race: ReturnType<typeof fuseRace>, pgm: string) {
  return race.horses.find((x) => x.pgm === pgm)!.bloodstockAdjustment;
}

describe("bloodstock factor — never applied without recognizable pedigree", () => {
  it("an unknown sire leaves the adjustment unapplied and the rating unmoved", () => {
    const r = bris([horse("1", "NoPed", { sire: "Made Up Sire" })]);
    const out = fuseRace(r, undefined, W);
    const a = adjOf(out, "1");
    expect(a.applied).toBe(false);
    expect(a.confidence).toBe("none");
    expect(a.ratingDelta).toBe(0);
  });
});

describe("bloodstock factor — applies a capped bias for recognized pedigree", () => {
  it("a dirt/route sire nudges its rating up and stays within the normal cap", () => {
    const r = bris([
      horse("1", "Classy", { sire: "Curlin", damSire: "Tapit" }),
      horse("2", "Plain", { sire: "Made Up Sire" }),
    ]);
    const out = fuseRace(r, undefined, W);
    const a = adjOf(out, "1");
    expect(a.applied).toBe(true);
    expect(a.confidence).toBe("high");
    // Normal-mode bias is capped at ±maxBiasPoints * wetBoostMultiplier off-track,
    // but on a dry track the hard normal cap is ±maxBiasPoints.
    expect(Math.abs(a.ratingDelta)).toBeLessThanOrEqual(W.bloodstock.maxBiasPoints + 0.05);
  });
});

describe("bloodstock factor — dry vs sloppy interaction with weather", () => {
  it("amplifies a strong wet pedigree on a sloppy track relative to dry", () => {
    const r = bris([horse("1", "WetSire", { sire: "Tapit", damSire: "Curlin" })]);
    const dry = fuseRace(r, undefined, W, undefined, DRY);
    const sloppy = fuseRace(r, undefined, W, undefined, SLOPPY);
    const dDry = adjOf(dry, "1").ratingDelta;
    const dSloppy = adjOf(sloppy, "1").ratingDelta;
    // Both push up; the sloppy track should push harder (wet boost multiplier).
    expect(dDry).toBeGreaterThan(0);
    expect(dSloppy).toBeGreaterThan(dDry);
    expect(adjOf(sloppy, "1").reasonCodes).toContain("wet-pedigree-strong");
  });
});

describe("bloodstock factor — first-timer leans harder on pedigree", () => {
  it("a first-timer with a strong pedigree gets a larger swing than a seasoned horse", () => {
    const firstTimer = bris([horse("1", "Baby", { sire: "Curlin", damSire: "Tapit", lifetimeStarts: 0 })]);
    const seasoned = bris([horse("1", "Vet", { sire: "Curlin", damSire: "Tapit", lifetimeStarts: 25 })]);
    const ftOut = fuseRace(firstTimer, undefined, W);
    const vetOut = fuseRace(seasoned, undefined, W);
    expect(Math.abs(adjOf(ftOut, "1").ratingDelta)).toBeGreaterThan(
      Math.abs(adjOf(vetOut, "1").ratingDelta),
    );
    expect(ftOut.horses[0].flags).toContain("first-timer-pedigree-lean");
  });
});

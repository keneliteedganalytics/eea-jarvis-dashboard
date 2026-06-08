import { describe, it, expect } from "vitest";
import { fuseRace, type WeatherInput } from "../services/eea-fusion";
import { DEFAULT_WEIGHTS } from "../services/eea-config";
import type { BrisnetRace, EquibaseRace, RaceConditions } from "../services/parsers/types";

const W = DEFAULT_WEIGHTS;
const DIRT: RaceConditions = { type: "ALW", raw: "Allowance", purse: 60000, distance: "6F", surface: "DIRT" };
const TURF: RaceConditions = { type: "ALW", raw: "Allowance Turf", purse: 60000, distance: "1M", surface: "TURF" };

function bris(conds: RaceConditions, horses: BrisnetRace["horses"]): BrisnetRace {
  return { raceNumber: 1, conditions: conds, horses };
}

function horse(
  pgm: string,
  name: string,
  opts: Partial<{ speedLast: number; classRating: number; e1: number; e2: number; lp: number; wetWinPct: number }> = {},
): BrisnetRace["horses"][number] {
  return {
    pgm,
    name,
    speedLast: opts.speedLast ?? 80,
    classRating: opts.classRating ?? 100,
    wetWinPct: opts.wetWinPct ?? null,
    pace: { e1Last: opts.e1 ?? null, e2Last: opts.e2 ?? null, lpLast: opts.lp ?? null },
  };
}

const DRY: WeatherInput = { surfaceImpact: "dry" };
const SLOPPY: WeatherInput = { surfaceImpact: "sloppy" };
const UNKNOWN: WeatherInput = { surfaceImpact: "unknown" };

function ratingOf(race: ReturnType<typeof fuseRace>, pgm: string): number {
  const h = race.horses.find((x) => x.pgm === pgm);
  return h?.eeaRating ?? 0;
}

describe("weather factor — never applied unless off-track with real data", () => {
  const r = bris(DIRT, [horse("1", "Alpha", { wetWinPct: 40 }), horse("2", "Bravo")]);

  it("dry surface leaves weatherAdjustment unapplied and ratings unchanged vs no-weather", () => {
    const base = fuseRace(r, undefined, W);
    const dry = fuseRace(r, undefined, W, undefined, DRY);
    expect(dry.weatherAdjustment.applied).toBe(false);
    expect(ratingOf(dry, "1")).toBeCloseTo(ratingOf(base, "1"), 5);
  });

  it("unknown surface never applies — pick is left untouched", () => {
    const base = fuseRace(r, undefined, W);
    const unk = fuseRace(r, undefined, W, undefined, UNKNOWN);
    expect(unk.weatherAdjustment.applied).toBe(false);
    expect(ratingOf(unk, "1")).toBeCloseTo(ratingOf(base, "1"), 5);
  });
});

describe("weather factor — dry → sloppy shifts ratings in the expected direction", () => {
  it("boosts a proven mudder's rating when the dirt turns sloppy", () => {
    const r = bris(DIRT, [
      horse("1", "Mudder", { speedLast: 80, wetWinPct: 60 }),
      horse("2", "FastDry", { speedLast: 80, wetWinPct: 0 }),
    ]);
    const dry = fuseRace(r, undefined, W, undefined, DRY);
    const sloppy = fuseRace(r, undefined, W, undefined, SLOPPY);

    expect(sloppy.weatherAdjustment.applied).toBe(true);
    expect(sloppy.weatherAdjustment.surface).toBe("sloppy");
    expect(sloppy.weatherAdjustment.reasonCodes).toContain("mudder-boost");
    // The mudder's rating must rise relative to dry.
    expect(ratingOf(sloppy, "1")).toBeGreaterThan(ratingOf(dry, "1"));
  });

  it("lightly favors closers over early speed on sloppy dirt", () => {
    // #1 projects as the lone early type (high pace figs); #2 is a closer.
    const r = bris(DIRT, [
      horse("1", "Speed", { e1: 95, e2: 95, lp: 70 }),
      horse("2", "Closer", { e1: 60, e2: 62, lp: 90 }),
    ]);
    const dry = fuseRace(r, undefined, W, undefined, DRY);
    const sloppy = fuseRace(r, undefined, W, undefined, SLOPPY);

    expect(sloppy.weatherAdjustment.reasonCodes).toContain("closer-favored-off-track");
    expect(sloppy.weatherAdjustment.reasonCodes).toContain("speed-trimmed-off-track");
    // Closer gains, speed loses, relative to dry.
    expect(ratingOf(sloppy, "2") - ratingOf(dry, "2")).toBeGreaterThan(0);
    expect(ratingOf(sloppy, "1") - ratingOf(dry, "1")).toBeLessThan(0);
  });

  it("de-emphasizes turf speed when the turf is rained on", () => {
    const r = bris(TURF, [horse("1", "TurfSpeed", { speedLast: 95, wetWinPct: 0 })]);
    const dry = fuseRace(r, undefined, W, undefined, DRY);
    const sloppy = fuseRace(r, undefined, W, undefined, SLOPPY);
    expect(sloppy.weatherAdjustment.reasonCodes).toContain("turf-speed-deemphasized");
    expect(ratingOf(sloppy, "1")).toBeLessThan(ratingOf(dry, "1"));
  });
});

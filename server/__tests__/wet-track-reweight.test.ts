import { describe, it, expect } from "vitest";
import { fuseRace, distanceToFurlongs, type WeatherInput } from "../services/eea-fusion";
import { DEFAULT_WEIGHTS } from "../services/eea-config";
import type { BrisnetRace, RaceConditions } from "../services/parsers/types";

const W = DEFAULT_WEIGHTS;
const SPRINT_DIRT: RaceConditions = { type: "ALW", raw: "Allowance", purse: 60000, distance: "6F", surface: "DIRT" };
const ROUTE_DIRT: RaceConditions = { type: "ALW", raw: "Allowance", purse: 60000, distance: "1 1/16M", surface: "DIRT" };
const ROUTE_TURF: RaceConditions = { type: "ALW", raw: "Allowance Turf", purse: 60000, distance: "1 1/16M", surface: "TURF" };

function bris(conds: RaceConditions, horses: BrisnetRace["horses"]): BrisnetRace {
  return { raceNumber: 1, conditions: conds, horses };
}

function horse(
  pgm: string,
  name: string,
  opts: Partial<{ speedLast: number; classRating: number; e1: number; e2: number; lp: number }> = {},
): BrisnetRace["horses"][number] {
  return {
    pgm,
    name,
    speedLast: opts.speedLast ?? 80,
    classRating: opts.classRating ?? 100,
    wetWinPct: null,
    pace: { e1Last: opts.e1 ?? null, e2Last: opts.e2 ?? null, lpLast: opts.lp ?? null },
  };
}

// trackCondition is the gate for the §3 re-weighting (not surfaceImpact).
const FAST: WeatherInput = { surfaceImpact: "dry", trackCondition: "fast" };
const SLOPPY_COND: WeatherInput = { surfaceImpact: "sloppy", trackCondition: "sloppy" };

function ratingOf(race: ReturnType<typeof fuseRace>, pgm: string): number {
  return race.horses.find((x) => x.pgm === pgm)?.eeaRating ?? 0;
}
function flagsOf(race: ReturnType<typeof fuseRace>, pgm: string): string[] {
  return race.horses.find((x) => x.pgm === pgm)?.flags ?? [];
}

describe("distanceToFurlongs", () => {
  it("parses furlongs and miles", () => {
    expect(distanceToFurlongs("6F")).toBe(6);
    expect(distanceToFurlongs("6 1/2F")).toBe(6.5);
    expect(distanceToFurlongs("1M")).toBe(8);
    expect(distanceToFurlongs("1 1/16M")).toBeCloseTo(8.5, 5);
    expect(distanceToFurlongs(null)).toBeNull();
  });
});

describe("wet-track §3 re-weighting — gated on trackCondition, dirt only", () => {
  // #1 lone early speed; #2 mid; #3 mid; #4 deep closer (bottom-quartile pace).
  const field = (): BrisnetRace["horses"] => [
    horse("1", "Frontrunner", { e1: 98, e2: 96, lp: 70 }),
    horse("2", "MidA", { e1: 80, e2: 80, lp: 80 }),
    horse("3", "MidB", { e1: 78, e2: 78, lp: 82 }),
    horse("4", "Closer", { e1: 50, e2: 52, lp: 92 }),
  ];

  it("fast vs sloppy yields different scores (re-weighting only fires on wet dirt)", () => {
    const fast = fuseRace(bris(SPRINT_DIRT, field()), undefined, W, undefined, FAST);
    const sloppy = fuseRace(bris(SPRINT_DIRT, field()), undefined, W, undefined, SLOPPY_COND);
    // The front-runner's rating must change between fast and sloppy.
    expect(ratingOf(sloppy, "1")).not.toBeCloseTo(ratingOf(fast, "1"), 3);
  });

  it("boosts the projected lone-speed front-runner on sloppy dirt", () => {
    const fast = fuseRace(bris(SPRINT_DIRT, field()), undefined, W, undefined, FAST);
    const sloppy = fuseRace(bris(SPRINT_DIRT, field()), undefined, W, undefined, SLOPPY_COND);
    expect(flagsOf(sloppy, "1")).toContain("wet-front-runner-boost");
    expect(ratingOf(sloppy, "1")).toBeGreaterThan(ratingOf(fast, "1"));
    expect(sloppy.weatherAdjustment.reasonCodes).toContain("front-runner-favored-wet-dirt");
  });

  it("fades a deep closer (bottom-quartile pace, no early involvement) on sloppy dirt", () => {
    const fast = fuseRace(bris(SPRINT_DIRT, field()), undefined, W, undefined, FAST);
    const sloppy = fuseRace(bris(SPRINT_DIRT, field()), undefined, W, undefined, SLOPPY_COND);
    expect(flagsOf(sloppy, "4")).toContain("wet-closer-fade");
    expect(ratingOf(sloppy, "4")).toBeLessThan(ratingOf(fast, "4"));
    expect(sloppy.weatherAdjustment.reasonCodes).toContain("deep-closer-faded-wet-dirt");
  });

  it("gives inside posts (1-4) a bonus on routes (>=6.5f) but not sprints", () => {
    const route = fuseRace(bris(ROUTE_DIRT, field()), undefined, W, undefined, SLOPPY_COND);
    const sprint = fuseRace(bris(SPRINT_DIRT, field()), undefined, W, undefined, SLOPPY_COND);
    expect(flagsOf(route, "2")).toContain("wet-inside-post-boost");
    expect(route.weatherAdjustment.reasonCodes).toContain("inside-post-favored-wet-dirt");
    expect(flagsOf(sprint, "2")).not.toContain("wet-inside-post-boost");
  });

  it("does NOT re-weight on turf even when the track condition is sloppy", () => {
    const turf = fuseRace(bris(ROUTE_TURF, field()), undefined, W, undefined, SLOPPY_COND);
    expect(flagsOf(turf, "1")).not.toContain("wet-front-runner-boost");
    expect(flagsOf(turf, "4")).not.toContain("wet-closer-fade");
    expect(turf.weatherAdjustment.reasonCodes).not.toContain("front-runner-favored-wet-dirt");
  });

  it("does NOT re-weight when the track condition is fast", () => {
    const fast = fuseRace(bris(ROUTE_DIRT, field()), undefined, W, undefined, FAST);
    expect(flagsOf(fast, "1")).not.toContain("wet-front-runner-boost");
    expect(flagsOf(fast, "4")).not.toContain("wet-closer-fade");
    expect(flagsOf(fast, "2")).not.toContain("wet-inside-post-boost");
  });
});

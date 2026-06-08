import { describe, it, expect } from "vitest";
import {
  computeBloodstockFitness,
  shrinkAptitude,
  distanceBucket,
} from "../bloodstock";
import { DEFAULT_WEIGHTS } from "../services/eea-config";
import type { RaceConditions } from "../services/parsers/types";

const BW = DEFAULT_WEIGHTS.bloodstock;

const TURF_ROUTE: RaceConditions = { type: "ALW", raw: "Allowance Turf", purse: 60000, distance: "1M", surface: "TURF" };
const DIRT_SPRINT: RaceConditions = { type: "ALW", raw: "Allowance", purse: 60000, distance: "6F", surface: "DIRT" };
const DIRT_ROUTE: RaceConditions = { type: "ALW", raw: "Allowance", purse: 80000, distance: "1 1/16M", surface: "DIRT" };

describe("distanceBucket", () => {
  it("classifies furlong sprints and mile routes", () => {
    expect(distanceBucket({ type: "", raw: "", distance: "6F" })).toBe("sprint");
    expect(distanceBucket({ type: "", raw: "", distance: "1M" })).toBe("route");
    expect(distanceBucket({ type: "", raw: "", distance: "8F" })).toBe("route");
    expect(distanceBucket({ type: "", raw: "", distance: "1 1/16M" })).toBe("route");
  });
  it("returns unknown when no distance is parseable", () => {
    expect(distanceBucket({ type: "", raw: "", distance: "" })).toBe("unknown");
    expect(distanceBucket({ type: "", raw: "" })).toBe("unknown");
  });
});

describe("shrinkAptitude — pulls small samples toward neutral 50", () => {
  it("a large-n strong figure stays near its value", () => {
    // 82 turf on n=300 with k=20 → barely moved.
    const v = shrinkAptitude(82, 300, 20);
    expect(v).toBeGreaterThan(78);
  });
  it("a small-n strong figure is dragged toward 50", () => {
    // Same 82 figure on only n=3 → pulled well below the raw value.
    const small = shrinkAptitude(82, 3, 20);
    const large = shrinkAptitude(82, 300, 20);
    expect(small).toBeLessThan(large);
    expect(small).toBeLessThan(62); // closer to 50 than to 82
  });
  it("zero sample is fully neutral", () => {
    expect(shrinkAptitude(90, 0, 20)).toBe(50);
  });
});

describe("computeBloodstockFitness — surface specialists", () => {
  it("a turf-specialist sire scores high surfaceFit on turf", () => {
    const f = computeBloodstockFitness(
      { sireName: "Kitten's Joy", lifetimeStarts: 10 },
      { conditions: TURF_ROUTE, surfaceWet: false },
      BW,
    );
    expect(f.confidence).not.toBe("none");
    expect(f.surfaceFit).toBeGreaterThan(60);
    expect(f.reasonCodes).toContain("sire-turf(Kitten's Joy)");
  });

  it("a dirt/mud sire scores high surfaceFit on dirt and high wetFit", () => {
    const f = computeBloodstockFitness(
      { sireName: "Tapit", lifetimeStarts: 10 },
      { conditions: DIRT_ROUTE, surfaceWet: true },
      BW,
    );
    expect(f.surfaceFit).toBeGreaterThan(60);
    expect(f.wetFit).toBeGreaterThan(60);
    expect(f.reasonCodes).toContain("wet-pedigree-strong");
  });

  it("a sprint-specialist sire scores high distanceFit in a sprint", () => {
    const f = computeBloodstockFitness(
      { sireName: "Speightstown", lifetimeStarts: 10 },
      { conditions: DIRT_SPRINT, surfaceWet: false },
      BW,
    );
    expect(f.distanceFit).toBeGreaterThan(60);
    expect(f.reasonCodes).toContain("sire-sprint");
  });
});

describe("computeBloodstockFitness — no data never biases", () => {
  it("returns confidence none + neutral composite for an unknown sire", () => {
    const f = computeBloodstockFitness(
      { sireName: "Totally Made Up Sire", damSireName: null },
      { conditions: DIRT_SPRINT },
      BW,
    );
    expect(f.confidence).toBe("none");
    expect(f.composite).toBe(50);
    expect(f.reasonCodes).toContain("no-pedigree-data");
  });

  it("returns confidence none when names are missing entirely", () => {
    const f = computeBloodstockFitness({}, { conditions: DIRT_SPRINT }, BW);
    expect(f.confidence).toBe("none");
  });
});

describe("computeBloodstockFitness — first-timer pedigree lean", () => {
  it("awards a first-timer bonus for a lightly-raced horse with a strong surface lean", () => {
    const ft = computeBloodstockFitness(
      { sireName: "Kitten's Joy", lifetimeStarts: 0 },
      { conditions: TURF_ROUTE },
      BW,
    );
    const seasoned = computeBloodstockFitness(
      { sireName: "Kitten's Joy", lifetimeStarts: 25 },
      { conditions: TURF_ROUTE },
      BW,
    );
    expect(ft.firstTimerBonus).toBeGreaterThan(0);
    expect(seasoned.firstTimerBonus).toBe(0);
    expect(ft.reasonCodes).toContain("first-timer-pedigree-lean");
  });
});

describe("computeBloodstockFitness — confidence bands", () => {
  it("known sire + known dam-sire = high", () => {
    const f = computeBloodstockFitness(
      { sireName: "Curlin", damSireName: "Tapit" },
      { conditions: DIRT_ROUTE },
      BW,
    );
    expect(f.confidence).toBe("high");
  });
  it("known sire only = medium", () => {
    const f = computeBloodstockFitness(
      { sireName: "Curlin", damSireName: "Unknown Horse" },
      { conditions: DIRT_ROUTE },
      BW,
    );
    expect(f.confidence).toBe("medium");
  });
  it("known dam-sire only = low", () => {
    const f = computeBloodstockFitness(
      { sireName: "Unknown Horse", damSireName: "Tapit" },
      { conditions: DIRT_ROUTE },
      BW,
    );
    expect(f.confidence).toBe("low");
  });
});

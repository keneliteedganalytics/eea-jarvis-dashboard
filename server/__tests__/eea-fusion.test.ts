import { describe, it, expect } from "vitest";
import {
  fuseRace,
  assignTier,
  classifyRaceType,
  evaluateLayoff,
} from "../services/eea-fusion";
import { DEFAULT_WEIGHTS } from "../services/eea-config";
import type { BrisnetRace, EquibaseRace, RaceConditions } from "../services/parsers/types";

const W = DEFAULT_WEIGHTS;

function brisHorse(pgm: string, name: string, opts: Partial<{
  speedLast: number; classRating: number; primePower: number;
  e1: number; e2: number; lp: number;
}> = {}): BrisnetRace["horses"][number] {
  return {
    pgm,
    name,
    speedLast: opts.speedLast ?? null,
    classRating: opts.classRating ?? null,
    primePower: opts.primePower ?? null,
    pace: { e1Last: opts.e1 ?? null, e2Last: opts.e2 ?? null, lpLast: opts.lp ?? null },
  };
}

const ALW: RaceConditions = { type: "ALW", raw: "Allowance", purse: 60000, distance: "6F", surface: "DIRT" };
const MSW: RaceConditions = { type: "MAIDEN", raw: "Maiden Special Weight", purse: 50000, distance: "6F", surface: "DIRT" };

describe("classifyRaceType", () => {
  it("maps STK and graded text to stakes_graded", () => {
    expect(classifyRaceType({ type: "STK", raw: "G1 Stakes" })).toBe("stakes_graded");
    expect(classifyRaceType({ type: "", raw: "Grade 2 handicap" })).toBe("stakes_graded");
  });
  it("maps maiden text to msw and claiming to claimer", () => {
    expect(classifyRaceType(MSW)).toBe("msw");
    expect(classifyRaceType({ type: "CLM", raw: "Claiming 16000" })).toBe("claimer");
  });
  it("defaults to allowance", () => {
    expect(classifyRaceType(ALW)).toBe("allowance");
  });
});

describe("evaluateLayoff", () => {
  it("flags long layoffs as risky and normal layoffs as normal", () => {
    expect(evaluateLayoff(90, "claimer", W).status).toBe("risky");
    expect(evaluateLayoff(18, "claimer", W).status).toBe("normal");
    expect(evaluateLayoff(null, "allowance", W).status).toBe("normal");
  });
});

describe("fuseRace composites", () => {
  it("blends Brisnet + Equibase speed with renormalized weights", () => {
    const bris: BrisnetRace = {
      raceNumber: 1,
      conditions: ALW,
      horses: [brisHorse("1", "Alpha", { speedLast: 90, classRating: 110, e1: 80, e2: 82, lp: 70 })],
    };
    const equi: EquibaseRace = {
      raceNumber: 1,
      isMaiden: false,
      horses: [{ pgm: "1", name: "Alpha", speedLast: 80, speedAvg3: 80, classRating: 108, paceLast: 78 }],
    };
    const fused = fuseRace(bris, equi, W, undefined);
    const h = fused.horses.find((x) => x.pgm === "1")!;
    // EEAS = (90*0.6 + 80*0.4) / 1.0 = 86
    expect(h.eeas).toBe(86);
    // sources within agreement threshold (gap 10 -> disagree at >=8)
    expect(h.flags).toContain("speed-sources-disagree");
    expect(h.eeac).not.toBeNull();
  });

  it("marks lone speed and gives an eeap_fit boost", () => {
    const bris: BrisnetRace = {
      raceNumber: 2,
      conditions: ALW,
      horses: [
        brisHorse("1", "Speedy", { speedLast: 85, e1: 95, e2: 95, lp: 60 }),
        brisHorse("2", "Plodder", { speedLast: 85, e1: 70, e2: 70, lp: 80 }),
      ],
    };
    const fused = fuseRace(bris, undefined, W, undefined);
    const speedy = fused.horses.find((x) => x.pgm === "1")!;
    expect(speedy.flags).toContain("projected-lone-speed");
    expect(speedy.eeapFit!).toBeGreaterThan(speedy.eeap!);
    expect(fused.shapeNote).toContain("lone speed");
  });
});

describe("assignTier", () => {
  it("awards SNIPER when leader clears 2nd by >= sniperGap in a non-maiden race", () => {
    const bris: BrisnetRace = {
      raceNumber: 3,
      conditions: ALW,
      horses: [
        brisHorse("1", "Class", { speedLast: 100, classRating: 130, e1: 90, e2: 90, lp: 90 }),
        brisHorse("2", "Midpack", { speedLast: 70, classRating: 95, e1: 60, e2: 60, lp: 60 }),
        brisHorse("3", "Backmarker", { speedLast: 60, classRating: 90, e1: 50, e2: 50, lp: 50 }),
      ],
    };
    const fused = fuseRace(bris, undefined, W, undefined);
    const tiers = assignTier(fused, 2000, W);
    const leaderPgm = fused.horses[0].pgm;
    const leaderTier = tiers.find((t) => t.pgm === leaderPgm)!;
    expect(leaderTier.tier).toBe("SNIPER");
    expect(leaderTier.sizingDollars).toBeGreaterThan(0);
    // Only one SNIPER per race.
    expect(tiers.filter((t) => t.tier === "SNIPER")).toHaveLength(1);
  });

  it("never awards SNIPER in a maiden race — leader defaults to RECON", () => {
    const bris: BrisnetRace = {
      raceNumber: 4,
      conditions: MSW,
      horses: [
        brisHorse("1", "Firster", { speedLast: 100, classRating: 130, e1: 90, e2: 90, lp: 90 }),
        brisHorse("2", "Second", { speedLast: 70, classRating: 95, e1: 60, e2: 60, lp: 60 }),
      ],
    };
    const fused = fuseRace(bris, undefined, W, undefined);
    const tiers = assignTier(fused, 2000, W);
    expect(tiers.some((t) => t.tier === "SNIPER")).toBe(false);
    const leaderTier = tiers.find((t) => t.pgm === fused.horses[0].pgm)!;
    expect(leaderTier.tier).toBe("RECON");
  });
});

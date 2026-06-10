import { describe, it, expect } from "vitest";
import {
  scoreRace,
  matticeTopPick,
  inputFromFusedHorse,
  VETO_NEGATIVE_THRESHOLD,
  CONFIRMED_SCORE,
  MATTICE_MAX,
  type MatticeHorseInput,
} from "../services/mattice";

// Minimal fused-horse-ish input builder.
function horse(over: Partial<MatticeHorseInput> = {}): MatticeHorseInput {
  return {
    pgm: "1",
    name: "Test",
    eeas: 100,
    eeap: 100,
    eeac: 100,
    eeaRating: 100,
    mlOdds: 3,
    flags: [],
    bloodstockApplied: false,
    bloodstockReasons: [],
    ...over,
  };
}

describe("mattice scorer", () => {
  it("scores each horse 0-100 across the five factors", () => {
    const field = [
      horse({ pgm: "1", eeas: 110, eeap: 110, eeac: 110, eeaRating: 110, mlOdds: 1.5 }),
      horse({ pgm: "2", eeas: 90, eeap: 90, eeac: 90, eeaRating: 90, mlOdds: 12 }),
      horse({ pgm: "3", eeas: 100, eeap: 100, eeac: 100, eeaRating: 100, mlOdds: 5 }),
    ];
    const scores = scoreRace(field);
    expect(scores).toHaveLength(3);
    for (const s of scores) {
      expect(s.matticeScore).toBeGreaterThanOrEqual(0);
      expect(s.matticeScore).toBeLessThanOrEqual(MATTICE_MAX);
      expect(Object.keys(s.factors)).toEqual(["pace", "speed", "class", "connections", "form"]);
    }
  });

  it("ranks the field-best horse highest", () => {
    const field = [
      horse({ pgm: "1", eeas: 120, eeap: 120, eeac: 120, eeaRating: 120, mlOdds: 1.5 }),
      horse({ pgm: "2", eeas: 80, eeap: 80, eeac: 80, eeaRating: 80, mlOdds: 20 }),
    ];
    const scores = scoreRace(field);
    const top = matticeTopPick(scores);
    expect(top?.programNumber).toBe("1");
  });

  it("projected-lone-speed flag pushes pace positive", () => {
    const field = [
      horse({ pgm: "1", eeap: 100, flags: ["projected-lone-speed"] }),
      horse({ pgm: "2", eeap: 100 }),
    ];
    const s1 = scoreRace(field).find((s) => s.programNumber === "1")!;
    expect(s1.factors.pace.signal).toBe("positive");
  });

  it("in-pace-duel flag pushes pace negative", () => {
    const field = [
      horse({ pgm: "1", eeap: 100, flags: ["in-pace-duel"] }),
      horse({ pgm: "2", eeap: 100 }),
    ];
    const s1 = scoreRace(field).find((s) => s.programNumber === "1")!;
    expect(s1.factors.pace.signal).toBe("negative");
  });

  it("vetoes a horse with 2+ negative factors", () => {
    // Bottom of every category + a longshot ML → multiple negatives.
    const field = [
      horse({ pgm: "1", eeas: 130, eeap: 130, eeac: 130, eeaRating: 130, mlOdds: 1.5 }),
      horse({ pgm: "2", eeas: 130, eeap: 130, eeac: 130, eeaRating: 130, mlOdds: 1.5 }),
      horse({ pgm: "3", eeas: 60, eeap: 60, eeac: 60, eeaRating: 60, mlOdds: 30 }),
    ];
    const s3 = scoreRace(field).find((s) => s.programNumber === "3")!;
    const negatives = Object.values(s3.factors).filter((f) => f.signal === "negative").length;
    expect(negatives).toBeGreaterThanOrEqual(VETO_NEGATIVE_THRESHOLD);
    expect(s3.vetoFlag).toBe(true);
  });

  it("connections proxy: short ML positive, longshot negative", () => {
    const field = [horse({ pgm: "1", mlOdds: 1.5 }), horse({ pgm: "2", mlOdds: 20 })];
    const scores = scoreRace(field);
    expect(scores.find((s) => s.programNumber === "1")!.factors.connections.signal).toBe("positive");
    expect(scores.find((s) => s.programNumber === "2")!.factors.connections.signal).toBe("negative");
  });

  it("is deterministic — same input, same output", () => {
    const field = [horse({ pgm: "1" }), horse({ pgm: "2", eeas: 80 })];
    expect(scoreRace(field)).toEqual(scoreRace(field));
  });

  it("matticeTopPick breaks ties by fewer vetoes then program number", () => {
    // Two identical-figure horses; tie broken by pgm.
    const field = [horse({ pgm: "5" }), horse({ pgm: "2" })];
    const top = matticeTopPick(scoreRace(field));
    expect(top?.programNumber).toBe("2");
  });

  it("inputFromFusedHorse prefers eeapFit over eeap", () => {
    const fused: any = {
      pgm: "1",
      name: "X",
      eeas: 100,
      eeap: 90,
      eeapFit: 105,
      eeac: 100,
      eeaRating: 100,
      mlOdds: 3,
      flags: [],
      bloodstockAdjustment: { applied: false, reasonCodes: [] },
    };
    expect(inputFromFusedHorse(fused).eeap).toBe(105);
  });

  it("CONFIRMED_SCORE gate is 75", () => {
    expect(CONFIRMED_SCORE).toBe(75);
  });
});

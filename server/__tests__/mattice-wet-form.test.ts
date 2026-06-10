import { describe, it, expect } from "vitest";
import { scoreRace, hasWetTrackSuccess, type MatticeHorseInput } from "../services/mattice";

// Minimal field-relative input builder; wetWinPct null by default (no wet history).
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
    wetWinPct: null,
    ...over,
  };
}

describe("hasWetTrackSuccess", () => {
  it("is true only for a positive wet win/ITM rate", () => {
    expect(hasWetTrackSuccess(25)).toBe(true);
    expect(hasWetTrackSuccess(0)).toBe(false);
    expect(hasWetTrackSuccess(null)).toBe(false);
  });
});

describe("Mattice Form & Habits wet-track bump (spec §4)", () => {
  const field = (over: Partial<MatticeHorseInput>): MatticeHorseInput[] => [
    horse({ pgm: "1", ...over }),
    horse({ pgm: "2", eeaRating: 95 }),
    horse({ pgm: "3", eeaRating: 90 }),
  ];

  it("adds +3 to Form on a wet day for a horse with prior wet-track success", () => {
    const inputs = field({ wetWinPct: 33 });
    const dry = scoreRace(inputs, { wetDay: false }).find((s) => s.programNumber === "1")!;
    const wet = scoreRace(inputs, { wetDay: true }).find((s) => s.programNumber === "1")!;
    expect(wet.factors.form.score).toBe(Math.min(20, dry.factors.form.score + 3));
    expect(wet.factors.form.evidence).toMatch(/wet/i);
  });

  it("skips silently when no wet history is parsed (wetWinPct null/0)", () => {
    const inputsNull = field({ wetWinPct: null });
    const dryNull = scoreRace(inputsNull, { wetDay: false }).find((s) => s.programNumber === "1")!;
    const wetNull = scoreRace(inputsNull, { wetDay: true }).find((s) => s.programNumber === "1")!;
    expect(wetNull.factors.form.score).toBe(dryNull.factors.form.score);
    expect(wetNull.factors.form.evidence).not.toMatch(/wet/i);

    const inputsZero = field({ wetWinPct: 0 });
    const wetZero = scoreRace(inputsZero, { wetDay: true }).find((s) => s.programNumber === "1")!;
    const dryZero = scoreRace(inputsZero, { wetDay: false }).find((s) => s.programNumber === "1")!;
    expect(wetZero.factors.form.score).toBe(dryZero.factors.form.score);
  });

  it("does not bump on a dry day even with wet history", () => {
    const inputs = field({ wetWinPct: 50 });
    const dry = scoreRace(inputs, { wetDay: false }).find((s) => s.programNumber === "1")!;
    expect(dry.factors.form.evidence).not.toMatch(/wet/i);
  });

  it("a wet bump can lift a negative Form signal to neutral", () => {
    // Worst-rated horse in the field → bottom-band negative Form, then wet bump.
    const inputs = [
      horse({ pgm: "1", eeaRating: 70, wetWinPct: 40 }),
      horse({ pgm: "2", eeaRating: 100 }),
      horse({ pgm: "3", eeaRating: 110 }),
    ];
    const dry = scoreRace(inputs, { wetDay: false }).find((s) => s.programNumber === "1")!;
    const wet = scoreRace(inputs, { wetDay: true }).find((s) => s.programNumber === "1")!;
    expect(dry.factors.form.signal).toBe("negative");
    expect(wet.factors.form.signal).not.toBe("negative");
  });
});

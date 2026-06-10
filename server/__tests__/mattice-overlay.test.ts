import { describe, it, expect } from "vitest";
import { applyOverlay, TIEBREAK_BAND } from "../services/mattice-overlay";
import { PHASE_TIEBREAK, PHASE_BLEND_50 } from "../services/mattice-weight";
import type { FusedHorse, FusedRace } from "../services/eea-fusion";

function fh(over: Partial<FusedHorse> = {}): FusedHorse {
  return {
    pgm: "1",
    name: "Test",
    isMaiden: false,
    eeas: 100,
    eeap: 100,
    eeapFit: 100,
    eeac: 100,
    eeaRating: 100,
    mlOdds: 3,
    rank: 1,
    flags: [],
    bloodstockAdjustment: { applied: false, composite: 0, reasonCodes: [], confidence: "none", ratingDelta: 0 },
    ...over,
  } as FusedHorse;
}

function race(horses: FusedHorse[]): FusedRace {
  return {
    raceNumber: 1,
    raceType: "claimer",
    conditions: { raw: "", type: "CLM", purse: null } as any,
    shapeNote: "",
    horses,
    weatherAdjustment: {} as any,
  } as FusedRace;
}

describe("mattice overlay — Phase 1 tiebreak", () => {
  it("breaks a within-band tie toward the higher mattice score", () => {
    // Leader #1 rank 1 rating 101; #2 rank 2 rating 100 (within 3 pts). #2 has the
    // stronger Mattice profile (lone speed + short price) → tiebreak to #2.
    const r = race([
      fh({ pgm: "1", rank: 1, eeaRating: 101, eeas: 100, eeap: 100, eeac: 100, mlOdds: 6 }),
      fh({
        pgm: "2",
        rank: 2,
        eeaRating: 100,
        eeas: 120,
        eeap: 120,
        eeac: 120,
        mlOdds: 1.5,
        flags: ["projected-lone-speed"],
      }),
    ]);
    const out = applyOverlay(r, "SNIPER", PHASE_TIEBREAK);
    expect(out.tiebreakApplied).toBe(true);
    expect(out.winPgm).toBe("2");
  });

  it("does NOT tiebreak when the top two are outside the band", () => {
    const r = race([
      fh({ pgm: "1", rank: 1, eeaRating: 120 }),
      fh({ pgm: "2", rank: 2, eeaRating: 100, eeas: 130, eeap: 130, eeac: 130, mlOdds: 1.5 }),
    ]);
    expect(Math.abs(120 - 100)).toBeGreaterThan(TIEBREAK_BAND);
    const out = applyOverlay(r, "SNIPER", PHASE_TIEBREAK);
    expect(out.tiebreakApplied).toBe(false);
    expect(out.winPgm).toBe("1");
  });
});

describe("mattice overlay — veto downgrade", () => {
  it("downgrades the tier one step when the win pick is vetoed", () => {
    // Make the leader the worst horse in a strong field so it collects 2+ negatives.
    const r = race([
      fh({ pgm: "1", rank: 1, eeas: 60, eeap: 60, eeac: 60, eeaRating: 60, mlOdds: 30 }),
      fh({ pgm: "2", rank: 2, eeas: 120, eeap: 120, eeac: 120, eeaRating: 120, mlOdds: 1.5 }),
      fh({ pgm: "3", rank: 3, eeas: 120, eeap: 120, eeac: 120, eeaRating: 120, mlOdds: 1.5 }),
    ]);
    const out = applyOverlay(r, "SNIPER", PHASE_TIEBREAK);
    // Leader rating 60 vs second 120 → no tiebreak; leader stays #1 and is vetoed.
    expect(out.winPgm).toBe("1");
    expect(out.vetoApplied).toBe(true);
    expect(out.tier).toBe("EDGE");
  });

  it("does not downgrade a clean win pick", () => {
    const r = race([
      fh({ pgm: "1", rank: 1, eeas: 120, eeap: 120, eeac: 120, eeaRating: 120, mlOdds: 1.5 }),
      fh({ pgm: "2", rank: 2, eeas: 80, eeap: 80, eeac: 80, eeaRating: 80, mlOdds: 12 }),
    ]);
    const out = applyOverlay(r, "SNIPER", PHASE_TIEBREAK);
    expect(out.vetoApplied).toBe(false);
    expect(out.tier).toBe("SNIPER");
  });
});

describe("mattice overlay — confirmed badge", () => {
  it("stamps Mattice Confirmed when win pick ≥75 and no veto", () => {
    const r = race([
      fh({ pgm: "1", rank: 1, eeas: 130, eeap: 130, eeac: 130, eeaRating: 130, mlOdds: 1.5, flags: ["projected-lone-speed"] }),
      fh({ pgm: "2", rank: 2, eeas: 70, eeap: 70, eeac: 70, eeaRating: 70, mlOdds: 12 }),
    ]);
    const out = applyOverlay(r, "SNIPER", PHASE_TIEBREAK);
    const winScore = out.scores.find((s) => s.programNumber === out.winPgm)!;
    expect(winScore.matticeScore).toBeGreaterThanOrEqual(75);
    expect(out.confirmed).toBe(true);
  });
});

describe("mattice overlay — Phase 3 blend", () => {
  it("can move the win pick via a 50% blend", () => {
    // Wider field so the fused-rating normalization isn't pinned to 0/1 on the
    // top two. #1 owns a narrow fused edge but a weak Mattice profile; #2 a small
    // fused deficit but a dominant Mattice profile. At 50% blend, #2 overtakes.
    const r = race([
      fh({ pgm: "1", rank: 1, eeaRating: 110, eeas: 70, eeap: 70, eeac: 70, mlOdds: 20 }),
      fh({
        pgm: "2",
        rank: 2,
        eeaRating: 108,
        eeas: 130,
        eeap: 130,
        eeac: 130,
        mlOdds: 1.5,
        flags: ["projected-lone-speed"],
      }),
      fh({ pgm: "3", rank: 3, eeaRating: 60, eeas: 60, eeap: 60, eeac: 60, mlOdds: 30 }),
    ]);
    const out = applyOverlay(r, "SNIPER", PHASE_BLEND_50);
    expect(out.winPgm).toBe("2");
    expect(out.tiebreakApplied).toBe(true);
  });

  it("empty field is a no-op", () => {
    const out = applyOverlay(race([]), "SNIPER", PHASE_TIEBREAK);
    expect(out.winPgm).toBeNull();
    expect(out.vetoApplied).toBe(false);
  });
});

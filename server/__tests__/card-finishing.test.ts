import { describe, it, expect } from "vitest";
import {
  normalizeFractions,
  cleanConditions,
  scoresForPicks,
  deriveFlags,
  computeCardConviction,
} from "../services/card-finishing";
import { DEFAULT_WEIGHTS } from "../services/eea-config";
import type { FusedRace, FusedHorse } from "../services/eea-fusion";
import type { RaceConditions } from "../services/parsers/types";

function horse(pgm: string, name: string, rating: number | null, flags: string[] = []): FusedHorse {
  return {
    pgm, name, isMaiden: false,
    eeas: null, eeap: null, eeapFit: null, eeac: null,
    eeaRating: rating, rank: 0, flags,
  };
}

function race(horses: FusedHorse[], conditions?: Partial<RaceConditions>): FusedRace {
  const ranked = [...horses].sort((a, b) => (b.eeaRating ?? -Infinity) - (a.eeaRating ?? -Infinity));
  ranked.forEach((h, i) => (h.rank = i + 1));
  return {
    raceNumber: 1,
    raceType: "allowance",
    conditions: { type: "ALW", raw: "", ...conditions } as RaceConditions,
    shapeNote: "honest pace",
    horses: ranked,
  };
}

describe("normalizeFractions", () => {
  it("maps the Finger Lakes î glyph back to ½", () => {
    expect(normalizeFractions("5î Furlongs")).toBe("5½ Furlongs");
  });
});

describe("cleanConditions", () => {
  it("compacts a Finger Lakes 'Ultimate PP's' header into the Saratoga format", () => {
    const raw =
      "Ultimate PP's w/ QuickPlay Comments Finger Lakes Alw 26500n2L 5î Furlongs 3&up Monday June 08 2026 Race 1";
    const out = cleanConditions(raw, { surface: "DIRT", distance: "5î Furlongs", raceRating: 81 });
    expect(out).toContain("Alw 26500 N2L");
    expect(out).toContain("5.5F Dirt");
    expect(out).toContain("RR 81");
    expect(out).not.toMatch(/Ultimate|QuickPlay|Finger Lakes|Monday|2026|Race/);
  });

  it("handles claimer + 1m70yds + omits RR when unknown", () => {
    const raw =
      "Ultimate PP's w/ QuickPlay Comments Finger Lakes Clm 11000b 1m70yds 3&up Monday June 08 2026 Race 8";
    const out = cleanConditions(raw, { surface: "DIRT", distance: "1m70yds" });
    expect(out).toContain("Clm 11000 B");
    expect(out).toContain("1M70y Dirt");
    expect(out).not.toMatch(/RR/);
  });

  it("leaves a 1-mile maiden readable", () => {
    const raw =
      "Ultimate PP's w/ QuickPlay Comments Finger Lakes Mdn 32.6k 1 Mile 3&up Monday June 08 2026 Race 4";
    const out = cleanConditions(raw, { surface: "DIRT", distance: "1 Mile" });
    expect(out).toContain("Mdn 32.6k");
    expect(out).toContain("1M Dirt");
  });
});

describe("scoresForPicks", () => {
  it("looks up each pick's EEA Rating by program number", () => {
    const r = race([
      horse("3", "Beev's Blessing", 58.4),
      horse("5", "Vino's Valentine", 57.7),
      horse("2", "Magic Beach", 57.3),
      horse("1", "Juniors Pal", 22.4),
    ]);
    const scores = scoresForPicks(r, { winPgm: "3", placePgm: "5", showPgm: "2", fourthPgm: "1" });
    expect(scores).toEqual({ winScore: 58.4, placeScore: 57.7, showScore: 57.3, fourthScore: 22.4 });
  });

  it("returns null for an unknown program number", () => {
    const r = race([horse("3", "A", 58.4)]);
    expect(scoresForPicks(r, { winPgm: "9" }).winScore).toBeNull();
  });
});

describe("deriveFlags", () => {
  it("raises VALUE GATE when the top two are within half a point", () => {
    const r = race([horse("3", "Honest Reason", 59.8), horse("2", "Bunny Honey", 59.3)]);
    expect(deriveFlags(r, DEFAULT_WEIGHTS)).toContain("VALUE GATE on #2");
  });

  it("raises FIELD SIZE chaos for a 12+ horse field", () => {
    const big = race(Array.from({ length: 13 }, (_, i) => horse(String(i + 1), `H${i}`, 80 - i)));
    expect(deriveFlags(big, DEFAULT_WEIGHTS)).toContain("FIELD SIZE chaos");
  });
});

describe("computeCardConviction", () => {
  it("is HIGH with a SNIPER on the card", () => {
    expect(computeCardConviction(["PASS", "SNIPER", "RECON"])).toBe("HIGH");
  });
  it("is HIGH with two EDGE races", () => {
    expect(computeCardConviction(["EDGE", "EDGE", "PASS"])).toBe("HIGH");
  });
  it("is MEDIUM with a single actionable tier", () => {
    expect(computeCardConviction(["DUAL", "PASS", "PASS"])).toBe("MEDIUM");
  });
  it("is LOW when every race is a PASS", () => {
    expect(computeCardConviction(["PASS", "PASS"])).toBe("LOW");
  });
});

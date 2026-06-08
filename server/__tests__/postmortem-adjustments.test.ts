// Tests for the Card 1 (Saratoga 2026-06-07) postmortem fixes: tighter EDGE
// class flips, flag-driven tier demotion, and longshot co-top promotion.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CLASS_FLIP_THRESHOLD,
  LONGSHOT_ML_MIN,
  demoteTier,
  flagTargetPgm,
  tightenClassFlip,
  demoteByFlags,
  longshotCoTop,
  applyPostmortemAdjustments,
} from "../services/postmortem-adjustments";
import type { FusedRace, FusedHorse, Tier } from "../services/eea-fusion";
import { parseMlOdds } from "../services/eea-fusion";

function horse(pgm: string, opts: Partial<FusedHorse> = {}): FusedHorse {
  return {
    pgm,
    name: opts.name ?? `Horse ${pgm}`,
    isMaiden: false,
    eeas: opts.eeas ?? null,
    eeap: opts.eeap ?? null,
    eeapFit: opts.eeapFit ?? null,
    eeac: opts.eeac ?? null,
    eeaRating: opts.eeaRating ?? null,
    mlOdds: opts.mlOdds ?? null,
    rank: opts.rank ?? 0,
    flags: opts.flags ?? [],
  };
}

function race(horses: FusedHorse[], raceNumber = 1): FusedRace {
  const ranked = [...horses].sort((a, b) => (b.eeaRating ?? -Infinity) - (a.eeaRating ?? -Infinity));
  ranked.forEach((h, i) => (h.rank = i + 1));
  return {
    raceNumber,
    raceType: "allowance",
    conditions: { type: "ALW", raw: "Allowance" },
    shapeNote: "honest pace",
    horses: ranked,
  };
}

describe("parseMlOdds", () => {
  it("parses fractional, slash, whole, and even forms", () => {
    expect(parseMlOdds("6-1")).toBe(6);
    expect(parseMlOdds("9-2")).toBe(4.5);
    expect(parseMlOdds("7/2")).toBe(3.5);
    expect(parseMlOdds("5")).toBe(5);
    expect(parseMlOdds("EVN")).toBe(1);
    expect(parseMlOdds(null)).toBeNull();
    expect(parseMlOdds("")).toBeNull();
    expect(parseMlOdds("scratched")).toBeNull();
  });
});

describe("demoteTier ladder", () => {
  it("walks SNIPER→EDGE→RECON→PASS and DUAL→RECON", () => {
    expect(demoteTier("SNIPER")).toBe("EDGE");
    expect(demoteTier("EDGE")).toBe("RECON");
    expect(demoteTier("DUAL")).toBe("RECON");
    expect(demoteTier("RECON")).toBe("PASS");
    expect(demoteTier("PASS")).toBe("PASS");
    expect(demoteTier("SNIPER", 2)).toBe("RECON");
  });
});

describe("flagTargetPgm", () => {
  it("extracts pgm from 'TYPE on #N' and returns null for 'noted'", () => {
    expect(flagTargetPgm("BOUNCE RISK on #1")).toBe("1");
    expect(flagTargetPgm("TRIP-AIDED on #7")).toBe("7");
    expect(flagTargetPgm("VALUE GATE on # 10")).toBe("10");
    expect(flagTargetPgm("BOUNCE RISK noted")).toBeNull();
    expect(flagTargetPgm("FIELD SIZE chaos")).toBeNull();
  });
});

// ── Fix 1 ────────────────────────────────────────────────────────────────────
describe("Fix 1 — tighten EDGE class flips", () => {
  // Engine leader is #1 (rating 90, class 100). LLM flipped to #2.
  function flipRace(twoEeac: number, twoOpts: Partial<FusedHorse> = {}) {
    return race([
      horse("1", { eeaRating: 90, eeac: 100, eeas: 95, eeapFit: 95 }),
      horse("2", { eeaRating: 88, eeac: twoEeac, ...twoOpts }),
    ]);
  }

  it("reverts a sub-threshold flip with no corroboration", () => {
    const r = flipRace(104); // delta +4 < 7, no field-high, no edge flag
    const d = tightenClassFlip(r, "EDGE", "2");
    expect(d.flipped).toBe(false);
    expect(d.winPgm).toBe("1"); // reverted to engine leader
  });

  it("honors a flip that clears the class-delta threshold", () => {
    const r = flipRace(100 + CLASS_FLIP_THRESHOLD); // delta exactly +7
    const d = tightenClassFlip(r, "EDGE", "2");
    expect(d.flipped).toBe(true);
    expect(d.winPgm).toBe("2");
  });

  it("honors a sub-threshold flip when corroborated by field-high pace", () => {
    // delta only +3, but #2 owns field-high pace → corroborated.
    const r = flipRace(103, { eeapFit: 120 });
    const d = tightenClassFlip(r, "EDGE", "2");
    expect(d.flipped).toBe(true);
    expect(d.winPgm).toBe("2");
  });

  it("is a no-op when the win pick already matches the engine leader", () => {
    const r = flipRace(110);
    const d = tightenClassFlip(r, "EDGE", "1");
    expect(d.flipped).toBe(false);
    expect(d.winPgm).toBe("1");
  });

  it("does not gate non-EDGE tiers", () => {
    const r = flipRace(104);
    const d = tightenClassFlip(r, "SNIPER", "2");
    expect(d.flipped).toBe(false);
    expect(d.winPgm).toBe("2"); // SNIPER flip left untouched
  });
});

// ── Fix 2 ────────────────────────────────────────────────────────────────────
describe("Fix 2 — flag-driven tier demotion", () => {
  it("demotes one notch when a flag targets the win pick", () => {
    const r = demoteByFlags(["VALUE GATE on #1"], "EDGE", { winPgm: "1", placePgm: "8" });
    expect(r.tier).toBe("RECON");
    expect(r.tierDemotedBy).toContain("EDGE→RECON");
    expect(r.tierDemotedBy).toContain("win pick");
  });

  it("demotes one notch when a flag targets the place pick", () => {
    const r = demoteByFlags(["BOUNCE RISK on #1"], "EDGE", { winPgm: "6", placePgm: "1" });
    expect(r.tier).toBe("RECON");
    expect(r.tierDemotedBy).toContain("place pick");
  });

  it("does not demote when the flag targets a non-top-2 horse", () => {
    // R7: TRIP-AIDED on #7, but win=#15 place=#6 → #7 is not top-2.
    const r = demoteByFlags(["TRIP-AIDED on #7"], "EDGE", { winPgm: "15", placePgm: "6" });
    expect(r.tier).toBe("EDGE");
    expect(r.tierDemotedBy).toBeNull();
  });

  it("does not demote on a target-less 'noted' flag", () => {
    const r = demoteByFlags(["BOUNCE RISK noted"], "EDGE", { winPgm: "1", placePgm: "2" });
    expect(r.tier).toBe("EDGE");
    expect(r.tierDemotedBy).toBeNull();
  });

  it("drops two notches when two flags hit the top-2 picks", () => {
    const r = demoteByFlags(
      ["BOUNCE RISK on #1", "TRIP-AIDED on #2"],
      "SNIPER",
      { winPgm: "1", placePgm: "2" },
    );
    expect(r.tier).toBe("RECON"); // SNIPER→EDGE→RECON
  });
});

// ── Fix 3 ────────────────────────────────────────────────────────────────────
describe("Fix 3 — longshot co-top promotion", () => {
  it("co-tops a field-high-pace longshot at 6-1+ on an EDGE play", () => {
    const r = race([
      horse("1", { eeaRating: 90, eeapFit: 100, eeas: 95, mlOdds: 2 }), // chalk win pick
      horse("8", { eeaRating: 80, eeapFit: 120, eeas: 90, mlOdds: 8 }), // field-high pace longshot
    ]);
    const res = longshotCoTop(r, "EDGE", "1");
    expect(res.promoted).toEqual(["8"]);
    expect(res.coTopPgms).toEqual(["1", "8"]);
    expect(res.note).toContain("#8");
  });

  it("does not promote a field-high horse that is the chalk (ML < 6-1)", () => {
    const r = race([
      horse("1", { eeaRating: 90, eeapFit: 100, mlOdds: 2 }),
      horse("3", { eeaRating: 80, eeapFit: 130, mlOdds: 3 }), // field-high but 3-1 chalk
    ]);
    const res = longshotCoTop(r, "EDGE", "1");
    expect(res.promoted).toEqual([]);
    expect(res.coTopPgms).toEqual(["1"]);
  });

  it("does not promote a longshot lacking a field-high number", () => {
    const r = race([
      horse("1", { eeaRating: 90, eeapFit: 100, eeas: 95, mlOdds: 2 }),
      horse("9", { eeaRating: 70, eeapFit: 70, eeas: 70, mlOdds: 12 }), // longshot, no edge
    ]);
    const res = longshotCoTop(r, "EDGE", "1");
    expect(res.promoted).toEqual([]);
  });

  it("only fires on EDGE tier", () => {
    const r = race([
      horse("1", { eeaRating: 90, eeapFit: 100, mlOdds: 2 }),
      horse("8", { eeaRating: 80, eeapFit: 120, mlOdds: 8 }),
    ]);
    expect(longshotCoTop(r, "SNIPER", "1").promoted).toEqual([]);
  });
});

// ── Orchestrator + acceptance ────────────────────────────────────────────────
describe("applyPostmortemAdjustments", () => {
  it("reverts a weak flip then demotes when a flag hits the reverted win pick", () => {
    const r = race([
      horse("1", { eeaRating: 90, eeac: 100, name: "Engine Leader" }),
      horse("2", { eeaRating: 88, eeac: 103, name: "Class Flip" }), // delta +3, no corroboration
    ]);
    const adj = applyPostmortemAdjustments(
      r,
      "EDGE",
      { winPgm: "2", winName: "Class Flip", placePgm: "1", placeName: "Engine Leader" },
      ["BOUNCE RISK on #1"], // now targets the reverted win pick #1
    );
    expect(adj.picks.winPgm).toBe("1");
    expect(adj.picks.winName).toBe("Engine Leader");
    expect(adj.tier).toBe("RECON"); // flag on win pick demotes EDGE→RECON
    expect(adj.tierDemotedBy).toContain("win pick");
  });
});

// Acceptance against the real Card 1 fixture, when present in the repo root or
// the workspace. Validates Fix 2 against the persisted board: R9 (BOUNCE RISK on
// #1, place=#1) and R10 (VALUE GATE on #1, win=#1) must demote EDGE→RECON; R7
// (TRIP-AIDED on #7, top-2 are #15/#6) must NOT demote; SNIPER R11 stays SNIPER.
describe("Card 1 Saratoga 2026-06-07 acceptance (fixture)", () => {
  const candidates = [
    path.resolve(process.cwd(), "card1_postmortem.json"),
    path.resolve(process.cwd(), "..", "card1_postmortem.json"),
    path.resolve(process.cwd(), "test-fixtures", "card1_postmortem.json"),
  ];
  const fixturePath = candidates.find((p) => fs.existsSync(p));

  it.skipIf(!fixturePath)("demotes R9/R10, holds R7, keeps R11 SNIPER", () => {
    const card = JSON.parse(fs.readFileSync(fixturePath!, "utf8")) as {
      races: {
        raceNumber: number;
        tier: Tier;
        winPgm: string | null;
        placePgm: string | null;
        flags: string;
      }[];
    };
    const byNum = new Map(card.races.map((r) => [r.raceNumber, r]));

    const check = (n: number) => {
      const row = byNum.get(n)!;
      const flags = JSON.parse(row.flags) as string[];
      return demoteByFlags(flags, row.tier, { winPgm: row.winPgm, placePgm: row.placePgm });
    };

    expect(check(9).tier).toBe("RECON"); // BOUNCE RISK on #1 == place pick
    expect(check(10).tier).toBe("RECON"); // VALUE GATE on #1 == win pick
    expect(check(7).tier).toBe("EDGE"); // TRIP-AIDED on #7 not in top-2
    expect(check(11).tier).toBe("SNIPER"); // no flags → unchanged
  });
});

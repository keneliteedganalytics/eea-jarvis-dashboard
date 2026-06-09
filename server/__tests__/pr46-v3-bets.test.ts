// PR #46 — exacta-led v3 bet allocator + combo-aware ledger grading.

import { describe, it, expect } from "vitest";
import { buildV3Bets, TIER_CAPS_V3 } from "../services/budgeted-bets-v3";

function makeRace(overrides: Partial<{
  id: number; tier: string; flags: string;
  winPgm: string | null; placePgm: string | null; showPgm: string | null; fourthPgm: string | null;
  conditions: string | null;
}> = {}) {
  return {
    id: 1,
    tier: "SNIPER",
    flags: "[]",
    winPgm: "5",
    placePgm: "1",
    showPgm: "3",
    fourthPgm: "7",
    conditions: null,
    ...overrides,
  };
}

describe("PR #46 v3 allocator", () => {
  it("SNIPER bundles WIN A + EXA A-B straight + EXA A/B/C box + TRI A KEY", () => {
    const out = buildV3Bets([makeRace({ tier: "SNIPER" })]).get(1);
    expect(out).toBeDefined();
    expect(out!.pass).toBe(false);
    const types = out!.legs.map((l) => `${l.type}:${l.betSubtype ?? ""}:${l.cost}`);
    expect(types).toContain("WIN::80");
    expect(types).toContain("EXACTA:STRAIGHT:80");
    expect(types).toContain("EXACTA:BOX:30");
    expect(types).toContain("TRIFECTA:KEY:20");
    expect(out!.raceAllocation).toBeLessThanOrEqual(TIER_CAPS_V3.SNIPER);
  });

  it("EDGE bundles WIN A + EXA A-B straight + EXA A/B box + EXA A/B/C box + WIN B", () => {
    const out = buildV3Bets([makeRace({ tier: "EDGE" })]).get(1);
    expect(out!.pass).toBe(false);
    const costs = out!.legs.map((l) => l.cost);
    const total = costs.reduce((s, c) => s + c, 0);
    expect(total).toBeLessThanOrEqual(TIER_CAPS_V3.EDGE);
    const types = out!.legs.map((l) => `${l.type}:${l.betSubtype ?? ""}`);
    expect(types).toContain("EXACTA:STRAIGHT");
    expect(types).toContain("EXACTA:BOX");
    expect(types).toContain("WIN:");
  });

  it("DUAL bundles A-B + B-A straights + boxes (no WIN)", () => {
    const out = buildV3Bets([makeRace({ tier: "DUAL" })]).get(1);
    expect(out!.pass).toBe(false);
    const total = out!.legs.reduce((s, l) => s + l.cost, 0);
    expect(total).toBeLessThanOrEqual(TIER_CAPS_V3.DUAL);
    const straights = out!.legs.filter((l) => l.betSubtype === "STRAIGHT");
    expect(straights.length).toBe(2);
    // Combos for the two straights are A-B and B-A.
    const combos = straights.map((l) => l.combo.join("-")).sort();
    expect(combos).toEqual(["1-5", "5-1"]);
  });

  it("RECON is capped at $40 \u2014 the pre-PR-46 bug logged $1000 on R8", () => {
    const out = buildV3Bets([makeRace({ tier: "RECON" })]).get(1);
    expect(out!.pass).toBe(false);
    const total = out!.legs.reduce((s, l) => s + l.cost, 0);
    expect(total).toBeLessThanOrEqual(TIER_CAPS_V3.RECON);
    expect(total).toBeLessThanOrEqual(40);
  });

  it("PASS emits zero legs", () => {
    const out = buildV3Bets([makeRace({ tier: "PASS" })]).get(1);
    expect(out!.pass).toBe(true);
    expect(out!.legs).toEqual([]);
  });

  it("legs carry combo + betSubtype for every EXACTA/TRIFECTA leg", () => {
    const out = buildV3Bets([makeRace({ tier: "SNIPER" })]).get(1);
    for (const l of out!.legs) {
      if (l.type === "EXACTA" || l.type === "TRIFECTA") {
        expect(l.combo.length).toBeGreaterThanOrEqual(2);
        expect(["STRAIGHT", "BOX", "KEY"]).toContain(l.betSubtype);
      }
    }
  });

  it("missing B horse falls back to WIN-only at tier scale", () => {
    const out = buildV3Bets([
      makeRace({ tier: "SNIPER", placePgm: null, showPgm: null, fourthPgm: null }),
    ]).get(1);
    expect(out!.pass).toBe(false);
    expect(out!.legs.every((l) => l.type === "WIN")).toBe(true);
  });

  it("missing A horse \u2192 PASS regardless of tier", () => {
    const out = buildV3Bets([
      makeRace({ tier: "SNIPER", winPgm: null }),
    ]).get(1);
    expect(out!.pass).toBe(true);
  });

  it("hard tier caps never exceeded for any tier", () => {
    const tiers = ["SNIPER", "EDGE", "DUAL", "RECON"] as const;
    for (const tier of tiers) {
      const out = buildV3Bets([makeRace({ tier })]).get(1);
      const total = out!.legs.reduce((s, l) => s + l.cost, 0);
      expect(total).toBeLessThanOrEqual(TIER_CAPS_V3[tier]);
    }
  });

  it("chaos flag demotes one tier (SNIPER \u2192 EDGE) but caps at RECON floor", () => {
    const out = buildV3Bets([
      makeRace({ tier: "SNIPER", flags: JSON.stringify(["FIELD SIZE chaos"]) }),
    ]).get(1);
    expect(out!.demotedFrom).toBe("SNIPER");
    // EDGE total cap is 200; allocation should fit under it.
    const total = out!.legs.reduce((s, l) => s + l.cost, 0);
    expect(total).toBeLessThanOrEqual(TIER_CAPS_V3.EDGE);
  });
});

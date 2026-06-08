import { describe, it, expect } from "vitest";
import type { CardWithRaces, RaceWithResult } from "@shared/schema";
import {
  cardSummaryScript,
  cardBriefingScript,
  type CardStats,
} from "../services/scripts";
import { pluralize, numberWord, isAre, thereIsAre } from "../services/text";

// ── Fixtures ───────────────────────────────────────────────────────────────

function race(raceNumber: number, tier: string): RaceWithResult {
  return {
    id: raceNumber,
    cardId: 1,
    raceNumber,
    tier,
    post: "1:00 PM",
    conditions: "MSW",
    shape: "Honest pace",
    flags: "[]",
    read: null,
    winPgm: "1",
    winName: "Test Horse",
    winScore: "92",
    placePgm: "2",
    placeName: "Second",
    showPgm: "3",
    showName: "Third",
    fourthName: "Fourth",
    result: null,
  } as unknown as RaceWithResult;
}

// Build a card whose race tiers match the requested per-tier counts.
function card(counts: Partial<Record<string, number>>): CardWithRaces {
  const races: RaceWithResult[] = [];
  let n = 1;
  for (const [tier, count] of Object.entries(counts)) {
    for (let i = 0; i < (count ?? 0); i++) races.push(race(n++, tier));
  }
  return {
    id: 1,
    track: "Finger Lakes",
    date: "2026-06-08",
    cardConviction: "HIGH",
    races,
  } as unknown as CardWithRaces;
}

function stats(over: Partial<CardStats> = {}): CardStats {
  return {
    winsHit: 0,
    itmHit: 0,
    sniperHits: 0,
    sniperCount: 0,
    edgeHits: 0,
    edgeCount: 0,
    roi: 0,
    flagsHit: 0,
    flagsRaised: 0,
    ...over,
  };
}

// ── text helpers ─────────────────────────────────────────────────────────────

describe("text helpers", () => {
  it("pluralize agrees with count and spells small numbers", () => {
    expect(pluralize(0, "sniper")).toBe("zero snipers");
    expect(pluralize(1, "sniper")).toBe("one sniper");
    expect(pluralize(2, "sniper")).toBe("two snipers");
    expect(pluralize(3, "sniper")).toBe("three snipers");
    expect(pluralize(12, "sniper")).toBe("12 snipers");
  });

  it("never renders '1 snipers' or 'one snipers'", () => {
    const one = pluralize(1, "sniper");
    expect(one).not.toMatch(/snipers/);
    expect(one).toBe("one sniper");
  });

  it("custom plural is respected", () => {
    expect(pluralize(2, "Pass", "Pass")).toBe("two Pass");
  });

  it("numberWord spells 0-9 and passes through >=10", () => {
    expect(numberWord(0)).toBe("zero");
    expect(numberWord(1)).toBe("one");
    expect(numberWord(9)).toBe("nine");
    expect(numberWord(10)).toBe("10");
  });

  it("isAre / thereIsAre agree on count", () => {
    expect(isAre(1)).toBe("is");
    expect(isAre(2)).toBe("are");
    expect(thereIsAre(1)).toBe("there is");
    expect(thereIsAre(0)).toBe("there are");
  });
});

// ── cardSummaryScript (the CARD SUMMARY mic button) ──────────────────────────

describe("cardSummaryScript — plural/verb agreement", () => {
  it("n=1 SNIPER reads 'one sniper', never '1 snipers' or 'there are 1 sniper'", () => {
    const out = cardSummaryScript(
      card({ SNIPER: 1 }),
      stats({ sniperHits: 1, sniperCount: 1, winsHit: 1, itmHit: 1 }),
    );
    expect(out).not.toMatch(/1 snipers/i);
    expect(out).not.toMatch(/there are 1 /i);
    expect(out).not.toMatch(/\bone\b\s+\w+s\b/); // no "one <plural>"
    expect(out).toContain("one win");
    expect(out).toContain("Sniper tier: one of one.");
    expect(out).toMatchInlineSnapshot(
      `"Card complete. one race. one win, one pick in the money. Sniper tier: one of one. ROI on the day: plus 0 percent. See you tomorrow."`,
    );
  });

  it("n=0 across the board skips empty tier lines", () => {
    const out = cardSummaryScript(card({}), stats());
    expect(out).not.toMatch(/Sniper tier/);
    expect(out).not.toMatch(/Edge tier/);
    expect(out).not.toMatch(/Flag accuracy/);
    expect(out).toMatchInlineSnapshot(
      `"Card complete. zero races. zero wins, zero picks in the money. ROI on the day: plus 0 percent. See you tomorrow."`,
    );
  });

  it("n=2 wins uses plural", () => {
    const out = cardSummaryScript(
      card({ SNIPER: 2 }),
      stats({ sniperHits: 1, sniperCount: 2, winsHit: 2, itmHit: 3 }),
    );
    expect(out).toContain("two wins");
    expect(out).toContain("three picks in the money");
    expect(out).toContain("Sniper tier: one of two.");
  });

  it("n=3 flags line agrees", () => {
    const out = cardSummaryScript(
      card({ EDGE: 1 }),
      stats({ edgeHits: 1, edgeCount: 1, winsHit: 1, itmHit: 1, flagsHit: 2, flagsRaised: 3 }),
    );
    expect(out).toContain("Flag accuracy: two of three flags");
    expect(out).toContain("Edge tier: one of one.");
  });
});

// ── cardBriefingScript (morning brief tier distribution) ─────────────────────

describe("cardBriefingScript — tier distribution agreement", () => {
  it("single SNIPER is not pluralized", () => {
    const out = cardBriefingScript(card({ SNIPER: 1, EDGE: 0, PASS: 0 }));
    expect(out).not.toMatch(/1 Snipers/i);
    expect(out).toContain("one Sniper");
    expect(out).toContain("one race on the card");
  });

  it("mixed counts agree per tier", () => {
    const out = cardBriefingScript(card({ SNIPER: 2, EDGE: 1, PASS: 3 }));
    expect(out).toContain("two Snipers");
    expect(out).toContain("one Edge");
    expect(out).toContain("three Pass");
    expect(out).toContain("six races on the card");
  });

  it("no qualifying tiers falls back to 'no plays'", () => {
    const out = cardBriefingScript(card({ RECON: 2 }));
    expect(out).toContain("no plays");
  });
});

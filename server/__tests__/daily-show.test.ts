import { describe, it, expect } from "vitest";
import type { Card, CardShow, CardWithRaces, RaceWithResult } from "@shared/schema";
import {
  buildShowScript,
  OVERVIEW_WORD_BUDGET,
  RACE_WORD_BUDGET,
  raceLabel,
} from "../services/show-script";
import {
  TRACK_KEYFRAMES,
  FALLBACK_KEYFRAME,
  resolveKeyframe,
  resolveKeyframeFilename,
} from "../services/show-keyframes";
import { cardNeedsShow, boiseSevenAmUtcHour } from "../services/show-cron";

// ── Fixtures ───────────────────────────────────────────────────────────────

function race(raceNumber: number, tier: string, over: Partial<RaceWithResult> = {}): RaceWithResult {
  return {
    id: raceNumber * 10,
    cardId: 1,
    raceNumber,
    tier,
    post: "1:00 PM",
    conditions: "Alw 26500 N2L · 6F Dirt · RR 90",
    shape: "Honest pace, speed holds",
    flags: "[]",
    read: null,
    winPgm: "1",
    winName: "Test Horse",
    winScore: 92,
    placePgm: "2",
    placeName: "Second Choice",
    showPgm: "3",
    showName: "Third",
    fourthName: "Fourth",
    result: null,
    ...over,
  } as unknown as RaceWithResult;
}

function card(over: Partial<CardWithRaces> = {}, races?: RaceWithResult[]): CardWithRaces {
  return {
    id: 2,
    track: "Finger Lakes",
    date: "2026-06-08",
    cardConviction: "HIGH",
    createdAt: "2026-06-08T05:00:00.000Z",
    races: races ?? [race(1, "SNIPER"), race(2, "EDGE"), race(3, "PASS")],
    ...over,
  } as unknown as CardWithRaces;
}

function countWords(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
function segWords(lines: { text: string }[]): number {
  return lines.reduce((n, l) => n + countWords(l.text), 0);
}

// ── buildShowScript ──────────────────────────────────────────────────────────

describe("buildShowScript", () => {
  it("produces an overview + one segment per race, in race order", () => {
    const c = card({}, [race(2, "EDGE"), race(1, "SNIPER"), race(3, "PASS")]);
    const script = buildShowScript(c);
    expect(script.overview.speakerLines.length).toBeGreaterThan(0);
    expect(script.races).toHaveLength(3);
    expect(script.races.map((r) => r.raceNumber)).toEqual([1, 2, 3]);
  });

  it("alternates speakers starting with Jarvis as lead analyst", () => {
    const script = buildShowScript(card());
    expect(script.overview.speakerLines[0].speaker).toBe("jarvis");
    expect(script.overview.speakerLines[1].speaker).toBe("scarlett");
    for (const seg of script.races) {
      expect(seg.speakerLines[0].speaker).toBe("jarvis");
    }
  });

  it("respects word budgets (overview <= 60, each race <= 45)", () => {
    const manyRaces = Array.from({ length: 11 }, (_, i) =>
      race(i + 1, i % 2 === 0 ? "SNIPER" : "EDGE", {
        flags: '["VALUE GATE on #1","BOUNCE RISK on #4"]',
      }),
    );
    const script = buildShowScript(card({}, manyRaces));
    expect(segWords(script.overview.speakerLines)).toBeLessThanOrEqual(OVERVIEW_WORD_BUDGET);
    for (const seg of script.races) {
      expect(segWords(seg.speakerLines)).toBeLessThanOrEqual(RACE_WORD_BUDGET);
    }
  });

  it("never leaks '1 snipers' / '1 edges' — grammar helpers wired", () => {
    const script = buildShowScript(card({}, [race(1, "SNIPER"), race(2, "EDGE"), race(3, "PASS")]));
    const all = [
      ...script.overview.speakerLines,
      ...script.races.flatMap((r) => r.speakerLines),
    ]
      .map((l) => l.text)
      .join(" ");
    expect(all).not.toMatch(/\b1 snipers\b/i);
    expect(all).not.toMatch(/\b1 edges\b/i);
    expect(all).not.toMatch(/\bone snipers\b/i);
    // Single sniper should read "one Sniper" in the overview.
    expect(all).toMatch(/one Sniper\b/);
  });

  it("TTS-sanitizes lines — abbreviations spoken, no raw '#'", () => {
    const script = buildShowScript(card({}, [race(1, "SNIPER")]));
    const r1 = script.races[0].speakerLines.map((l) => l.text).join(" ");
    // "number 1" comes from the sanitizer rewriting "#1"; raw "#" must be gone.
    expect(r1).not.toContain("#");
  });

  it("raceLabel renders the R<n> prefix with the lead condition", () => {
    expect(raceLabel(race(1, "SNIPER", { conditions: "Alw 26500 N2L · 6F Dirt" }))).toBe(
      "R1 Alw 26500 N2L",
    );
  });
});

// ── keyframe resolver ──────────────────────────────────────────────────────

describe("track→keyframe resolver", () => {
  it("maps known tracks to their keyframe filenames", () => {
    expect(TRACK_KEYFRAMES["Saratoga"]).toBe("saratoga.png");
    expect(TRACK_KEYFRAMES["Finger Lakes"]).toBe("finger-lakes.png");
    expect(resolveKeyframeFilename("Saratoga")).toBe("saratoga.png");
  });

  it("returns the fallback filename for an unknown track without throwing", () => {
    expect(() => resolveKeyframeFilename("Belmont Park")).not.toThrow();
    expect(resolveKeyframeFilename("Belmont Park")).toBe(FALLBACK_KEYFRAME);
  });

  it("resolveKeyframe never throws on an unknown track and returns a path", () => {
    let p = "";
    expect(() => {
      p = resolveKeyframe("Some Track That Does Not Exist");
    }).not.toThrow();
    expect(p).toContain(FALLBACK_KEYFRAME);
  });
});

// ── cron staleness ──────────────────────────────────────────────────────────

function show(over: Partial<CardShow> = {}): CardShow {
  return {
    cardId: 2,
    status: "ready",
    manifestJson: JSON.stringify({
      cardId: 2,
      track: "Finger Lakes",
      generatedAt: "2026-06-08T13:00:00.000Z",
      segments: [],
    }),
    error: null,
    startedAt: "2026-06-08T12:50:00.000Z",
    completedAt: "2026-06-08T13:00:00.000Z",
    ...over,
  } as CardShow;
}

describe("cardNeedsShow", () => {
  const baseCard = { id: 2, createdAt: "2026-06-08T05:00:00.000Z" } as Card;

  it("needs a build when there is no show row", () => {
    expect(cardNeedsShow(baseCard, undefined)).toBe(true);
  });

  it("skips a card already up-to-date (ready + fresh manifest)", () => {
    expect(cardNeedsShow(baseCard, show())).toBe(false);
  });

  it("does not double-build a card currently building", () => {
    expect(cardNeedsShow(baseCard, show({ status: "building" }))).toBe(false);
  });

  it("rebuilds when the card was modified after the manifest was generated", () => {
    const stale = { ...baseCard, createdAt: "2026-06-08T20:00:00.000Z" } as Card;
    expect(cardNeedsShow(stale, show())).toBe(true);
  });

  it("rebuilds after an errored build", () => {
    expect(cardNeedsShow(baseCard, show({ status: "error", error: "boom" }))).toBe(true);
  });
});

describe("boiseSevenAmUtcHour", () => {
  it("is 13:00 UTC in summer (MDT, UTC-6)", () => {
    // July 1 — Boise observes MDT.
    expect(boiseSevenAmUtcHour(new Date("2026-07-01T12:00:00Z"))).toBe(13);
  });

  it("is 14:00 UTC in winter (MST, UTC-7)", () => {
    // January 1 — Boise observes MST.
    expect(boiseSevenAmUtcHour(new Date("2026-01-01T12:00:00Z"))).toBe(14);
  });
});

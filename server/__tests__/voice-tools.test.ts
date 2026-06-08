import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CardWithRaces, RaceWithResult } from "@shared/schema";
import {
  getCardOverview,
  getRaceDetails,
  getTopPicks,
  getHorsePedigree,
  proposeTierChange,
  summarizeCard,
  runTool,
  type ToolContext,
} from "../services/voice-tools";

// ── Mock the weather service so get_track_weather is deterministic + offline ──
vi.mock("../services/weather", () => ({
  getRaceWeather: vi.fn(async (track: string) => ({
    tempF: 71,
    feelsLikeF: 69,
    conditions: "Rain",
    precipMm: 4.2,
    windMph: 8,
    windDirDeg: 200,
    humidityPct: 80,
    surfaceImpact: "sloppy",
    fetchedAt: "2026-06-08T18:00:00.000Z",
    source: "openweather",
  })),
}));

import { getTrackWeather } from "../services/voice-tools";
import { getRaceWeather } from "../services/weather";

function race(partial: Partial<RaceWithResult> & { raceNumber: number }): RaceWithResult {
  return {
    id: partial.raceNumber * 10,
    cardId: 1,
    raceNumber: partial.raceNumber,
    tier: partial.tier ?? "EDGE",
    post: partial.post ?? "1:00 PM",
    postTimeUtc: partial.postTimeUtc ?? "2026-06-08T17:00:00.000Z",
    conditions: partial.conditions ?? "ALW 60000 6F DIRT",
    shape: partial.shape ?? null,
    read: null,
    flags: partial.flags ?? "[]",
    winPgm: partial.winPgm ?? "4",
    winName: partial.winName ?? "Tapit Trice",
    winScore: 100,
    placePgm: "2",
    placeName: "Bravo",
    placeScore: 90,
    showPgm: "7",
    showName: "Charlie",
    showScore: 80,
    fourthPgm: "1",
    fourthName: "Delta",
    fourthScore: 70,
    whyText: null,
    paceText: null,
    tierDemotedBy: null,
    weather: partial.weather ?? null,
    pedigree: partial.pedigree ?? {},
    result: null,
  } as RaceWithResult;
}

function card(): CardWithRaces {
  return {
    id: 1,
    track: "Saratoga",
    date: "2026-06-08",
    cardConviction: "HIGH",
    notes: null,
    locked: false,
    status: "active",
    archivedAt: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    races: [
      race({ raceNumber: 1, tier: "PASS", winPgm: "3", winName: "Scottish Lassie" }),
      race({
        raceNumber: 2,
        tier: "SNIPER",
        winPgm: "4",
        winName: "Tapit Trice",
        pedigree: {
          "4": {
            composite: 72,
            confidence: "high",
            applied: true,
            reasonCodes: ["sire-dirt(Tapit)"],
            sireName: "Tapit",
            damName: "Some Dam",
            damSireName: "Curlin",
          },
        },
        weather: {
          tempF: 70,
          feelsLikeF: 68,
          conditions: "Rain",
          precipMm: 5,
          windMph: 7,
          windDirDeg: 180,
          humidityPct: 85,
          surfaceImpact: "sloppy",
          fetchedAt: "2026-06-08T16:00:00.000Z",
          source: "openweather",
        },
      }),
      race({ raceNumber: 3, tier: "EDGE", winPgm: "5", winName: "Curlins Pride" }),
    ],
  } as CardWithRaces;
}

function ctx(activeRaceNumber?: number): ToolContext {
  return { card: card(), activeRaceNumber, proposals: [] };
}

describe("voice tool handlers — happy + error paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("get_card_overview returns per-race tier + post", () => {
    const out = getCardOverview({}, ctx()) as any;
    expect(out.track).toBe("Saratoga");
    expect(out.raceCount).toBe(3);
    expect(out.races[1]).toMatchObject({ raceNumber: 2, tier: "SNIPER" });
  });

  it("get_race_details returns picks + flags for a real race", () => {
    const out = getRaceDetails({ raceNumber: 2 }, ctx()) as any;
    expect(out.tier).toBe("SNIPER");
    expect(out.picks.win).toMatchObject({ pgm: "4", name: "Tapit Trice" });
    expect(out.surfaceImpact).toBe("sloppy");
  });

  it("get_race_details errors on a race not on the card", () => {
    const out = getRaceDetails({ raceNumber: 99 }, ctx()) as any;
    expect(out.error).toMatch(/not on the card/);
  });

  it("get_top_picks defaults to non-PASS plays", () => {
    const out = getTopPicks({}, ctx()) as any;
    expect(out.count).toBe(2);
    expect(out.plays.map((p: any) => p.raceNumber).sort()).toEqual([2, 3]);
  });

  it("get_top_picks filters to a tier set", () => {
    const out = getTopPicks({ tier: ["SNIPER"] }, ctx()) as any;
    expect(out.count).toBe(1);
    expect(out.plays[0].raceNumber).toBe(2);
  });

  it("get_horse_pedigree returns sire/dam + fitness composite", () => {
    const out = getHorsePedigree({ raceNumber: 2, horsePgm: "4" }, ctx()) as any;
    expect(out.sire).toBe("Tapit");
    expect(out.damSire).toBe("Curlin");
    expect(typeof out.composite).toBe("number");
    expect(["high", "medium", "low", "none"]).toContain(out.confidence);
  });

  it("get_horse_pedigree errors when no pedigree on file", () => {
    const out = getHorsePedigree({ raceNumber: 1, horsePgm: "9" }, ctx()) as any;
    expect(out.error).toMatch(/No pedigree/);
  });

  it("propose_tier_change records a proposal with the current old tier", () => {
    const c = ctx();
    const out = proposeTierChange(
      { raceNumber: 2, horsePgm: "4", newTier: "EDGE", reason: "speed scratched" },
      c,
    ) as any;
    expect(out.ok).toBe(true);
    expect(c.proposals).toHaveLength(1);
    expect(c.proposals[0]).toMatchObject({
      race_number: 2,
      old_tier: "SNIPER",
      new_tier: "EDGE",
    });
  });

  it("propose_tier_change errors on unknown tier", () => {
    const out = proposeTierChange(
      { raceNumber: 2, newTier: "ZULU", reason: "x" },
      ctx(),
    ) as any;
    expect(out.error).toMatch(/Unknown tier/);
  });

  it("summarize_card returns tier counts + headline plays", () => {
    const out = summarizeCard({}, ctx()) as any;
    expect(out.tierCounts.SNIPER).toBe(1);
    expect(out.headlinePlays.map((p: any) => p.raceNumber)).toContain(2);
  });

  it("get_track_weather reuses getRaceWeather and resolves nearest race", async () => {
    const out = (await getTrackWeather({}, ctx(2))) as any;
    expect(getRaceWeather).toHaveBeenCalledOnce();
    expect(out.surfaceImpact).toBe("sloppy");
    expect(out.raceNumber).toBe(2);
  });

  it("runTool dispatches by name and unknown tool errors", async () => {
    const out = (await runTool("get_card_overview", {}, ctx())) as any;
    expect(out.track).toBe("Saratoga");
    const bad = (await runTool("nope", {}, ctx())) as any;
    expect(bad.error).toMatch(/Unknown tool/);
  });
});

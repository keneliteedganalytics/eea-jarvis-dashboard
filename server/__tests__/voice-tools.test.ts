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
  getPnlToday,
  getLifetimeStats,
  getAnalyticsSummary,
  getTierPerformance,
  getTrackRecord,
  getCardDetails,
  getPostmortems,
  getBiasToday,
  getOtbFingerLakesStatus,
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

// ── Mocks for PR #23 Q&A handlers (offline + deterministic) ──────────────────
vi.mock("../analytics", () => ({
  buildAnalyticsSummary: vi.fn(() => ({
    totalCards: 2,
    totalRaces: 18,
    gradedRaces: 10,
    avgWinPct: 40,
    roi: 12,
    bestTier: "SNIPER",
    tierHitRates: [
      { tier: "SNIPER", win: 55, place: 70, show: 80, itm: 60 },
      { tier: "EDGE", win: 35, place: 55, show: 70, itm: 50 },
    ],
    bankrollCurve: [{ label: "Start", cumulative: 0 }],
    flagAccuracy: [{ flag: "BOUNCE RISK", pct: 50 }],
    raceTypePerf: [{ type: "Allowance", winPct: 44 }],
  })),
  buildLifetimeStats: vi.fn(() => ({
    totals: { cards: 5, races: 45, graded: 30, win: 38, place: 55, show: 68, itm: 62 },
    byTrack: [
      { track: "Finger Lakes", cards: 3, races: 27, graded: 18, win: 40, itm: 64, lastUpdated: "2026-06-08" },
      { track: "Saratoga", cards: 2, races: 18, graded: 12, win: 35, itm: 58, lastUpdated: "2026-06-07" },
    ],
  })),
  buildTrackRecordSummary: vi.fn(() => ({
    timeframe: "ALL",
    wins: 11,
    plays: 30,
    winPct: 37,
    units: 6.5,
    roi: 21.7,
    tiers: [],
    generatedAt: "2026-06-08T18:00:00.000Z",
  })),
}));

vi.mock("../services/bias-fetcher", () => ({
  getOrFetchBias: vi.fn(async (track: string, date: string) => ({
    track,
    date,
    racesAnalyzed: 8,
    postPos: {},
    runStyleBias: "speed",
    railBias: "good",
    narrative: "Inside speed dominated yesterday at the Spa.",
  })),
}));

vi.mock("../services/otb-finger-lakes", () => ({
  fetchOtbFingerLakes: vi.fn(async () => ({
    date: "2026-06-08",
    scratches: [{ race: 3, program: "7", horse: "Late Mover" }],
    conditions: { surface: "Dirt", condition: "Fast" },
    results: [{ race: 1, finishers: [{ pos: 1, program: "4", horse: "Tapit Trice" }] }],
    payouts: [],
    purses: [],
    fetchedAt: "2026-06-08T18:00:00.000Z",
  })),
}));

const cardsStore: any[] = [];
vi.mock("../storage", () => ({
  storage: {
    getCards: vi.fn(() => cardsStore.map((c) => ({ id: c.id, track: c.track, date: c.date }))),
    getCardWithRaces: vi.fn((id: number) => cardsStore.find((c) => c.id === id)),
    getLatestCard: vi.fn(() => cardsStore.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0]),
  },
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

// ── PR #23 Q&A handler smoke tests (mocked analytics/storage/bias/OTB) ────────
import { storage } from "../storage";

function gradedRace(n: number, opts: { tier: string; winHit: boolean; winPayout?: number; result?: boolean }) {
  return {
    raceNumber: n,
    tier: opts.tier,
    post: "1:00 PM",
    conditions: "ALW 60000 6F DIRT",
    winPgm: "4",
    winName: "Tapit Trice",
    flags: "[]",
    result: opts.result === false ? null : {
      winHit: opts.winHit,
      itmCount: opts.winHit ? 4 : 0,
      winPayout: opts.winPayout ?? null,
    },
  };
}

describe("PR #23 Q&A handlers — shape + offline", () => {
  const today = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    vi.clearAllMocks();
    // Seed the mocked storage with a graded card dated today + an older card.
    (storage.getCards as any).mockReturnValue([
      { id: 1, track: "Finger Lakes", date: today },
      { id: 2, track: "Saratoga", date: "2026-06-01" },
    ]);
    (storage.getCardWithRaces as any).mockImplementation((id: number) => {
      if (id === 1) {
        return {
          id: 1,
          track: "Finger Lakes",
          date: today,
          status: "active",
          cardConviction: "HIGH",
          races: [
            gradedRace(1, { tier: "SNIPER", winHit: true, winPayout: 8.4 }),
            gradedRace(2, { tier: "EDGE", winHit: false }),
            gradedRace(3, { tier: "DUAL", winHit: false, result: false }), // pending
          ],
        };
      }
      if (id === 2) {
        return {
          id: 2,
          track: "Saratoga",
          date: "2026-06-01",
          status: "archived",
          cardConviction: "MEDIUM",
          races: [gradedRace(1, { tier: "SNIPER", winHit: true, winPayout: 6.0 })],
        };
      }
      return undefined;
    });
    (storage.getLatestCard as any).mockReturnValue({
      id: 1,
      track: "Finger Lakes",
      date: today,
      status: "active",
      cardConviction: "HIGH",
      races: [gradedRace(1, { tier: "SNIPER", winHit: true, winPayout: 8.4 })],
    });
  });

  it("get_pnl_today aggregates today's graded + pending and computes ROI", () => {
    const out = getPnlToday({}, ctx()) as any;
    expect(out.date).toBe(today);
    expect(out.gradedToday).toBe(2); // races 1 & 2 graded
    expect(out.pendingToday).toBe(1); // race 3 pending, non-PASS
    expect(out.wins).toBe(1);
    expect(typeof out.units).toBe("number");
    expect(typeof out.roiPct).toBe("number");
  });

  it("get_lifetime_stats returns totals + byTrack", () => {
    const out = getLifetimeStats({}, ctx()) as any;
    expect(out.totals.cards).toBe(5);
    expect(out.byTrack[0].track).toBe("Finger Lakes");
  });

  it("get_analytics_summary returns tier hit rates + roi + bestTier", () => {
    const out = getAnalyticsSummary({}, ctx()) as any;
    expect(out.roi).toBe(12);
    expect(out.bestTier).toBe("SNIPER");
    expect(out.tierHitRates).toHaveLength(2);
  });

  it("get_tier_performance filters to a single tier", () => {
    const out = getTierPerformance({ tier: "SNIPER" }, ctx()) as any;
    expect(out.tier).toBe("SNIPER");
    expect(out.hitRates).toMatchObject({ win: 55 });
  });

  it("get_tier_performance returns all tiers when none given", () => {
    const out = getTierPerformance({}, ctx()) as any;
    expect(out.tiers).toHaveLength(2);
  });

  it("get_track_record returns aggregate totals + top tracks", () => {
    const out = getTrackRecord({}, ctx()) as any;
    expect(out.cards).toBe(5);
    expect(out.topTracks[0].track).toBe("Finger Lakes");
  });

  it("get_card_details resolves by track fuzzy match", () => {
    const out = getCardDetails({ track: "finger" }, ctx()) as any;
    expect(out.track).toBe("Finger Lakes");
    expect(out.raceCount).toBe(3);
    expect(out.races[0]).toMatchObject({ raceNumber: 1, tier: "SNIPER" });
  });

  it("get_card_details resolves by cardId", () => {
    const out = getCardDetails({ cardId: 2 }, ctx()) as any;
    expect(out.track).toBe("Saratoga");
    expect(out.status).toBe("archived");
  });

  it("get_postmortems summarizes a graded card's hits/misses", () => {
    const out = getPostmortems({ cardId: 1 }, ctx()) as any;
    expect(out.gradedRaces).toBe(2);
    expect(out.wins).toBe(1);
    expect(out.hits[0]).toMatchObject({ raceNumber: 1, name: "Tapit Trice" });
  });

  it("get_bias_today returns the bias read for the active card's track", async () => {
    const out = (await getBiasToday({}, ctx())) as any;
    expect(out.track).toBe("Saratoga"); // ctx() card is Saratoga
    expect(out.railBias).toBe("good");
    expect(out.narrative).toMatch(/speed/i);
  });

  it("get_otb_finger_lakes_status returns scratches + conditions", async () => {
    const out = (await getOtbFingerLakesStatus({}, ctx())) as any;
    expect(out.available).toBe(true);
    expect(out.scratches[0]).toMatchObject({ race: 3, program: "7" });
    expect(out.conditions).toMatchObject({ surface: "Dirt" });
  });

  it("runTool dispatches the new Q&A tools", async () => {
    const pnl = (await runTool("get_pnl_today", {}, ctx())) as any;
    expect(pnl.date).toBe(today);
    const otb = (await runTool("get_otb_finger_lakes_status", {}, ctx())) as any;
    expect(otb.available).toBe(true);
  });
});

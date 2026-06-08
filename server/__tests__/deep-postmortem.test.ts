import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  CardWithRaces,
  RaceWithResult,
  Prediction,
  Result,
  DeepPostmortem,
} from "@shared/schema";

// ── In-memory storage mock ───────────────────────────────────────────────────
// The analyzer reads getCardWithRaces / getCards / getPredictionsByRace and
// writes via upsertDeepPostmortem / getDeepPostmortem. We back the upsert with a
// real Map so the idempotency assertion (re-run overwrites, one row) is genuine.
const cardsStore: CardWithRaces[] = [];
const predsByRace = new Map<number, Prediction[]>();
const pmStore = new Map<number, DeepPostmortem>();
let upsertCount = 0;

vi.mock("../storage", () => ({
  storage: {
    getCards: vi.fn(() => cardsStore.map((c) => ({ id: c.id, track: c.track, date: c.date }))),
    getCardWithRaces: vi.fn((id: number) => cardsStore.find((c) => c.id === id)),
    getPredictionsByRace: vi.fn((raceId: number) => predsByRace.get(raceId) ?? []),
    upsertDeepPostmortem: vi.fn((cardId: number, payload: DeepPostmortem) => {
      upsertCount += 1;
      pmStore.set(cardId, payload);
      return { id: 1, cardId, generatedAt: payload.generatedAt, payload: JSON.stringify(payload) };
    }),
    getDeepPostmortem: vi.fn((cardId: number) => pmStore.get(cardId) ?? null),
  },
}));

import {
  runDeepPostmortem,
  runDeepPostmortemToday,
  getDeepPostmortem,
  type PostmortemNarrator,
  type NarratorInput,
} from "../services/deep-postmortem";

// Deterministic narrator: passthrough details + a fixed lesson, so tests never
// touch a live LLM. Records the input it received for assertions.
let lastNarratorInput: NarratorInput | null = null;
const testNarrator: PostmortemNarrator = {
  async narrate(input) {
    lastNarratorInput = input;
    const raceSignalDetails: Record<number, string[]> = {};
    for (const r of input.races) {
      raceSignalDetails[r.raceNumber] = r.rawSignals.map((s) => `LLM: ${s.detail}`);
    }
    return { raceSignalDetails, lessons: ["Tighten SNIPER discipline on dirt routes."] };
  },
};

function result(partial: Partial<Result> & { finishOrder: string }): Result {
  return {
    id: 1,
    raceId: 0,
    finishOrder: partial.finishOrder,
    winHit: partial.winHit ?? null,
    placeHit: partial.placeHit ?? null,
    showHit: partial.showHit ?? null,
    fourthHit: partial.fourthHit ?? null,
    itmCount: partial.itmCount ?? null,
    exactaHit: null,
    trifectaHit: null,
    superfectaHit: null,
    flagsHit: "[]",
    winPayout: partial.winPayout ?? null,
    placePayout: null,
    showPayout: null,
    exactaPayout: null,
    trifectaPayout: null,
    superfectaPayout: null,
    autoFetched: 0,
    payoutsRaw: null,
    loggedAt: "2026-06-07T22:00:00.000Z",
  } as Result;
}

function race(partial: Partial<RaceWithResult> & { raceNumber: number }): RaceWithResult {
  const id = partial.raceNumber * 10;
  return {
    id,
    cardId: 1,
    raceNumber: partial.raceNumber,
    tier: partial.tier ?? "EDGE",
    post: "1:00 PM",
    postTimeUtc: "2026-06-07T17:00:00.000Z",
    conditions: "ALW 60000 6F DIRT",
    shape: partial.shape ?? null,
    read: null,
    flags: partial.flags ?? "[]",
    winPgm: partial.winPgm ?? "4",
    winName: partial.winName ?? "Our Pick",
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
    result: partial.result ?? null,
  } as RaceWithResult;
}

function seedCard(card: CardWithRaces, predsList: Record<number, Prediction[]> = {}) {
  cardsStore.length = 0;
  predsByRace.clear();
  pmStore.clear();
  upsertCount = 0;
  lastNarratorInput = null;
  cardsStore.push(card);
  for (const [raceId, list] of Object.entries(predsList)) {
    predsByRace.set(Number(raceId), list);
  }
}

function pred(partial: Partial<Prediction> & { horsePgm: string; raceId: number }): Prediction {
  return {
    id: Math.random(),
    raceId: partial.raceId,
    horsePgm: partial.horsePgm,
    horseName: partial.horseName ?? `Horse ${partial.horsePgm}`,
    eeas: partial.eeas ?? null,
    eeap: partial.eeap ?? null,
    eeac: partial.eeac ?? null,
    eeaRating: partial.eeaRating ?? null,
    tierAssigned: partial.tierAssigned ?? "PASS",
    rank: partial.rank ?? null,
    llmReasoning: partial.llmReasoning ?? null,
    personaVersion: null,
    figureWeightsJson: null,
    biasContextJson: partial.biasContextJson ?? null,
    bloodstockJson: partial.bloodstockJson ?? null,
    scratched: partial.scratched ?? false,
    scratchedAt: partial.scratchedAt ?? null,
    llmProvider: null,
    llmModel: null,
    createdAt: new Date("2026-06-07T12:00:00.000Z"),
  } as Prediction;
}

describe("deep-postmortem analyzer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces a structured report for a graded card", async () => {
    seedCard({
      id: 1,
      track: "Saratoga",
      date: "2026-06-07",
      cardConviction: "HIGH",
      notes: null,
      locked: true,
      status: "active",
      archivedAt: null,
      createdAt: "2026-06-07T00:00:00.000Z",
      races: [
        race({
          raceNumber: 1,
          tier: "SNIPER",
          winPgm: "2",
          winName: "Our Pick",
          result: result({ finishOrder: "[\"2\",\"1\",\"7\",\"5\"]", winHit: 1, itmCount: 1, winPayout: 6.4 }),
        }),
      ],
    } as CardWithRaces);

    const report = await runDeepPostmortem(1, { narrator: testNarrator });
    expect(report.cardId).toBe(1);
    expect(report.track).toBe("Saratoga");
    expect(report.summary.graded).toBe(1);
    expect(report.races).toHaveLength(1);
    expect(report.races[0].outcome).toBe("hit");
    expect(report.lessons.length).toBeGreaterThan(0);
  });

  it("hindsight identifies a winner that was NOT our top pick / not top tier", async () => {
    const r1 = race({
      raceNumber: 1,
      tier: "SNIPER",
      winPgm: "2",
      winName: "Our Favorite",
      // Actual winner is #5, whom we ranked low.
      result: result({ finishOrder: "[\"5\",\"2\",\"1\",\"7\"]", winHit: 0, placeHit: 1, itmCount: 1 }),
    });
    seedCard(
      {
        id: 1,
        track: "Saratoga",
        date: "2026-06-07",
        cardConviction: "HIGH",
        notes: null,
        locked: true,
        status: "active",
        archivedAt: null,
        createdAt: "2026-06-07T00:00:00.000Z",
        races: [r1],
      } as CardWithRaces,
      {
        10: [
          pred({ raceId: 10, horsePgm: "2", horseName: "Our Favorite", tierAssigned: "SNIPER", rank: 1, eeaRating: 92 }),
          pred({ raceId: 10, horsePgm: "5", horseName: "The Winner", tierAssigned: "RECON", rank: 4, eeaRating: 71 }),
        ],
      },
    );

    const report = await runDeepPostmortem(1, { narrator: testNarrator });
    const pm = report.races[0];
    expect(pm.outcome).toBe("place");
    expect(pm.actualWinner.programNumber).toBe(5);
    expect(pm.ourTopPick.runner).toContain("Our Favorite");
    expect(pm.hindsightAnalysis.winnerWasInPool).toBe(true);
    expect(pm.hindsightAnalysis.winnerTier).toBe("RECON");
    // The winner sat outside our top tier — there must be at least one visible signal.
    expect(pm.hindsightAnalysis.visibleSignals.length).toBeGreaterThan(0);
  });

  it("re-running overwrites (idempotent — one stored row per card)", async () => {
    seedCard({
      id: 1,
      track: "Saratoga",
      date: "2026-06-07",
      cardConviction: "HIGH",
      notes: null,
      locked: true,
      status: "active",
      archivedAt: null,
      createdAt: "2026-06-07T00:00:00.000Z",
      races: [
        race({
          raceNumber: 1,
          tier: "EDGE",
          result: result({ finishOrder: "[\"4\",\"2\",\"7\"]", winHit: 1, itmCount: 1 }),
        }),
      ],
    } as CardWithRaces);

    await runDeepPostmortem(1, { narrator: testNarrator });
    await runDeepPostmortem(1, { narrator: testNarrator });
    expect(upsertCount).toBe(2);
    expect(pmStore.size).toBe(1);
    const saved = getDeepPostmortem(1);
    expect(saved).not.toBeNull();
    expect(saved?.cardId).toBe(1);
  });

  it("the narrator sees the brutally-objective signal dump (winner not in pool)", async () => {
    seedCard({
      id: 1,
      track: "Saratoga",
      date: "2026-06-07",
      cardConviction: "HIGH",
      notes: null,
      locked: true,
      status: "active",
      archivedAt: null,
      createdAt: "2026-06-07T00:00:00.000Z",
      races: [
        race({
          raceNumber: 1,
          tier: "SNIPER",
          winPgm: "2",
          winName: "Our Pick",
          // Winner #9 is not among our flattened picks (2/2/7/1) → not in pool.
          result: result({ finishOrder: "[\"9\",\"2\",\"7\"]", winHit: 0, itmCount: 0 }),
        }),
      ],
    } as CardWithRaces);

    await runDeepPostmortem(1, { narrator: testNarrator });
    expect(lastNarratorInput).not.toBeNull();
    expect(lastNarratorInput?.races[0].winnerWasInPool).toBe(false);
  });

  it("runDeepPostmortemToday analyzes only graded cards dated today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedCard({
      id: 7,
      track: "Finger Lakes",
      date: today,
      cardConviction: "MED",
      notes: null,
      locked: true,
      status: "active",
      archivedAt: null,
      createdAt: `${today}T00:00:00.000Z`,
      races: [
        race({
          raceNumber: 1,
          tier: "EDGE",
          result: result({ finishOrder: "[\"4\",\"2\"]", winHit: 1, itmCount: 1 }),
        }),
      ],
    } as CardWithRaces);

    const reports = await runDeepPostmortemToday({ narrator: testNarrator });
    expect(reports).toHaveLength(1);
    expect(reports[0].cardId).toBe(7);
  });

  it("getDeepPostmortem returns null before a run", () => {
    pmStore.clear();
    expect(getDeepPostmortem(999)).toBeNull();
  });
});

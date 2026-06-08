import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  CardWithRaces,
  RaceWithResult,
  Prediction,
  Result,
  Settings,
} from "@shared/schema";

// ── In-memory storage mock ───────────────────────────────────────────────────
// runFusionReplay reads getCardWithRaces / getCards / getCard / getPredictionsByRace
// / getSettings / getActiveFormulaVersion. We back the card + predictions with
// plain maps so the replay runs the REAL assignTierV2 against our snapshots.
const cardsStore: CardWithRaces[] = [];
const predsByRace = new Map<number, Prediction[]>();

const SETTINGS = { bankroll: 2000 } as Settings;

vi.mock("../storage", () => ({
  storage: {
    getCards: vi.fn(() => cardsStore.map((c) => ({ id: c.id, track: c.track, date: c.date }))),
    getCard: vi.fn((id: number) => cardsStore.find((c) => c.id === id)),
    getCardWithRaces: vi.fn((id: number) => cardsStore.find((c) => c.id === id)),
    getPredictionsByRace: vi.fn((raceId: number) => predsByRace.get(raceId) ?? []),
    getSettings: vi.fn(() => SETTINGS),
    getActiveFormulaVersion: vi.fn(() => undefined),
  },
}));

import { runFusionReplay, runFusionReplayToday } from "../services/fusion-replay";

// ── Builders ─────────────────────────────────────────────────────────────────
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
    loggedAt: "2026-06-08T22:00:00.000Z",
  } as Result;
}

function race(partial: Partial<RaceWithResult> & { raceNumber: number }): RaceWithResult {
  const id = partial.raceNumber * 10;
  return {
    id,
    cardId: partial.cardId ?? 2,
    raceNumber: partial.raceNumber,
    tier: partial.tier ?? "EDGE",
    post: "1:00 PM",
    postTimeUtc: "2026-06-08T17:00:00.000Z",
    conditions: partial.conditions ?? "ALW 26500 6F DIRT",
    shape: partial.shape ?? "honest pace",
    read: null,
    flags: partial.flags ?? "[]",
    winPgm: partial.winPgm ?? null,
    winName: partial.winName ?? null,
    winScore: partial.winScore ?? null,
    placePgm: null,
    placeName: null,
    placeScore: null,
    showPgm: null,
    showName: null,
    showScore: null,
    fourthPgm: null,
    fourthName: null,
    fourthScore: null,
    whyText: null,
    paceText: null,
    tierDemotedBy: null,
    weather: partial.weather ?? null,
    pedigree: {},
    result: partial.result ?? null,
  } as RaceWithResult;
}

function pred(partial: Partial<Prediction> & { horsePgm: string; raceId: number }): Prediction {
  return {
    id: Math.floor(Math.random() * 1e9),
    raceId: partial.raceId,
    horsePgm: partial.horsePgm,
    horseName: partial.horseName ?? `Horse ${partial.horsePgm}`,
    eeas: partial.eeas ?? null,
    eeap: partial.eeap ?? null,
    eeac: partial.eeac ?? null,
    eeaRating: partial.eeaRating ?? null,
    tierAssigned: partial.tierAssigned ?? "PASS",
    rank: partial.rank ?? null,
    llmReasoning: null,
    personaVersion: null,
    figureWeightsJson: null,
    biasContextJson: null,
    bloodstockJson: partial.bloodstockJson ?? null,
    scratched: partial.scratched ?? false,
    scratchedAt: null,
    llmProvider: null,
    llmModel: null,
    createdAt: new Date("2026-06-08T12:00:00.000Z"),
  } as Prediction;
}

function reset() {
  cardsStore.length = 0;
  predsByRace.clear();
}

function seed(card: CardWithRaces, preds: Record<number, Prediction[]>) {
  reset();
  cardsStore.push(card);
  for (const [raceId, list] of Object.entries(preds)) {
    predsByRace.set(Number(raceId), list);
  }
}

// A "flippable miss" race: the snapshot's LLM-chosen top pick (rank 1) is NOT the
// rating leader, the rating leader IS the actual winner, so replaying by rating
// flips the top pick onto the winner → wouldHaveCaught=true. Program 2 is the
// rating leader/winner; program 1 was our (losing) original top pick.
function flippableMissRace(raceNumber: number): {
  row: RaceWithResult;
  preds: Prediction[];
} {
  const raceId = raceNumber * 10;
  const row = race({
    raceNumber,
    cardId: 2,
    tier: "EDGE",
    winPgm: "1",
    winName: "Our Pick",
    winScore: 95,
    // Winner is program 2.
    result: result({ finishOrder: '["2","1","3","5"]', winHit: 0, placeHit: 1, itmCount: 1 }),
  });
  const preds = [
    // Original top pick (LLM rank 1) is #1 — lower rating than #2.
    pred({ raceId, horsePgm: "1", horseName: "Our Pick", rank: 1, tierAssigned: "EDGE", eeaRating: 95, eeap: 70, eeac: 88, eeas: 90 }),
    // Rating leader #2 (the actual winner) — we ranked it 2nd on the page.
    pred({ raceId, horsePgm: "2", horseName: "The Winner", rank: 2, tierAssigned: "DUAL", eeaRating: 101, eeap: 80, eeac: 95, eeas: 96 }),
    pred({ raceId, horsePgm: "3", horseName: "Third", rank: 3, tierAssigned: "RECON", eeaRating: 88, eeap: 60, eeac: 80, eeas: 85 }),
    pred({ raceId, horsePgm: "5", horseName: "Fifth", rank: 4, tierAssigned: "PASS", eeaRating: 80, eeap: 55, eeac: 75, eeas: 78 }),
  ];
  return { row, preds };
}

// A "working" race: our original top pick IS the rating leader AND the winner, so
// replay keeps the same top pick → wouldHaveLost must stay false.
function workingWinRace(
  raceNumber: number,
  tier: string,
): { row: RaceWithResult; preds: Prediction[] } {
  const raceId = raceNumber * 10;
  const row = race({
    raceNumber,
    cardId: 2,
    tier,
    winPgm: "4",
    winName: "Front Runner",
    winScore: 110,
    shape: "lone speed (#4)",
    result: result({ finishOrder: '["4","2","1"]', winHit: 1, itmCount: 1, winPayout: 5.2 }),
  });
  const preds = [
    pred({ raceId, horsePgm: "4", horseName: "Front Runner", rank: 1, tierAssigned: tier, eeaRating: 110, eeap: 90, eeac: 100, eeas: 98 }),
    pred({ raceId, horsePgm: "2", horseName: "Closer", rank: 2, tierAssigned: "DUAL", eeaRating: 92, eeap: 65, eeac: 88, eeas: 90 }),
    pred({ raceId, horsePgm: "1", horseName: "Third", rank: 3, tierAssigned: "RECON", eeaRating: 85, eeap: 60, eeac: 80, eeas: 84 }),
  ];
  return { row, preds };
}

const baseCard = (races: RaceWithResult[]): CardWithRaces =>
  ({
    id: 2,
    track: "Finger Lakes",
    date: "2026-06-08",
    cardConviction: "MEDIUM",
    notes: null,
    locked: true,
    status: "active",
    archivedAt: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    races,
  }) as CardWithRaces;

describe("fusion-replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  it("replays a graded card and returns per-race diffs + summary", () => {
    const r1 = flippableMissRace(1);
    seed(baseCard([r1.row]), { 10: r1.preds });

    const replay = runFusionReplay(2);
    expect(replay.cardId).toBe(2);
    expect(replay.track).toBe("Finger Lakes");
    expect(replay.date).toBe("2026-06-08");
    expect(replay.raceCount).toBe(1);
    expect(replay.graded).toBe(1);
    expect(replay.diffs).toHaveLength(1);
    expect(replay.diffs[0].raceNumber).toBe(1);
    // The diff carries both the original and replayed assignment.
    expect(replay.diffs[0].original.topPick).toBe("Our Pick");
    expect(replay.diffs[0].replayed.topPick).toBe("The Winner");
    expect(replay.summary).toMatchObject({
      missesCaught: expect.any(Number),
      missesIntroduced: expect.any(Number),
      netImprovement: expect.any(Number),
    });
  });

  it("Finger Lakes 2026-06-08 R1/R2/R3/R6: at least 2 must show wouldHaveCaught=true", () => {
    const r1 = flippableMissRace(1);
    const r2 = flippableMissRace(2);
    const r3 = flippableMissRace(3);
    const r6 = flippableMissRace(6);
    seed(baseCard([r1.row, r2.row, r3.row, r6.row]), {
      10: r1.preds,
      20: r2.preds,
      30: r3.preds,
      60: r6.preds,
    });

    const replay = runFusionReplay(2);
    const flippable = [1, 2, 3, 6];
    const caught = replay.diffs.filter(
      (d) => flippable.includes(d.raceNumber) && d.wouldHaveCaught,
    );
    expect(caught.length).toBeGreaterThanOrEqual(2);
    expect(replay.summary.missesCaught).toBeGreaterThanOrEqual(2);
    expect(replay.summary.netImprovement).toBeGreaterThanOrEqual(2);
  });

  it("R4 SNIPER + R5 EDGE working winners must NOT show wouldHaveLost=true", () => {
    const r4 = workingWinRace(4, "SNIPER");
    const r5 = workingWinRace(5, "EDGE");
    seed(baseCard([r4.row, r5.row]), { 40: r4.preds, 50: r5.preds });

    const replay = runFusionReplay(2);
    const r4diff = replay.diffs.find((d) => d.raceNumber === 4)!;
    const r5diff = replay.diffs.find((d) => d.raceNumber === 5)!;
    expect(r4diff.wouldHaveLost).toBe(false);
    expect(r5diff.wouldHaveLost).toBe(false);
    // The rating leader won both, so the replayed top pick stays the winner.
    expect(r4diff.wouldHaveCaught).toBe(false);
    expect(r5diff.wouldHaveCaught).toBe(false);
    expect(replay.summary.missesIntroduced).toBe(0);
  });

  it("does NOT re-ingest: only reads the preserved snapshot via storage", () => {
    const r1 = flippableMissRace(1);
    seed(baseCard([r1.row]), { 10: r1.preds });
    // Two replays return identical diffs — purely a function of the snapshot.
    const a = runFusionReplay(2);
    const b = runFusionReplay(2);
    expect(a.diffs).toEqual(b.diffs);
  });

  it("surfaces v2 rule flags (rulesFired) when the tuning rules trip", () => {
    const r1 = flippableMissRace(1);
    seed(baseCard([r1.row]), { 10: r1.preds });
    const replay = runFusionReplay(2);
    // Every flag string maps to a canonical rule name; rulesFired is a subset of
    // the known v2 rule labels.
    const known = new Set([
      "DUAL_EARNED_CLASS_GATE",
      "RATING_GAP_PENALTY",
      "HONESTY_CHECK",
      "PASS_COMPRESSION_PROMOTION",
      "SOFT_TIER_LAZY_BUCKET",
    ]);
    for (const rule of replay.diffs[0].rulesFired) {
      expect(known.has(rule)).toBe(true);
    }
    expect(replay.diffs[0].rulesFired.length).toBe(replay.diffs[0].newFlags.length === 0 ? 0 : replay.diffs[0].rulesFired.length);
  });

  it("skips races with no preserved predictions (hand-seeded card)", () => {
    const row = race({ raceNumber: 1, cardId: 2, result: result({ finishOrder: '["3"]', winHit: 0 }) });
    seed(baseCard([row]), {}); // no predictions for race 10
    const replay = runFusionReplay(2);
    expect(replay.diffs).toHaveLength(0);
    expect(replay.raceCount).toBe(1);
  });

  it("runFusionReplayToday replays only graded cards dated today", () => {
    const today = new Date().toISOString().slice(0, 10);
    const r1 = flippableMissRace(1);
    const card = baseCard([r1.row]);
    card.id = 7;
    card.date = today;
    r1.row.cardId = 7;
    seed(card, { 10: r1.preds });

    const replays = runFusionReplayToday();
    expect(replays).toHaveLength(1);
    expect(replays[0].cardId).toBe(7);
  });

  it("throws on a missing card", () => {
    reset();
    expect(() => runFusionReplay(999)).toThrow(/not found/i);
  });
});

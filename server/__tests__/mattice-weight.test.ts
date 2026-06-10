import { describe, it, expect } from "vitest";
import {
  computeStats,
  evaluatePhase,
  phaseLabel,
  PHASE_TIEBREAK,
  PHASE_BLEND_30,
  PHASE_BLEND_50,
  PHASE_MATTICE_WEIGHT,
} from "../services/mattice-weight";
import type { MatticePrediction, MatticeStats } from "@shared/schema";

// Build a graded prediction row.
let idc = 0;
function pred(over: Partial<MatticePrediction> = {}): MatticePrediction {
  return {
    id: ++idc,
    cardId: 1,
    raceId: 1,
    programNumber: "1",
    horseName: "H",
    matticeScore: 50,
    vetoFlag: false,
    factorPace: 10,
    factorSpeed: 10,
    factorClass: 10,
    factorConnections: 10,
    factorForm: 10,
    evidenceJson: "{}",
    isSystemPick: false,
    isMatticeTop: false,
    source: "deterministic",
    predictedAt: "2026-06-10T00:00:00Z",
    actualFinish: 1,
    won: true,
    inMoney: true,
    gradedAt: "2026-06-10T01:00:00Z",
    ...over,
  } as MatticePrediction;
}

// Generate N graded races, each with a system pick + a mattice top pick.
function makeRaces(opts: {
  n: number;
  matticeWins: number;
  systemWins: number;
  payout?: number; // win mutuel on a $2 bet for the winning mattice top
}): { predictions: MatticePrediction[]; payoutByKey: Map<string, number> } {
  const predictions: MatticePrediction[] = [];
  const payoutByKey = new Map<string, number>();
  for (let r = 1; r <= opts.n; r++) {
    const mWon = r <= opts.matticeWins;
    const sWon = r <= opts.systemWins;
    predictions.push(
      pred({
        raceId: r,
        programNumber: "1",
        isMatticeTop: true,
        won: mWon,
        actualFinish: mWon ? 1 : 5,
      }),
    );
    predictions.push(
      pred({
        raceId: r,
        programNumber: "2",
        isSystemPick: true,
        won: sWon,
        actualFinish: sWon ? 1 : 5,
      }),
    );
    if (mWon && opts.payout != null) payoutByKey.set(`${r}:1`, opts.payout);
  }
  return { predictions, payoutByKey };
}

const cfg = { weightPhase: PHASE_TIEBREAK, phaseChangedAt: null, phaseReason: null };

describe("computeStats", () => {
  it("counts distinct graded races as N", () => {
    const { predictions } = makeRaces({ n: 10, matticeWins: 3, systemWins: 2 });
    const stats = computeStats(predictions, cfg);
    expect(stats.n).toBe(10);
    expect(stats.matticeTopPlays).toBe(10);
    expect(stats.matticeTopWins).toBe(3);
    expect(stats.systemPickWins).toBe(2);
  });

  it("ignores ungraded predictions", () => {
    const graded = makeRaces({ n: 5, matticeWins: 1, systemWins: 1 }).predictions;
    const ungraded = [pred({ raceId: 99, gradedAt: null, actualFinish: null })];
    const stats = computeStats([...graded, ...ungraded], cfg);
    expect(stats.n).toBe(5);
  });

  it("ROI uses payout when present, break-even when absent", () => {
    // 1 win out of 10 plays, $2 stake each = $20 staked. Win pays $10 → returned 10.
    const { predictions, payoutByKey } = makeRaces({
      n: 10,
      matticeWins: 1,
      systemWins: 1,
      payout: 10,
    });
    const stats = computeStats(predictions, { ...cfg, payoutByKey });
    // returned 10, staked 20 → ROI -50%.
    expect(stats.roiPct).toBeCloseTo(-50, 5);

    // No payout map → win valued at the $2 stake → returned 2, staked 20 → -90%.
    const noPay = computeStats(predictions, cfg);
    expect(noPay.roiPct).toBeCloseTo(-90, 5);
  });
});

describe("evaluatePhase thresholds", () => {
  it("Phase 1 → 2 when N≥30, mattice top% > system%, ROI > -5%", () => {
    // 30 races, mattice 12 wins (40%), system 9 wins (30%), payout 6 → ROI?
    // 12 wins * $6 = 72 returned, 30 * $2 = 60 staked → +20% ROI.
    const { predictions, payoutByKey } = makeRaces({
      n: 30,
      matticeWins: 12,
      systemWins: 9,
      payout: 6,
    });
    const stats = computeStats(predictions, { ...cfg, payoutByKey });
    const r = evaluatePhase(PHASE_TIEBREAK, stats);
    expect(r.phase).toBe(PHASE_BLEND_30);
    expect(r.reason).toMatch(/Phase 2/);
  });

  it("does NOT promote 1→2 below N=30", () => {
    const { predictions, payoutByKey } = makeRaces({
      n: 29,
      matticeWins: 15,
      systemWins: 5,
      payout: 10,
    });
    const stats = computeStats(predictions, { ...cfg, payoutByKey });
    expect(evaluatePhase(PHASE_TIEBREAK, stats).phase).toBe(PHASE_TIEBREAK);
  });

  it("does NOT promote 1→2 when mattice top% does not beat system%", () => {
    // equal win counts → not strictly greater.
    const { predictions, payoutByKey } = makeRaces({
      n: 40,
      matticeWins: 10,
      systemWins: 10,
      payout: 10,
    });
    const stats = computeStats(predictions, { ...cfg, payoutByKey });
    expect(evaluatePhase(PHASE_TIEBREAK, stats).phase).toBe(PHASE_TIEBREAK);
  });

  it("does NOT promote 1→2 when ROI ≤ -5%", () => {
    // mattice beats system but payout too low → bad ROI.
    const { predictions, payoutByKey } = makeRaces({
      n: 40,
      matticeWins: 14,
      systemWins: 8,
      payout: 2.5, // 14*2.5=35 returned, 40*2=80 staked → -56%
    });
    const stats = computeStats(predictions, { ...cfg, payoutByKey });
    expect(evaluatePhase(PHASE_TIEBREAK, stats).phase).toBe(PHASE_TIEBREAK);
  });

  it("Phase 2 → 3 when N≥100 and ROI > +5%", () => {
    // 100 races, 40 mattice wins, payout 6 → 240 returned, 200 staked → +20%.
    const { predictions, payoutByKey } = makeRaces({
      n: 100,
      matticeWins: 40,
      systemWins: 30,
      payout: 6,
    });
    const stats = computeStats(predictions, { ...cfg, weightPhase: PHASE_BLEND_30, payoutByKey });
    const r = evaluatePhase(PHASE_BLEND_30, stats);
    expect(r.phase).toBe(PHASE_BLEND_50);
  });

  it("does NOT promote 2→3 below N=100", () => {
    const { predictions, payoutByKey } = makeRaces({
      n: 99,
      matticeWins: 50,
      systemWins: 30,
      payout: 10,
    });
    const stats = computeStats(predictions, { ...cfg, weightPhase: PHASE_BLEND_30, payoutByKey });
    expect(evaluatePhase(PHASE_BLEND_30, stats).phase).toBe(PHASE_BLEND_30);
  });

  it("demotes to Phase 1 when N≥50 and ROI < -15%", () => {
    // 50 races, 5 mattice wins, payout 4 → 20 returned, 100 staked → -80%.
    const { predictions, payoutByKey } = makeRaces({
      n: 50,
      matticeWins: 5,
      systemWins: 5,
      payout: 4,
    });
    const stats = computeStats(predictions, { ...cfg, weightPhase: PHASE_BLEND_30, payoutByKey });
    const r = evaluatePhase(PHASE_BLEND_30, stats);
    expect(r.phase).toBe(PHASE_TIEBREAK);
    expect(r.reason).toMatch(/Demoted/);
  });

  it("demotion takes precedence over promotion from Phase 2", () => {
    // Bad ROI from Phase 3 should drop straight to 1.
    const { predictions, payoutByKey } = makeRaces({
      n: 60,
      matticeWins: 3,
      systemWins: 3,
      payout: 2,
    });
    const stats = computeStats(predictions, { ...cfg, weightPhase: PHASE_BLEND_50, payoutByKey });
    expect(evaluatePhase(PHASE_BLEND_50, stats).phase).toBe(PHASE_TIEBREAK);
  });

  it("no change returns same phase + null reason", () => {
    const { predictions } = makeRaces({ n: 5, matticeWins: 1, systemWins: 1 });
    const stats = computeStats(predictions, cfg);
    const r = evaluatePhase(PHASE_TIEBREAK, stats);
    expect(r.phase).toBe(PHASE_TIEBREAK);
    expect(r.reason).toBeNull();
  });
});

describe("phase metadata", () => {
  it("blend weights are 0 / 0.3 / 0.5", () => {
    expect(PHASE_MATTICE_WEIGHT[PHASE_TIEBREAK]).toBe(0);
    expect(PHASE_MATTICE_WEIGHT[PHASE_BLEND_30]).toBe(0.3);
    expect(PHASE_MATTICE_WEIGHT[PHASE_BLEND_50]).toBe(0.5);
  });
  it("phaseLabel maps each phase", () => {
    expect(phaseLabel(PHASE_TIEBREAK)).toMatch(/Phase 1/);
    expect(phaseLabel(PHASE_BLEND_30)).toMatch(/Phase 2/);
    expect(phaseLabel(PHASE_BLEND_50)).toMatch(/Phase 3/);
  });
});

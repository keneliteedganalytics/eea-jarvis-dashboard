// Auto-tuner — reads stored predictions joined with backfilled outcomes, computes
// hit rates by tier and by EEA-rating rank, and surfaces tuning_proposals when a
// metric diverges from its baseline target with enough evidence to matter.
//
// This is advisory only: it never mutates weights. Accepted proposals create a
// new formula_versions row elsewhere (Settings flow). It runs after each card's
// outcome backfill and is cheap, so it re-evaluates the full history each time;
// dedupe keeps it from re-filing a hypothesis that is already pending.

import { storage } from "../storage";
import { DEFAULT_WEIGHTS } from "./eea-config";
import type { Prediction, PredictionOutcome } from "@shared/schema";

const MIN_SAMPLES = 30;
const P_THRESHOLD = 0.1;

// Baseline win-rate targets per tier (the rate below which the tier is "failing").
const TIER_WIN_TARGET: Record<string, number> = {
  SNIPER: 0.35,
  EDGE: 0.22,
};

// Standard normal CDF (Abramowitz-Stegun 7.1.26) → two-sided p-value for a
// one-proportion z-test of observed rate vs baseline.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function twoSidedP(hits: number, n: number, baseline: number): number {
  if (n === 0) return 1;
  const observed = hits / n;
  const se = Math.sqrt((baseline * (1 - baseline)) / n);
  if (se === 0) return 1;
  const z = (observed - baseline) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

interface Joined {
  prediction: Prediction;
  outcome: PredictionOutcome | null;
}

interface Bucket {
  n: number;
  wins: number;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export interface TunerRun {
  created: number;
  evaluated: number;
}

export function runTuner(): TunerRun {
  const rows = storage
    .getAllPredictionsWithOutcomes()
    .filter((r): r is Joined => r.outcome != null && r.outcome.actualFinish != null);

  // Group hit rates by tier (a "hit" for tiers = horse won its race).
  const byTier = new Map<string, Bucket>();
  // Group by EEA-rating rank: rank 1 = the engine's top-rated horse.
  const byRank = new Map<number, Bucket>();

  for (const { prediction, outcome } of rows) {
    const won = outcome!.actualFinish === 1 ? 1 : 0;
    const tier = prediction.tierAssigned;
    if (tier && tier !== "PASS") {
      const b = byTier.get(tier) ?? { n: 0, wins: 0 };
      b.n++;
      b.wins += won;
      byTier.set(tier, b);
    }
    if (prediction.rank != null) {
      const b = byRank.get(prediction.rank) ?? { n: 0, wins: 0 };
      b.n++;
      b.wins += won;
      byRank.set(prediction.rank, b);
    }
  }

  const existing = new Set(storage.getPendingProposals().map((p) => p.hypothesis));
  let created = 0;
  const now = new Date();

  const file = (
    hypothesis: string,
    evidence: Record<string, unknown>,
    change: Record<string, unknown> | null,
  ) => {
    if (existing.has(hypothesis)) return;
    storage.createTuningProposal({
      hypothesis,
      evidenceJson: JSON.stringify(evidence),
      proposedChangeJson: change ? JSON.stringify(change) : null,
      status: "pending",
      createdAt: now,
      reviewedAt: null,
    });
    existing.add(hypothesis);
    created++;
  };

  // Tier underperformance vs baseline target.
  for (const [tier, target] of Object.entries(TIER_WIN_TARGET)) {
    const b = byTier.get(tier);
    if (!b || b.n < MIN_SAMPLES) continue;
    const rate = b.wins / b.n;
    if (rate >= target) continue;
    const p = twoSidedP(b.wins, b.n, target);
    if (p >= P_THRESHOLD) continue;

    let change: Record<string, unknown> | null = null;
    if (tier === "SNIPER") {
      const from = DEFAULT_WEIGHTS.sniperGap;
      change = { weight: "sniperGap", from, to: from + 1 };
    }
    file(
      `${tier} win rate is ${pct(rate)} over ${b.n} picks; baseline target is ${pct(
        target,
      )}.${tier === "SNIPER" ? ` Suggest tightening SNIPER gap from ${DEFAULT_WEIGHTS.sniperGap} to ${DEFAULT_WEIGHTS.sniperGap + 1}.` : ""}`,
      { metric: `${tier}_win_rate`, sampleSize: b.n, winRate: rate, baseline: target, pValue: p },
      change,
    );
  }

  // Top-rated horse (rank 1) should win meaningfully more than rank 2.
  const r1 = byRank.get(1);
  const r2 = byRank.get(2);
  if (r1 && r2 && r1.n >= MIN_SAMPLES && r2.n >= MIN_SAMPLES) {
    const rate1 = r1.wins / r1.n;
    const rate2 = r2.wins / r2.n;
    if (rate1 <= rate2) {
      const p = twoSidedP(r1.wins, r1.n, rate2);
      if (p < P_THRESHOLD) {
        file(
          `Top-rated horse wins ${pct(rate1)} (${r1.n} picks) vs 2nd-rated ${pct(
            rate2,
          )} (${r2.n} picks) — EEA Rating is not separating the field. Review figure weights.`,
          {
            metric: "rank1_vs_rank2_win_rate",
            rank1: { sampleSize: r1.n, winRate: rate1 },
            rank2: { sampleSize: r2.n, winRate: rate2 },
            pValue: p,
          },
          null,
        );
      }
    }
  }

  return { created, evaluated: rows.length };
}

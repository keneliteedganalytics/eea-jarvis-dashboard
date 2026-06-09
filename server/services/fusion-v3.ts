// Fusion v3 (PR #28b, spec §4).
//
// Replaces the Prime-Power-dominant blend with a transparent weighted sum over
// the 12 computed deep features (features.ts). Produces a per-runner composite
// 0-100 and a percentile-based tier assignment (SNIPER > EDGE > DUAL > RECON >
// PASS). The percentile framing — tiers off where a horse sits IN ITS FIELD,
// not raw cutoffs — is what stops a weak race from minting false SNIPERs and a
// monster race from burying live horses in PASS.
//
// PR #27 rules A1–A5 still apply as post-tier override gates (the same honesty
// /earned-class/rating-gap logic), re-expressed against the v3 features so they
// gate on the right fields. The output mirrors eea-fusion's TierAssignment so
// analyze-card / postmortem can consume either path.

import type { DeepRunner, DeepRace } from "./parsers/brisnet-deep";
import {
  computeRunnerFeatures,
  honestyCheck,
  type RunnerFeatures,
} from "./features";

export type Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

// Default weights, tuned on Saratoga + Finger Lakes graded races (spec §4).
export const FUSION_V3_WEIGHTS: Record<keyof Omit<RunnerFeatures, "honesty_check">, number> = {
  pace_fit_score: 15,
  class_earned_score: 15,
  dist_surf_form_score: 15,
  form_curve_score: 10,
  bias_match_score: 10,
  jt_hot_score: 8,
  trainer_angle_score: 8,
  conditions_pedigree_score: 7,
  work_sharp_score: 5,
  trip_compromised_score: 5,
  layoff_score: 2,
};

export interface RunnerScore {
  pgm: string;
  horseName: string | null;
  features: RunnerFeatures;
  composite: number; // 0-100 weighted blend over present features
  rank: number; // 1-based, by composite desc
}

export interface FusionV3Race {
  raceNumber: number;
  runners: RunnerScore[];
  tiers: TierResult[];
  raceFlags: string[];
}

export interface TierResult {
  pgm: string;
  tier: Tier;
  flags?: string[];
}

// Weighted average over PRESENT features only — nulls drop out and the weights
// renormalize, so a thin card scores on what it has rather than being dragged
// to zero by missing fields.
export function composite(features: RunnerFeatures): number {
  let wsum = 0;
  let acc = 0;
  for (const [k, w] of Object.entries(FUSION_V3_WEIGHTS) as [keyof typeof FUSION_V3_WEIGHTS, number][]) {
    const v = features[k];
    if (typeof v === "number") {
      acc += v * w;
      wsum += w;
    }
  }
  if (wsum === 0) return 0;
  return Math.round((acc / wsum) * 10) / 10;
}

// Score every runner in a race and rank by composite.
export function scoreRace(race: DeepRace, trackCondition?: string | null): RunnerScore[] {
  const scored = race.runners.map((r) => {
    const features = computeRunnerFeatures(r, race, trackCondition);
    return {
      pgm: r.programNumber,
      horseName: r.horseName,
      features,
      composite: composite(features),
      rank: 0,
    };
  });
  scored.sort((a, b) => b.composite - a.composite);
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}

// composite_top_signal: the top horse's composite, lightly boosted by how far
// it separates from the field median (a dominant top gets a small SNIPER nudge).
function topSignal(scored: RunnerScore[]): number {
  if (scored.length === 0) return 0;
  const top = scored[0].composite;
  if (scored.length === 1) return top;
  const rest = scored.slice(1).map((s) => s.composite);
  const median = rest.sort((a, b) => a - b)[Math.floor(rest.length / 2)];
  const sep = top - median;
  return Math.min(100, top + Math.max(0, sep - 8) * 0.4);
}

// Assign tiers from the percentile structure of the field (spec §4). The
// thresholds read composite values, but the gating is relative: DUAL needs two
// horses bunched within 5 pts of the top, RECON catches the live-but-buried
// 50-60 band. Then A1–A5 override gates fire.
export function assignTiersV3(scored: RunnerScore[]): { tiers: TierResult[]; raceFlags: string[] } {
  const raceFlags: string[] = [];
  const flagsByPgm = new Map<string, string[]>();
  const addFlag = (pgm: string, f: string) => {
    const arr = flagsByPgm.get(pgm) ?? [];
    arr.push(f);
    flagsByPgm.set(pgm, arr);
  };
  const tierByPgm = new Map<string, Tier>();
  scored.forEach((s) => tierByPgm.set(s.pgm, "PASS"));

  if (scored.length === 0) return { tiers: [], raceFlags };

  const top = scored[0];
  const second = scored[1];
  const sig = topSignal(scored);

  // ── base tier per percentile rules ──
  if (sig >= 80) {
    tierByPgm.set(top.pgm, "SNIPER");
  } else if (sig >= 65 || (second && second.composite >= 75)) {
    tierByPgm.set(top.pgm, "EDGE");
  } else if (top.composite >= 60) {
    tierByPgm.set(top.pgm, "EDGE");
  } else if (top.composite >= 50) {
    tierByPgm.set(top.pgm, "RECON");
  }

  // DUAL: two within 5 pts of top AND composite ≥ 60 AND class_earned ≥ 50.
  if (second && top.composite - second.composite <= 5 && second.composite >= 60) {
    const ce = second.features.class_earned_score;
    if (ce != null && ce >= 50) {
      tierByPgm.set(second.pgm, "DUAL");
    } else {
      tierByPgm.set(second.pgm, "RECON");
      const f = `A1_DUAL_DOWNGRADE on #${second.pgm} (class_earned ${ce ?? "n/a"} < 50)`;
      addFlag(second.pgm, f);
      raceFlags.push(f);
    }
  }

  // RECON band: any non-top horse with composite 50-60 (cap at 2 total).
  let reconCount = Array.from(tierByPgm.values()).filter((t) => t === "RECON").length;
  for (const s of scored.slice(1)) {
    if (tierByPgm.get(s.pgm) !== "PASS") continue;
    if (reconCount >= 2) break;
    if (s.composite >= 50 && s.composite < 60) {
      tierByPgm.set(s.pgm, "RECON");
      reconCount++;
    }
  }

  // ── A2: rating-gap penalty — a thin-margin leader with weak earned class
  // loses a conviction notch. ──
  if (second) {
    const gap = top.composite - second.composite;
    const leaderTier = tierByPgm.get(top.pgm)!;
    const ce = top.features.class_earned_score;
    if ((leaderTier === "SNIPER" || leaderTier === "EDGE") && gap < 3 && ce != null && ce < 50) {
      const demoted: Tier = leaderTier === "SNIPER" ? "EDGE" : "DUAL";
      tierByPgm.set(top.pgm, demoted);
      raceFlags.push(
        `RATING_GAP_PENALTY on #${top.pgm} (${leaderTier}→${demoted}: thin margin, no earned class)`,
      );
    }
  }

  // ── A4: honesty check — does #2 beat the top pick on ≥2 non-Prime-Power
  // dimensions? If so, demote the top pick's conviction one notch. ──
  if (second) {
    const hc = honestyCheck(top.features, second.features);
    const leaderTier = tierByPgm.get(top.pgm)!;
    if (hc.flagged && leaderTier !== "PASS" && leaderTier !== "RECON") {
      const demoted = demoteOne(leaderTier);
      tierByPgm.set(top.pgm, demoted);
      raceFlags.push(
        `HONESTY_CHECK on #${top.pgm} (${leaderTier}→${demoted}: #${second.pgm} stronger on ${hc.reasons.join(", ")})`,
      );
    }
  }

  // ── A3: PASS-cluster compression — promote the single best buried-but-live
  // horse (highest composite still in PASS, ≥ 45) to RECON. ──
  const passLive = scored.filter((s) => tierByPgm.get(s.pgm) === "PASS" && s.composite >= 45);
  if (passLive.length) {
    const promo = passLive[0]; // already sorted by composite desc
    tierByPgm.set(promo.pgm, "RECON");
    raceFlags.push(
      `PASS_COMPRESSION_PROMOTION on #${promo.pgm} (PASS→RECON: best non-rating fit, composite ${promo.composite})`,
    );
  }

  const tiers: TierResult[] = scored.map((s) => {
    const tier = tierByPgm.get(s.pgm) ?? "PASS";
    const hf = flagsByPgm.get(s.pgm);
    return { pgm: s.pgm, tier, ...(hf && hf.length ? { flags: hf } : {}) };
  });
  return { tiers, raceFlags };
}

export function demoteOne(tier: Tier): Tier {
  const order: Tier[] = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"];
  const i = order.indexOf(tier);
  if (i < 0 || i === order.length - 1) return tier;
  return order[i + 1];
}

// Top-level entry: score + tier a single deep race.
export function fuseRaceV3(race: DeepRace, trackCondition?: string | null): FusionV3Race {
  const runners = scoreRace(race, trackCondition);
  const { tiers, raceFlags } = assignTiersV3(runners);
  return { raceNumber: race.raceNumber, runners, tiers, raceFlags };
}

// Score + tier an entire deep card.
export function fuseCardV3(
  races: DeepRace[],
  trackCondition?: string | null,
): FusionV3Race[] {
  return races.map((r) => fuseRaceV3(r, trackCondition));
}

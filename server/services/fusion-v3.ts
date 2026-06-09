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
  mlOdds?: number | null; // morning-line odds (decimal-to-1), for ML-favorite match
  speedFig?: number | null; // last-race speed figure, for speed_figure_gap rule
}

export interface FusionV3Race {
  raceNumber: number;
  runners: RunnerScore[];
  tiers: TierResult[];
  raceFlags: string[];
}

// PR #42: a conviction adjustment applied AFTER base tiering. `delta` is the
// signed points added to (or removed from) the pick's conviction; `reason` is a
// stable code for analytics bucketing.
export interface ConvictionModifier {
  reason: string; // "ml_favorite_matched" | "speed_gap" | ...
  delta: number;
}

// PR #42: a tier demotion forced by a post-tier override gate (e.g. speed_gap).
export interface TierDemotion {
  reason: string;
  from: Tier;
  to: Tier;
  gap?: number;
}

export interface TierResult {
  pgm: string;
  tier: Tier;
  flags?: string[];
  // PR #42 — conviction modifiers (e.g. ml_favorite_matched +5) applied to this
  // pick, and any forced demotions (e.g. speed_gap → RECON). The named boolean
  // flags below are convenience mirrors the pick JSON / analytics read directly.
  conviction?: number; // base composite + sum(modifiers.delta), clamped 0-100
  modifiers?: ConvictionModifier[];
  demotions?: TierDemotion[];
  mlFavoriteMatched?: boolean;
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
      mlOdds: r.mlOdds ?? null,
      // Last-race speed figure off the Ultimate Race Summary; falls back to the
      // most recent final-speed reading when the explicit last-race field is null.
      speedFig: r.summary.speedLastRace ?? r.summary.finalSpd1 ?? null,
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

  // ── PR #42 conviction modifiers + post-tier gates ──────────────────────────
  // These run on the TOP pick (the highest-conviction non-PASS horse) after the
  // A1–A5 gates have settled its tier. modifiersByPgm/demotionsByPgm are keyed
  // so they ride along onto the per-runner TierResult below.
  const modifiersByPgm = new Map<string, ConvictionModifier[]>();
  const demotionsByPgm = new Map<string, TierDemotion[]>();
  const mlMatchedByPgm = new Map<string, boolean>();

  // Identify the morning-line favorite = lowest mlOdds across the field.
  const mlFav = scored
    .filter((s) => typeof s.mlOdds === "number" && (s.mlOdds as number) > 0)
    .sort((a, b) => (a.mlOdds as number) - (b.mlOdds as number))[0];

  // The current top pick = best non-PASS horse by tier rank then composite.
  const topPick = [...scored].sort((a, b) => {
    const ra = tierRankIdx(tierByPgm.get(a.pgm) ?? "PASS");
    const rb = tierRankIdx(tierByPgm.get(b.pgm) ?? "PASS");
    if (ra !== rb) return ra - rb;
    return a.rank - b.rank;
  })[0];

  if (topPick && tierByPgm.get(topPick.pgm) !== "PASS") {
    // ── #3: ml_favorite_matched (+5 conviction) ──
    // When our top-tiered horse IS the ML favorite, the public and our model
    // agree on the same number — a small conviction bump (caps still apply).
    if (mlFav && mlFav.pgm === topPick.pgm) {
      mlMatchedByPgm.set(topPick.pgm, true);
      addTo(modifiersByPgm, topPick.pgm, { reason: "ml_favorite_matched", delta: 5 });
      raceFlags.push(`ML_FAVORITE_MATCHED on #${topPick.pgm} (+5 conviction)`);
      addFlag(topPick.pgm, "ML_FAVORITE_MATCHED (+5 conviction)");
    }

    // ── #4: speed_figure_gap demotion ──
    // gap = field's top last-race speed figure − our top pick's. A SNIPER/EDGE
    // that gives up >5 speed points to a faster horse in the field is over-tiered
    // for the pace it actually shows → demote to RECON.
    const speeds = scored
      .map((s) => s.speedFig)
      .filter((v): v is number => typeof v === "number");
    const fieldTopSpeed = speeds.length ? Math.max(...speeds) : null;
    const ours = topPick.speedFig;
    if (fieldTopSpeed != null && typeof ours === "number") {
      const gap = Math.round((fieldTopSpeed - ours) * 10) / 10;
      const curTier = tierByPgm.get(topPick.pgm)!;
      if (gap > 5 && (curTier === "SNIPER" || curTier === "EDGE")) {
        tierByPgm.set(topPick.pgm, "RECON");
        addTo(demotionsByPgm, topPick.pgm, {
          reason: "speed_gap",
          from: curTier,
          to: "RECON",
          gap,
        });
        raceFlags.push(
          `SPEED_GAP_DEMOTION on #${topPick.pgm} (${curTier}→RECON: gives ${gap} speed pts to field top)`,
        );
        addFlag(topPick.pgm, `SPEED_GAP_DEMOTION (${curTier}→RECON, gap ${gap})`);
      }
    }
  }

  const tiers: TierResult[] = scored.map((s) => {
    const tier = tierByPgm.get(s.pgm) ?? "PASS";
    const hf = flagsByPgm.get(s.pgm);
    const mods = modifiersByPgm.get(s.pgm);
    const demos = demotionsByPgm.get(s.pgm);
    const matched = mlMatchedByPgm.get(s.pgm) ?? false;
    const convDelta = (mods ?? []).reduce((a, m) => a + m.delta, 0);
    const conviction = Math.max(0, Math.min(100, s.composite + convDelta));
    return {
      pgm: s.pgm,
      tier,
      ...(hf && hf.length ? { flags: hf } : {}),
      ...(mods && mods.length ? { modifiers: mods, conviction } : {}),
      ...(demos && demos.length ? { demotions: demos } : {}),
      ...(matched ? { mlFavoriteMatched: true } : {}),
    };
  });
  return { tiers, raceFlags };
}

function tierRankIdx(t: Tier): number {
  return ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"].indexOf(t);
}

function addTo<T>(m: Map<string, T[]>, key: string, val: T): void {
  const arr = m.get(key) ?? [];
  arr.push(val);
  m.set(key, arr);
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

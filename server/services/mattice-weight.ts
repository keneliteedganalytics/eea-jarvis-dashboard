// Mattice auto-promotion / demotion service (PR #51).
//
// "Let data earn the weight." The overlay logs every prediction and auto-grades
// it. This service reads the graded predictions, rolls them up into MatticeStats,
// and moves the stored weight phase as evidence accumulates:
//
//   Phase 1 (tiebreak + veto only)  → Phase 2 (30% blend):
//       N >= 30  AND  matticeTopWin% > equibaseFavWin%  AND  roi% > -5%
//   Phase 2 (30% blend)             → Phase 3 (50% blend):
//       N >= 100 AND  roi% > +5%
//   Demotion (any phase)            → Phase 1:
//       N >= 50  AND  roi% < -15%
//
// Thresholds are verbatim from the user's spec. Promotion is one step at a time
// (1→2→3); demotion always drops straight back to Phase 1. We never auto-promote
// past Phase 3. The phase + a human-readable reason are persisted on the single
// settings row (matticeWeightPhase / matticePhaseChangedAt / matticePhaseReason)
// so the picker and the dashboard tile both read the same source of truth.

import type { MatticePrediction, MatticeStats } from "@shared/schema";
import { storage } from "../storage";

export const PHASE_TIEBREAK = 1;
export const PHASE_BLEND_30 = 2;
export const PHASE_BLEND_50 = 3;

// Blend weight applied to the Mattice score by phase (0 = tiebreak/veto only).
export const PHASE_MATTICE_WEIGHT: Record<number, number> = {
  [PHASE_TIEBREAK]: 0,
  [PHASE_BLEND_30]: 0.3,
  [PHASE_BLEND_50]: 0.5,
};

// Promotion / demotion gates (verbatim from spec).
export const PROMO_1_TO_2_MIN_N = 30;
export const PROMO_1_TO_2_MIN_ROI = -5; // percent
export const PROMO_2_TO_3_MIN_N = 100;
export const PROMO_2_TO_3_MIN_ROI = 5; // percent
export const DEMOTE_MIN_N = 50;
export const DEMOTE_MAX_ROI = -15; // percent

export function phaseLabel(phase: number): string {
  switch (phase) {
    case PHASE_BLEND_30:
      return "Phase 2: 30% blend";
    case PHASE_BLEND_50:
      return "Phase 3: 50% blend";
    default:
      return "Phase 1: Tiebreak + Veto";
  }
}

function pct(wins: number, plays: number): number | null {
  if (plays <= 0) return null;
  return (wins / plays) * 100;
}

// Compute the running roll-up from a set of graded predictions. `payoutByKey`
// optionally maps `${raceId}:${programNumber}` → win mutuel ($ returned on a $2
// win bet) so ROI reflects real payouts; absent a payout the win is valued at
// the $2 stake (break-even) so ROI stays conservative and never fabricates edge.
export function computeStats(
  predictions: MatticePrediction[],
  opts: {
    weightPhase: number;
    phaseChangedAt: string | null;
    phaseReason: string | null;
    payoutByKey?: Map<string, number>;
  },
): MatticeStats {
  const graded = predictions.filter((p) => p.gradedAt != null && p.actualFinish != null);

  // One "race" worth of evidence = the graded set grouped by race. N counts
  // distinct graded races (the unit the thresholds are written against).
  const raceIds = new Set(graded.map((p) => p.raceId));
  const n = raceIds.size;

  // Mattice's OWN top pick per race.
  const matticeTop = graded.filter((p) => p.isMatticeTop);
  const matticeTopPlays = matticeTop.length;
  const matticeTopWins = matticeTop.filter((p) => p.won).length;

  // System (fused) win pick per race — the baseline ("equibase fav" proxy).
  const systemPick = graded.filter((p) => p.isSystemPick);
  const systemPickPlays = systemPick.length;
  const systemPickWins = systemPick.filter((p) => p.won).length;

  const vetoCount = graded.filter((p) => p.vetoFlag).length;

  // Flat $2 win ROI on Mattice's top horse.
  const stake = matticeTopPlays * 2;
  let returned = 0;
  for (const p of matticeTop) {
    if (!p.won) continue;
    const key = `${p.raceId}:${p.programNumber}`;
    const payout = opts.payoutByKey?.get(key);
    // payout is the $ returned on a $2 win bet (mutuel). Without it, a win is
    // valued at the stake (break-even) so we never overstate the edge.
    returned += payout != null && Number.isFinite(payout) ? payout : 2;
  }
  const roiPct = stake > 0 ? ((returned - stake) / stake) * 100 : null;

  return {
    n,
    systemPickWins,
    systemPickPlays,
    systemPickWinPct: pct(systemPickWins, systemPickPlays),
    matticeTopWins,
    matticeTopPlays,
    matticeTopWinPct: pct(matticeTopWins, matticeTopPlays),
    equibaseFavWinPct: pct(systemPickWins, systemPickPlays),
    roiPct,
    weightPhase: opts.weightPhase,
    phaseLabel: phaseLabel(opts.weightPhase),
    phaseChangedAt: opts.phaseChangedAt,
    phaseReason: opts.phaseReason,
    vetoCount,
    generatedAt: new Date().toISOString(),
  };
}

// Pure threshold engine: given current phase + stats, return the phase we SHOULD
// be in plus a reason. Demotion takes precedence (risk-off first), then a single
// promotion step. Returns the same phase + null reason when nothing changes.
export function evaluatePhase(
  currentPhase: number,
  stats: MatticeStats,
): { phase: number; reason: string | null } {
  const { n, roiPct, matticeTopWinPct, equibaseFavWinPct } = stats;

  // Demotion first — applies from any phase above 1.
  if (
    currentPhase > PHASE_TIEBREAK &&
    n >= DEMOTE_MIN_N &&
    roiPct != null &&
    roiPct < DEMOTE_MAX_ROI
  ) {
    return {
      phase: PHASE_TIEBREAK,
      reason: `Demoted to Phase 1: N=${n} (≥${DEMOTE_MIN_N}) and ROI ${roiPct.toFixed(1)}% (<${DEMOTE_MAX_ROI}%).`,
    };
  }

  // Phase 1 → 2.
  if (
    currentPhase === PHASE_TIEBREAK &&
    n >= PROMO_1_TO_2_MIN_N &&
    matticeTopWinPct != null &&
    equibaseFavWinPct != null &&
    matticeTopWinPct > equibaseFavWinPct &&
    roiPct != null &&
    roiPct > PROMO_1_TO_2_MIN_ROI
  ) {
    return {
      phase: PHASE_BLEND_30,
      reason: `Promoted to Phase 2 (30% blend): N=${n} (≥${PROMO_1_TO_2_MIN_N}), Mattice top ${matticeTopWinPct.toFixed(1)}% > system ${equibaseFavWinPct.toFixed(1)}%, ROI ${roiPct.toFixed(1)}% (>${PROMO_1_TO_2_MIN_ROI}%).`,
    };
  }

  // Phase 2 → 3.
  if (
    currentPhase === PHASE_BLEND_30 &&
    n >= PROMO_2_TO_3_MIN_N &&
    roiPct != null &&
    roiPct > PROMO_2_TO_3_MIN_ROI
  ) {
    return {
      phase: PHASE_BLEND_50,
      reason: `Promoted to Phase 3 (50% blend): N=${n} (≥${PROMO_2_TO_3_MIN_N}), ROI ${roiPct.toFixed(1)}% (>${PROMO_2_TO_3_MIN_ROI}%).`,
    };
  }

  return { phase: currentPhase, reason: null };
}

// Read graded predictions, compute stats, and persist any phase change to the
// settings row. Returns the resulting stats (with the post-change phase). Safe
// to call after every card grading — a no-op when no threshold is crossed.
export function refreshMatticeWeight(opts?: {
  payoutByKey?: Map<string, number>;
}): MatticeStats {
  const s = storage.getSettings();
  const currentPhase = s.matticeWeightPhase ?? PHASE_TIEBREAK;
  const predictions = storage.getAllMatticePredictions();

  const stats = computeStats(predictions, {
    weightPhase: currentPhase,
    phaseChangedAt: s.matticePhaseChangedAt ?? null,
    phaseReason: s.matticePhaseReason ?? null,
    payoutByKey: opts?.payoutByKey,
  });

  const { phase, reason } = evaluatePhase(currentPhase, stats);
  if (phase !== currentPhase && reason) {
    const changedAt = new Date().toISOString();
    storage.updateSettings({
      matticeWeightPhase: phase,
      matticePhaseChangedAt: changedAt,
      matticePhaseReason: reason,
    });
    return { ...stats, weightPhase: phase, phaseLabel: phaseLabel(phase), phaseChangedAt: changedAt, phaseReason: reason };
  }
  return stats;
}

// Convenience the dashboard tile + /api/mattice read: current stats without any
// phase mutation (read-only). Phase changes only happen on grading via refresh.
export function getMatticeStats(opts?: { payoutByKey?: Map<string, number> }): MatticeStats {
  const s = storage.getSettings();
  return computeStats(storage.getAllMatticePredictions(), {
    weightPhase: s.matticeWeightPhase ?? PHASE_TIEBREAK,
    phaseChangedAt: s.matticePhaseChangedAt ?? null,
    phaseReason: s.matticePhaseReason ?? null,
    payoutByKey: opts?.payoutByKey,
  });
}

// Mattice overlay integration (PR #51) — the layer that actually touches the
// picks. It sits BETWEEN the fused tier assignment and persistence:
//
//   Phase 1 (default): TIEBREAK + VETO ONLY. No score blending.
//     • Tiebreak — when the top-two fused horses are within TIEBREAK_BAND points,
//       the one with the higher matticeScore is promoted to win pick.
//     • Veto    — if the (post-tiebreak) win pick carries a Mattice veto flag,
//       the race tier is downgraded one step (SNIPER→EDGE→…→PASS).
//     • Badge   — "Mattice Confirmed" when the win pick scores ≥ CONFIRMED_SCORE
//       and is not vetoed.
//   Phase 2 (30%) / Phase 3 (50%): blend the normalized Mattice score into the
//     fused rating before picking the win horse: blended = (1-w)*fusedN + w*matN.
//
// The numeric engine is pure + deterministic (see mattice.ts). This module only
// arranges those verdicts against the fused field. Persistence of the per-horse
// predictions is a thin wrapper so analyze-card stays readable.

import type { FusedHorse, FusedRace, Tier } from "./eea-fusion";
import { demoteOne } from "./eea-fusion";
import {
  CONFIRMED_SCORE,
  MATTICE_MAX,
  inputFromFusedHorse,
  matticeTopPick,
  scoreRace,
} from "./mattice";
import { PHASE_MATTICE_WEIGHT, PHASE_TIEBREAK } from "./mattice-weight";
import type { MatticeFactorKey, MatticeHorseScore } from "@shared/schema";
import { MATTICE_FACTOR_KEYS } from "@shared/schema";
import { storage } from "../storage";

// Fused points: two top horses within this band are a "tie" the overlay breaks.
export const TIEBREAK_BAND = 3;

export interface OverlayResult {
  // Win pick after the overlay (program number). May differ from the fused
  // leader only via a Phase-1 tiebreak or a Phase-2/3 blend re-rank.
  winPgm: string | null;
  // Tier after any veto downgrade.
  tier: Tier;
  // True when the overlay moved the win pick off the fused leader.
  tiebreakApplied: boolean;
  // True when a veto downgraded the tier.
  vetoApplied: boolean;
  // "Mattice Confirmed" badge for the final win pick.
  confirmed: boolean;
  // The full per-horse Mattice scores (for persistence + evidence).
  scores: MatticeHorseScore[];
  // Mattice's OWN top horse (highest matticeScore), independent of the system.
  matticeTopPgm: string | null;
  // Human-readable note for the race read / debugging.
  note: string;
}

// Normalize a value to 0..1 over a [min,max] spread; null when the spread is 0.
function norm(v: number | null, min: number, max: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (max <= min) return null;
  return (v - min) / (max - min);
}

// The fused leader = lowest rank (rank 1 is best). Falls back to first horse.
function fusedLeader(fused: FusedRace): FusedHorse | null {
  if (fused.horses.length === 0) return null;
  return [...fused.horses].sort((a, b) => a.rank - b.rank)[0];
}

// Run the overlay for one race at a given weight phase. Pure: no persistence.
export function applyOverlay(
  fused: FusedRace,
  leaderTier: Tier,
  phase: number = PHASE_TIEBREAK,
): OverlayResult {
  const scores = scoreRace(fused.horses.map(inputFromFusedHorse));
  const byPgm = new Map(scores.map((s) => [s.programNumber, s]));
  const matTop = matticeTopPick(scores);

  const base: OverlayResult = {
    winPgm: null,
    tier: leaderTier,
    tiebreakApplied: false,
    vetoApplied: false,
    confirmed: false,
    scores,
    matticeTopPgm: matTop?.programNumber ?? null,
    note: "",
  };

  const leader = fusedLeader(fused);
  if (!leader) return { ...base, note: "Empty field — overlay skipped." };
  base.winPgm = leader.pgm;

  const ranked = [...fused.horses].sort((a, b) => a.rank - b.rank);
  const second = ranked[1] ?? null;
  const notes: string[] = [];

  const weight = PHASE_MATTICE_WEIGHT[phase] ?? 0;

  if (weight > 0) {
    // ── Phase 2/3: blend normalized fused rating + normalized mattice score ──
    const ratings = fused.horses
      .map((h) => h.eeaRating)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const rMin = ratings.length ? Math.min(...ratings) : 0;
    const rMax = ratings.length ? Math.max(...ratings) : 0;
    let bestPgm = leader.pgm;
    let bestBlend = -Infinity;
    for (const h of fused.horses) {
      const fusedN = norm(h.eeaRating, rMin, rMax) ?? 0.5;
      const matN = (byPgm.get(h.pgm)?.matticeScore ?? 0) / MATTICE_MAX;
      const blended = (1 - weight) * fusedN + weight * matN;
      if (blended > bestBlend) {
        bestBlend = blended;
        bestPgm = h.pgm;
      }
    }
    if (bestPgm !== leader.pgm) {
      base.winPgm = bestPgm;
      base.tiebreakApplied = true;
      notes.push(
        `Phase ${phase} blend (${Math.round(weight * 100)}% Mattice) moved win pick ${leader.pgm} → ${bestPgm}.`,
      );
    } else {
      notes.push(`Phase ${phase} blend kept fused leader #${leader.pgm}.`);
    }
  } else if (second) {
    // ── Phase 1: tiebreak only when the top two are within the band ──
    const lead = leader.eeaRating;
    const sec = second.eeaRating;
    if (lead != null && sec != null && Math.abs(lead - sec) <= TIEBREAK_BAND) {
      const ls = byPgm.get(leader.pgm)?.matticeScore ?? 0;
      const ss = byPgm.get(second.pgm)?.matticeScore ?? 0;
      if (ss > ls) {
        base.winPgm = second.pgm;
        base.tiebreakApplied = true;
        notes.push(
          `Tiebreak: #${leader.pgm} and #${second.pgm} within ${TIEBREAK_BAND} fused pts; Mattice ${ss} > ${ls} → win pick #${second.pgm}.`,
        );
      }
    }
  }

  // ── Veto: downgrade the tier one step if the FINAL win pick is vetoed ──
  const winScore = base.winPgm ? byPgm.get(base.winPgm) : undefined;
  if (winScore?.vetoFlag) {
    const demoted = demoteOne(leaderTier);
    if (demoted !== leaderTier) {
      base.tier = demoted;
      base.vetoApplied = true;
      notes.push(`Veto: win pick #${base.winPgm} has 2+ negative factors → tier ${leaderTier}→${demoted}.`);
    }
  }

  // ── "Mattice Confirmed" badge ──
  base.confirmed = !!winScore && !winScore.vetoFlag && winScore.matticeScore >= CONFIRMED_SCORE;
  if (base.confirmed) notes.push(`Mattice Confirmed (#${base.winPgm} ${winScore!.matticeScore}/100).`);

  base.note = notes.join(" ");
  return base;
}

// Persist the per-horse Mattice predictions for a race. systemWinPgm marks the
// fused/system win pick; matticeTopPgm is the overlay's own top horse. Both flags
// drive the auto-promotion stats. Idempotent via upsert (preserves grading).
export function persistMatticePredictions(args: {
  cardId: number;
  raceId: number;
  scores: MatticeHorseScore[];
  systemWinPgm: string | null;
  matticeTopPgm: string | null;
}): void {
  for (const s of args.scores) {
    const evidence: Record<MatticeFactorKey, { signal: string; evidence: string }> = {} as Record<
      MatticeFactorKey,
      { signal: string; evidence: string }
    >;
    for (const k of MATTICE_FACTOR_KEYS) {
      evidence[k] = { signal: s.factors[k].signal, evidence: s.factors[k].evidence };
    }
    storage.upsertMatticePrediction({
      cardId: args.cardId,
      raceId: args.raceId,
      programNumber: s.programNumber,
      horseName: s.horseName,
      matticeScore: s.matticeScore,
      vetoFlag: s.vetoFlag,
      factorPace: s.factors.pace.score,
      factorSpeed: s.factors.speed.score,
      factorClass: s.factors.class.score,
      factorConnections: s.factors.connections.score,
      factorForm: s.factors.form.score,
      evidenceJson: JSON.stringify(evidence),
      isSystemPick: args.systemWinPgm != null && s.programNumber === args.systemWinPgm,
      isMatticeTop: args.matticeTopPgm != null && s.programNumber === args.matticeTopPgm,
      source: s.source,
    });
  }
}

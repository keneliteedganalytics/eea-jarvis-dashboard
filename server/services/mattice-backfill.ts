// Mattice overlay backfill (PR #52) — the headless core of
// scripts/backfill_mattice_card.ts, lifted into a callable function so it can be
// driven from the CLI OR an HTTP endpoint (POST /api/cards/:id/mattice-backfill).
//
// It re-runs the Mattice 5-factor overlay across every race of an
// already-ingested card WITHOUT re-ingesting Equibase/Brisnet. Each race is
// reconstructed from its preserved predictions snapshot (the fusion-replay path),
// run through the overlay at the card's current weight phase, and the tiebreak
// win-pick swap + veto downgrade + "Mattice Confirmed" badge are persisted back to
// the race row. Races that already carry a graded result are auto-graded so the
// weight phase can be refreshed from the accumulated record.
//
// The return value is a plain JSON-serializable object (no class instances) so the
// route can hand it straight to res.json() and the CLI can pretty-print it.

import { storage } from "../storage";
import { reconstructFusedRace } from "./fusion-replay";
import { applyOverlay, persistMatticePredictions } from "./mattice-overlay";
import { refreshMatticeWeight, PHASE_TIEBREAK } from "./mattice-weight";
import type { Tier } from "./eea-fusion";
import type { MatticeStats } from "@shared/schema";

const TIERS = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] as const;

export interface MatticeBackfillRaceResult {
  raceNumber: number;
  oldTier: string;
  newTier: string;
  tiebreakApplied: boolean;
  vetoApplied: boolean;
  matticeConfirmed: boolean;
  matticeTopPgm: string | null;
  matticeTopScore: number | null;
  note: string;
}

export interface MatticeBackfillResult {
  card: { id: number; track: string; date: string };
  phase: number;
  races: MatticeBackfillRaceResult[];
  skippedRaces: number[]; // race numbers with no preserved predictions
  tierDistribution: { before: Record<string, number>; after: Record<string, number> };
  gradedRaces: number;
  stats: MatticeStats;
}

function finishOrderFor(resultJson: string | null | undefined): string[] {
  if (!resultJson) return [];
  try {
    const fo = JSON.parse(resultJson) as unknown;
    return Array.isArray(fo) ? fo.map(String) : [];
  } catch {
    return [];
  }
}

// Re-run the overlay across a card and persist the result. Throws if the card
// doesn't exist (caller maps that to a 404). Mirrors fusion-replay's runFusionReplay.
export function runMatticeBackfill(cardId: number): MatticeBackfillResult {
  const card = storage.getCardWithRaces(cardId);
  if (!card) throw new Error(`Card ${cardId} not found`);

  const phase = storage.getSettings().matticeWeightPhase ?? PHASE_TIEBREAK;

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  const bump = (m: Record<string, number>, t: string) => (m[t] = (m[t] ?? 0) + 1);

  const races: MatticeBackfillRaceResult[] = [];
  const skippedRaces: number[] = [];
  let gradedRaces = 0;

  for (const race of card.races) {
    const preds = storage.getPredictionsByRace(race.id);
    if (preds.length === 0) {
      skippedRaces.push(race.raceNumber);
      continue;
    }
    bump(before, race.tier);

    const fused = reconstructFusedRace(race, preds);
    const leaderTier = race.tier as Tier;
    const overlay = applyOverlay(fused, leaderTier, phase);

    persistMatticePredictions({
      cardId: card.id,
      raceId: race.id,
      scores: overlay.scores,
      systemWinPgm: overlay.tiebreakApplied ? overlay.winPgm : (race.winPgm ?? null),
      matticeTopPgm: overlay.matticeTopPgm,
    });

    const patch: Record<string, unknown> = {
      tier: overlay.tier,
      matticeConfirmed: overlay.confirmed,
    };
    if (overlay.tiebreakApplied && overlay.winPgm && overlay.winPgm !== race.winPgm) {
      const newWin = fused.horses.find((h) => h.pgm === overlay.winPgm);
      if (newWin) {
        patch.winPgm = newWin.pgm;
        patch.winName = newWin.name;
      }
    }
    storage.updateRaceFusion(race.id, patch);
    bump(after, String(overlay.tier));

    const topScore = overlay.scores.find((s) => s.programNumber === overlay.matticeTopPgm);
    races.push({
      raceNumber: race.raceNumber,
      oldTier: race.tier,
      newTier: String(overlay.tier),
      tiebreakApplied: overlay.tiebreakApplied,
      vetoApplied: overlay.vetoApplied,
      matticeConfirmed: overlay.confirmed,
      matticeTopPgm: overlay.matticeTopPgm,
      matticeTopScore: topScore?.matticeScore ?? null,
      note: overlay.note,
    });

    const finishOrder = finishOrderFor(race.result?.finishOrder);
    if (finishOrder.length > 0) {
      storage.gradeMatticeForRace(race.id, finishOrder);
      gradedRaces++;
    }
  }

  // Refresh the weight phase from the freshly-graded record.
  const stats = refreshMatticeWeight();

  // Keep only tiers that actually appear (in canonical order) for a tidy payload.
  const tierDistribution = { before: {} as Record<string, number>, after: {} as Record<string, number> };
  for (const t of TIERS) {
    if (before[t]) tierDistribution.before[t] = before[t];
    if (after[t]) tierDistribution.after[t] = after[t];
  }

  return {
    card: { id: card.id, track: card.track, date: card.date },
    phase,
    races,
    skippedRaces,
    tierDistribution,
    gradedRaces,
    stats,
  };
}

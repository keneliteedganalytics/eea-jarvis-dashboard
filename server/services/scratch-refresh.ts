// Scratch-refresh (PR #20).
//
// An already-ingested, locked card carries one prediction row per horse per
// race. Morning scratches come out at the track after the card was built. This
// service re-reads the card's stored source roster (the Equibase + Brisnet
// parsed_json blobs persisted at ingest time) and diffs it against the DB
// prediction rows:
//   • A prediction whose program number is no longer in the source roster is
//     flagged scratched = 1, scratchedAt = now().
//   • A prediction already scratched but back in the source roster is
//     re-instated (scratched = 0, scratchedAt = null) — entry reinstatements
//     do happen.
// Prediction rows are NEVER deleted, so a scratched horse keeps its analysis
// history. After applying scratches to a race we recompute the race tier +
// picks from the surviving (non-scratched) runners.
//
// "From cache or source": we read the parsed_json blobs that ingest already
// persisted on pp_uploads. That is the card's source-of-record roster and
// avoids a live re-fetch (and the live subscriptions) on every 15-min sweep.
// When neither source blob is present/parseable we fail safe: no writes.

import { storage } from "../storage";
import { sqlite } from "../db";
import type { BrisnetCard, EquibaseCard } from "./parsers/types";
import { classifyRaceType, assignTier, type FusedRace, type Tier } from "./eea-fusion";
import { DEFAULT_WEIGHTS, type EeaWeights } from "./eea-config";
import type { Race } from "@shared/schema";

// Active formula weights, falling back to the defaults (same resolution the
// analyze-card path uses). Tier classification keys off these.
function loadWeights(): EeaWeights {
  const active = storage.getActiveFormulaVersion();
  if (active?.weightsJson) {
    try {
      return JSON.parse(active.weightsJson) as EeaWeights;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_WEIGHTS;
}

export interface ScratchChange {
  raceNumber: number;
  horsePgm: string;
  horseName: string;
}

export interface ScratchRefreshSummary {
  cardId: number;
  racesChecked: number;
  newScratches: ScratchChange[];
  reinstated: ScratchChange[];
  unchangedCount: number;
}

// Returned (instead of a summary) when the diff could not run safely. The DB is
// left untouched. `reason` is a short machine-ish string for the cron log.
export interface ScratchRefreshError {
  cardId: number;
  ok: false;
  reason: string;
}

export type ScratchRefreshResult = ScratchRefreshSummary | ScratchRefreshError;

export function isScratchRefreshError(
  r: ScratchRefreshResult,
): r is ScratchRefreshError {
  return (r as ScratchRefreshError).ok === false;
}

// The current source roster keyed by race number → set of program numbers.
// Built from the union of the Equibase and Brisnet rosters (a horse present in
// either source is considered still entered).
function sourceRosterByRace(cardId: number): Map<number, Set<string>> | null {
  const rows = sqlite
    .prepare(
      "SELECT source, parsed_json FROM pp_uploads WHERE card_id = ? AND parsed_json IS NOT NULL",
    )
    .all(cardId) as { source: string; parsed_json: string }[];

  let bris: BrisnetCard | undefined;
  let equi: EquibaseCard | undefined;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.parsed_json);
      if (row.source === "brisnet") bris = parsed as BrisnetCard;
      else if (row.source === "equibase") equi = parsed as EquibaseCard;
    } catch {
      /* skip unparseable blob */
    }
  }

  // No usable source at all → caller fails safe (no writes).
  if (!bris && !equi) return null;

  const byRace = new Map<number, Set<string>>();
  const add = (raceNumber: number, pgm: string) => {
    const set = byRace.get(raceNumber) ?? new Set<string>();
    set.add(pgm);
    byRace.set(raceNumber, set);
  };
  for (const r of bris?.races ?? []) {
    for (const h of r.horses) add(r.raceNumber, h.pgm);
  }
  for (const r of equi?.races ?? []) {
    for (const h of r.horses) add(r.raceNumber, h.pgm);
  }
  return byRace;
}

// Recompute a race's tier + flattened picks from the SURVIVING (non-scratched)
// runners. The tier classifier is a pure function of the ranked runner set, so
// we rebuild a minimal FusedRace from the stored prediction ratings (which
// already bake in every figure/weather/bloodstock adjustment), re-rank, and run
// assignTier. The leader's tier becomes the race tier; the top-4 survivors
// become win/place/show/fourth. If every runner is scratched the race goes PASS.
//
// Exported so the endpoint/tests can drive it directly. Idempotent.
export function recomputeTierIfNeeded(raceId: number): void {
  const race = storage.getRace(raceId);
  if (!race) return;
  const preds = storage.getPredictionsByRace(raceId);
  if (preds.length === 0) return;

  const survivors = preds
    .filter((p) => !p.scratched && p.eeaRating != null)
    .sort((a, b) => (b.eeaRating ?? -Infinity) - (a.eeaRating ?? -Infinity));

  if (survivors.length === 0) {
    storage.updateRaceFusion(raceId, {
      tier: "PASS",
      winPgm: null, winName: null, winScore: null,
      placePgm: null, placeName: null, placeScore: null,
      showPgm: null, showName: null, showScore: null,
      fourthPgm: null, fourthName: null, fourthScore: null,
    });
    return;
  }

  const weights = loadWeights();
  const bankroll = storage.getSettings().bankroll;
  const raceType = classifyRaceType({
    type: "UNKNOWN",
    raw: race.conditions ?? "",
  });

  // Minimal FusedRace: assignTier only reads horses[].pgm/eeaRating/rank and
  // fused.raceType. Other FusedHorse fields are filled with inert defaults.
  const fused: FusedRace = {
    raceNumber: race.raceNumber,
    raceType,
    conditions: { type: "UNKNOWN", raw: race.conditions ?? "" },
    shapeNote: race.shape ?? "",
    weatherAdjustment: { applied: false, surface: "unknown", reasonCodes: [] },
    horses: survivors.map((p, i) => ({
      pgm: p.horsePgm,
      name: p.horseName,
      isMaiden: raceType === "msw",
      eeas: p.eeas,
      eeap: p.eeap,
      eeapFit: null,
      eeac: p.eeac,
      eeaRating: p.eeaRating,
      mlOdds: null,
      rank: i + 1,
      flags: [],
      bloodstockAdjustment: {
        applied: false,
        composite: 50,
        reasonCodes: [],
        confidence: "none",
        ratingDelta: 0,
      },
    })),
  };

  const tiers = assignTier(fused, bankroll, weights);
  const leader = survivors[0];
  const leaderTier = (tiers.find((t) => t.pgm === leader.horsePgm)?.tier ?? "PASS") as Tier;
  const round1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  const slot = (i: number) => survivors[i];

  storage.updateRaceFusion(raceId, {
    tier: leaderTier,
    winPgm: slot(0)?.horsePgm ?? null,
    winName: slot(0)?.horseName ?? null,
    winScore: round1(slot(0)?.eeaRating ?? null),
    placePgm: slot(1)?.horsePgm ?? null,
    placeName: slot(1)?.horseName ?? null,
    placeScore: round1(slot(1)?.eeaRating ?? null),
    showPgm: slot(2)?.horsePgm ?? null,
    showName: slot(2)?.horseName ?? null,
    showScore: round1(slot(2)?.eeaRating ?? null),
    fourthPgm: slot(3)?.horsePgm ?? null,
    fourthName: slot(3)?.horseName ?? null,
    fourthScore: round1(slot(3)?.eeaRating ?? null),
  });
}

// Diff the DB roster against the current source roster for a locked card and
// apply scratches / reinstatements. Never throws; returns a structured error
// instead so the cron + endpoint can log + degrade. Never deletes rows.
export function refreshScratchesForCard(cardId: number): ScratchRefreshResult {
  const card = storage.getCard(cardId);
  if (!card) {
    return { cardId, ok: false, reason: "card-not-found" };
  }
  // Unlocked cards are handled by the re-ingest path; refresh is a no-op here.
  if (!card.locked) {
    return { cardId, ok: false, reason: "card-not-locked" };
  }

  const roster = sourceRosterByRace(cardId);
  if (!roster) {
    return { cardId, ok: false, reason: "source-unavailable" };
  }

  const races = storage.getRacesByCard(cardId);
  const nowIso = new Date().toISOString();
  const summary: ScratchRefreshSummary = {
    cardId,
    racesChecked: 0,
    newScratches: [],
    reinstated: [],
    unchangedCount: 0,
  };

  for (const race of races) {
    const sourcePgms = roster.get(race.raceNumber);
    // A race with no source roster entry at all is ambiguous (could be a parse
    // gap, not a full scratch). Skip it rather than scratch the whole field.
    if (!sourcePgms) continue;
    summary.racesChecked++;

    let tierDirty = false;
    for (const p of storage.getPredictionsByRace(race.id)) {
      const inSource = sourcePgms.has(p.horsePgm);
      if (!inSource && !p.scratched) {
        storage.updatePrediction(p.id, { scratched: true, scratchedAt: nowIso });
        summary.newScratches.push({
          raceNumber: race.raceNumber,
          horsePgm: p.horsePgm,
          horseName: p.horseName,
        });
        tierDirty = true;
      } else if (inSource && p.scratched) {
        storage.updatePrediction(p.id, { scratched: false, scratchedAt: null });
        summary.reinstated.push({
          raceNumber: race.raceNumber,
          horsePgm: p.horsePgm,
          horseName: p.horseName,
        });
        tierDirty = true;
      } else {
        summary.unchangedCount++;
      }
    }

    if (tierDirty) recomputeTierIfNeeded(race.id);
  }

  // Refresh the card-level conviction off the new per-race tiers.
  const refreshed = storage.getRacesByCard(cardId);
  storage.updateCard(cardId, {
    cardConviction: convictionFromTiers(refreshed),
  });

  return summary;
}

// HIGH if any SNIPER (or 2+ EDGE), MEDIUM if any actionable tier, else LOW.
// Mirrors computeCardConviction in card-finishing but reads off race rows.
function convictionFromTiers(races: Race[]): "HIGH" | "MEDIUM" | "LOW" {
  const tiers = races.map((r) => r.tier);
  const snipers = tiers.filter((t) => t === "SNIPER").length;
  const edges = tiers.filter((t) => t === "EDGE").length;
  const actionable = tiers.filter((t) => t !== "PASS").length;
  if (snipers >= 1 || edges >= 2) return "HIGH";
  if (actionable >= 1) return "MEDIUM";
  return "LOW";
}

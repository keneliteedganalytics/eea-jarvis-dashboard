/**
 * Bias Service — v3.2
 *
 * Glue between storage (graded races) and the pure track_bias_detector.
 * Pulls each graded race on a card, extracts the winner's PP + style hint,
 * and returns the live bias state for the dashboard + Monte Carlo input.
 */
import { storage } from "../storage";
import {
  detectBias,
  type BiasState,
  type GradedRaceInput,
} from "./track_bias_detector";

interface RaceLite {
  id: number;
  raceNumber: number;
  winPgm?: string | null;
  paceText?: string | null;
}

/**
 * Heuristic: derive winner's pace_early from race.paceText when available.
 * Looks for tokens like "pace_early=2.2" or "PE 2.2". Falls back to null
 * (which the detector treats as STALKER).
 */
function inferPaceEarly(paceText: string | null | undefined): number | null {
  if (!paceText) return null;
  const m =
    paceText.match(/pace[_ ]early[=:\s]+(-?\d+(?:\.\d+)?)/i) ||
    paceText.match(/\bPE[=:\s]+(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

export function getBiasStateForCard(cardId: number): BiasState {
  const card = storage.getCardWithRaces(cardId);
  if (!card) {
    return {
      active: false,
      nGraded: 0,
      hotPps: [],
      deadPps: [],
      ppWinRates: {},
      styleBias: null,
      styleDistribution: {},
      confidence: 0,
      thresholds: {
        hotPpThreshold: 0.45,
        minRacesForSignal: 3,
        minRacesForDeadPp: 4,
        styleBiasThreshold: 0.6,
      },
    };
  }

  const gradedInputs: GradedRaceInput[] = [];
  for (const race of card.races) {
    const result = storage.getResultByRace(race.id);
    if (!result) continue;
    let finish: string[] = [];
    try {
      const parsed = JSON.parse(result.finishOrder ?? "[]");
      if (Array.isArray(parsed)) finish = parsed.map(String);
    } catch {
      finish = [];
    }
    const winnerPp = finish[0];
    if (!winnerPp) continue;

    // All PPs in this race = scratched + win/place/show/fourth picks.
    // Since we don't have a horses table, approximate from picks.
    const allPps = new Set<string>();
    for (const p of [race.winPgm, race.placePgm, race.showPgm, race.fourthPgm]) {
      if (p) allPps.add(String(p));
    }
    if (winnerPp) allPps.add(winnerPp);
    if (finish[1]) allPps.add(finish[1]);
    if (finish[2]) allPps.add(finish[2]);

    gradedInputs.push({
      raceNumber: race.raceNumber,
      winnerPp,
      winnerPaceEarly: inferPaceEarly(race.paceText),
      allPps: Array.from(allPps),
    });
  }
  // Sort by race number
  gradedInputs.sort((a, b) => a.raceNumber - b.raceNumber);

  return detectBias(gradedInputs);
}

/**
 * Recalibrate trigger: given a card, compute bias state + persist a snapshot
 * note onto each remaining (ungraded) race's whyText so the dashboard reflects
 * the update without re-running Monte Carlo (that's offline / next session).
 *
 * Returns the bias state + the list of race IDs that were annotated.
 */
export function recalibrateFromBias(cardId: number): {
  biasState: BiasState;
  remainingRaceIds: number[];
  annotations: Array<{ raceId: number; raceNumber: number; note: string }>;
} {
  const biasState = getBiasStateForCard(cardId);
  const card = storage.getCardWithRaces(cardId);
  const annotations: Array<{
    raceId: number;
    raceNumber: number;
    note: string;
  }> = [];
  const remainingRaceIds: number[] = [];

  if (!card) {
    return { biasState, remainingRaceIds, annotations };
  }

  if (!biasState.active) {
    return { biasState, remainingRaceIds, annotations };
  }

  for (const race of card.races) {
    const result = storage.getResultByRace(race.id);
    if (result) continue; // skip graded
    remainingRaceIds.push(race.id);

    // Build a transparent annotation
    const parts: string[] = [];
    parts.push(
      `[v3.2 bias @ R${race.raceNumber}] hot_pps=${JSON.stringify(biasState.hotPps)} dead_pps=${JSON.stringify(biasState.deadPps)} style_bias=${biasState.styleBias ?? "none"} conf=${biasState.confidence.toFixed(2)}.`,
    );
    // Per-anchor note
    const anchor = race.winPgm;
    if (anchor) {
      const adj: string[] = [];
      if (biasState.hotPps.includes(String(anchor))) adj.push("HOT-PP +1.5");
      if (biasState.deadPps.includes(String(anchor))) adj.push("DEAD-PP -0.5");
      parts.push(
        `Anchor #${anchor}: ${adj.length ? adj.join(", ") : "no PP adj"}.`,
      );
    }

    const newNote = parts.join(" ");
    const existing = race.whyText ?? "";
    // Strip any prior [v3.2 bias ...] line and prepend a fresh one
    const stripped = existing.replace(/\[v3\.2 bias[^\]]*\][^\n]*\n?/g, "");
    const updated = `${newNote}\n${stripped}`.trim();
    storage.updateRaceText(race.id, updated, race.paceText ?? undefined);
    annotations.push({
      raceId: race.id,
      raceNumber: race.raceNumber,
      note: newNote,
    });
  }

  return { biasState, remainingRaceIds, annotations };
}

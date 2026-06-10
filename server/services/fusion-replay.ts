// Fusion Replay mode (PR #28).
//
// Closed-loop validation for PR #27's tier-tuning v2 rules. After we ship new
// fusion logic, we need to know how it would have graded a card WITHOUT waiting
// for fresh races. Replay re-runs PR #27's `assignTierV2` against the PRESERVED
// predictions snapshot (the per-horse eeas/eeap/eeac/eeaRating + bloodstock that
// were locked at analysis time) — it does NOT re-ingest Equibase/Brisnet.
//
// The snapshot doesn't persist the per-horse fusion flags (projected-lone-speed,
// in-pace-duel) that `deriveFusionFactors` reads, so we reconstruct a faithful
// `FusedRace` from what IS preserved: the per-horse composites + bloodstock, the
// race-row shape note (e.g. "lone speed (#5)" / "contested pace (3 early types)")
// and conditions. From that we re-derive the same pace flags fusion would have
// produced, then hand the rebuilt race straight to the live `assignTierV2`. This
// means replay exercises the EXACT rule code the live path uses — no fork.

import { storage } from "../storage";
import { DEFAULT_WEIGHTS, type EeaWeights } from "./eea-config";
import {
  assignTierV2,
  classifyRaceType,
  type FusedHorse,
  type FusedRace,
  type BloodstockAdjustment,
} from "./eea-fusion";
import type { RaceConditions } from "./parsers/types";
import type {
  CardWithRaces,
  RaceWithResult,
  Prediction,
  FusionReplay,
  FusionRaceDiff,
} from "@shared/schema";

// Map a v2 race-flag string to the canonical rule name the diff surfaces. The
// flags `assignTierV2` emits are prefixed with the rule id (e.g.
// "A1_DUAL_DOWNGRADE on #5 ...") — we collapse them to a stable rule label.
const RULE_PREFIXES: { prefix: string; rule: string }[] = [
  { prefix: "A1_DUAL_DOWNGRADE", rule: "DUAL_EARNED_CLASS_GATE" },
  { prefix: "RATING_GAP_PENALTY", rule: "RATING_GAP_PENALTY" },
  { prefix: "HONESTY_CHECK", rule: "HONESTY_CHECK" },
  { prefix: "PASS_COMPRESSION_PROMOTION", rule: "PASS_COMPRESSION_PROMOTION" },
  { prefix: "SOFT_TIER_LAZY_BUCKET", rule: "SOFT_TIER_LAZY_BUCKET" },
];

// Load the active formula's figure weights (same resolution analyze-card uses);
// fall back to the defaults when no active version / unparseable weights.
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

function rulesFiredFrom(raceFlags: string[]): string[] {
  const fired = new Set<string>();
  for (const f of raceFlags) {
    for (const { prefix, rule } of RULE_PREFIXES) {
      if (f.startsWith(prefix)) fired.add(rule);
    }
  }
  return Array.from(fired);
}

// Parse a stored bloodstockJson back into the adjustment shape fusion produces.
// Falls back to an inert (confidence "none") adjustment when absent/malformed so
// `deriveFusionFactors` treats the horse as ungraded rather than crashing.
function parseBloodstock(json: string | null | undefined): BloodstockAdjustment {
  const inert: BloodstockAdjustment = {
    applied: false,
    composite: 50,
    reasonCodes: [],
    confidence: "none",
    ratingDelta: 0,
  };
  if (!json) return inert;
  try {
    const b = JSON.parse(json) as Partial<BloodstockAdjustment>;
    return {
      applied: !!b.applied,
      composite: typeof b.composite === "number" ? b.composite : 50,
      reasonCodes: Array.isArray(b.reasonCodes) ? b.reasonCodes.map(String) : [],
      confidence: (b.confidence as BloodstockAdjustment["confidence"]) ?? "none",
      ratingDelta: typeof b.ratingDelta === "number" ? b.ratingDelta : 0,
    };
  } catch {
    return inert;
  }
}

// Build a minimal RaceConditions from the flattened race-row conditions string.
// `classifyRaceType` reads `type` + `raw`; we hand it the raw text and let it
// pattern-match (MSW/CLM/STK/ALW) exactly as the live path does at analysis time.
function reconstructConditions(race: RaceWithResult): RaceConditions {
  const raw = race.conditions ?? "";
  return {
    type: "UNKNOWN",
    raw,
    surface: /turf/i.test(raw) ? "TURF" : /dirt|main/i.test(raw) ? "DIRT" : "",
    distance: "",
  } as RaceConditions;
}

// Re-derive the per-horse pace flags fusion would have stamped (the ones
// `deriveFusionFactors` keys off), from the preserved pace composites + the
// race-row shape note. fuseRace tags horses within 2 pts of the field's top
// EEAP as "early types"; lone speed → "projected-lone-speed", contested →
// "in-pace-duel". Replaying that on the snapshot reconstructs the same factor
// inputs without re-running fusion's figure math.
function reconstructPaceFlags(
  horses: { pgm: string; eeap: number | null }[],
  shapeNote: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of horses) out.set(h.pgm, []);

  const paceVals = horses.map((h) => h.eeap).filter((v): v is number => v != null);
  if (paceVals.length === 0) return out;
  const maxPace = Math.max(...paceVals);
  const earlyTypes = horses.filter((h) => h.eeap != null && h.eeap >= maxPace - 2);

  const shape = shapeNote.toLowerCase();
  const loneSpeed = shape.includes("lone speed") && earlyTypes.length === 1;
  const contested = shape.includes("contested") || earlyTypes.length >= 2;

  if (loneSpeed) {
    out.get(earlyTypes[0].pgm)?.push("projected-lone-speed");
  } else if (contested) {
    for (const h of earlyTypes) out.get(h.pgm)?.push("in-pace-duel");
  }
  return out;
}

// Rebuild a FusedRace for one persisted race from its predictions snapshot. The
// horses carry the locked composites + bloodstock; ranking is by eeaRating (the
// same order fuseRace produces) so leader/2nd-best line up for the v2 rules.
export function reconstructFusedRace(race: RaceWithResult, preds: Prediction[]): FusedRace {
  const conditions = reconstructConditions(race);
  const raceType = classifyRaceType(conditions);
  const shapeNote = race.shape ?? "honest pace";

  // Exclude scratched horses — the live tier path ranks only the active roster.
  const active = preds.filter((p) => !p.scratched);
  const paceInputs = active.map((p) => ({ pgm: p.horsePgm, eeap: p.eeap ?? null }));
  const flagsByPgm = reconstructPaceFlags(paceInputs, shapeNote);

  const horses: FusedHorse[] = active.map((p) => {
    const blood = parseBloodstock(p.bloodstockJson);
    const flags = [...(flagsByPgm.get(p.horsePgm) ?? [])];
    if (blood.applied && blood.reasonCodes.some((c) => /wet/.test(c))) {
      flags.push("wet-track-boost");
    }
    return {
      pgm: p.horsePgm,
      name: p.horseName,
      isMaiden: raceType === "msw",
      eeas: p.eeas ?? null,
      // The persisted `eeap` is the shape-adjusted eeapFit (analyze-card stores
      // `eeapFit ?? eeap`), so expose it as both so factor derivation matches.
      eeap: p.eeap ?? null,
      eeapFit: p.eeap ?? null,
      eeac: p.eeac ?? null,
      eeaRating: p.eeaRating ?? null,
      mlOdds: null,
      rank: p.rank ?? 0,
      flags,
      bloodstockAdjustment: blood,
    };
  });

  // Rank by EEA Rating (nulls last) so rank reflects the rating order the tier
  // rules expect, regardless of the persisted rank (which may carry LLM order).
  horses.sort((a, b) => (b.eeaRating ?? -Infinity) - (a.eeaRating ?? -Infinity));
  horses.forEach((h, i) => (h.rank = i + 1));

  return {
    raceNumber: race.raceNumber,
    raceType,
    conditions,
    shapeNote,
    horses,
    weatherAdjustment: {
      applied: false,
      surface: (race.weather?.surfaceImpact ?? "unknown") as FusedRace["weatherAdjustment"]["surface"],
      reasonCodes: [],
    },
  };
}

// finishOrder[0] is the actual winner's program number.
function actualWinnerPgm(race: RaceWithResult): string | null {
  if (!race.result) return null;
  try {
    const fo = JSON.parse(race.result.finishOrder) as unknown;
    if (Array.isArray(fo) && fo.length > 0) return String(fo[0]);
  } catch {
    /* ignore */
  }
  return null;
}

// The horse we originally topped: the prediction ranked #1 (active), else the
// flattened win pick on the race row.
function originalTopPick(
  race: RaceWithResult,
  preds: Prediction[],
): { pgm: string | null; name: string; tier: string; rating: number } {
  const ranked = preds
    .filter((p) => !p.scratched && p.rank != null)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  if (ranked.length) {
    const t = ranked[0];
    return {
      pgm: t.horsePgm,
      name: t.horseName,
      tier: t.tierAssigned ?? race.tier,
      rating: t.eeaRating ?? race.winScore ?? 0,
    };
  }
  return {
    pgm: race.winPgm ?? null,
    name: race.winName ?? `#${race.winPgm ?? "?"}`,
    tier: race.tier,
    rating: race.winScore ?? 0,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Build the per-race diff: rebuild the race, re-run assignTierV2, and compare the
// replayed top pick/tier against the original. wouldHaveCaught / wouldHaveLost are
// only meaningful for graded races (we know the winner).
function buildDiff(race: RaceWithResult, preds: Prediction[]): FusionRaceDiff {
  const fused = reconstructFusedRace(race, preds);
  const weights = loadWeights();
  const bankroll = storage.getSettings().bankroll;
  const assignment = assignTierV2(fused, bankroll, weights);

  // Replayed top pick = highest-rated active horse (rank 1 after the rating sort)
  // and the tier the v2 rules landed it on.
  const replayedLeader = fused.horses[0];
  const replayedTierByPgm = new Map(assignment.tiers.map((t) => [t.pgm, t.tier]));
  const replayedTier = replayedLeader
    ? (replayedTierByPgm.get(replayedLeader.pgm) ?? "PASS")
    : "PASS";

  const orig = originalTopPick(race, preds);
  const winnerPgm = actualWinnerPgm(race);
  const graded = winnerPgm != null;

  const replayedTopPgm = replayedLeader?.pgm ?? null;
  const changed = replayedTopPgm !== orig.pgm || replayedTier !== orig.tier;

  // wouldHaveCaught: the race is graded, the replayed top pick differs from the
  // original, and the replayed top pick is the actual winner (we'd have flipped
  // onto the winner). wouldHaveLost: the original top pick WON but the replayed
  // logic flipped the top pick away from it.
  const replayedTopIsWinner = graded && replayedTopPgm === winnerPgm;
  const origTopWasWinner = graded && orig.pgm === winnerPgm;
  const flippedAway = replayedTopPgm !== orig.pgm;
  const wouldHaveCaught = !!(graded && flippedAway && replayedTopIsWinner && !origTopWasWinner);
  const wouldHaveLost = !!(graded && origTopWasWinner && flippedAway && !replayedTopIsWinner);

  const winnerName =
    (winnerPgm != null
      ? preds.find((p) => p.horsePgm === winnerPgm)?.horseName
      : null) ?? (winnerPgm != null ? `#${winnerPgm}` : "");

  return {
    raceNumber: race.raceNumber,
    actualWinner: { program: winnerPgm ?? "", horse: winnerName },
    original: { tier: orig.tier, topPick: orig.name, rating: round1(orig.rating) },
    replayed: {
      tier: replayedTier,
      topPick: replayedLeader?.name ?? orig.name,
      rating: round1(replayedLeader?.eeaRating ?? 0),
    },
    changed,
    newFlags: assignment.raceFlags,
    rulesFired: rulesFiredFrom(assignment.raceFlags),
    wouldHaveCaught,
    wouldHaveLost,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────
// Replay one card through the latest fusion logic. In-memory only — cheap to
// recompute, never persisted. Throws if the card doesn't exist.
export function runFusionReplay(cardId: number): FusionReplay {
  const card = storage.getCardWithRaces(cardId);
  if (!card) throw new Error(`Card ${cardId} not found`);

  const diffs = card.races
    .map((race) => {
      const preds = storage.getPredictionsByRace(race.id);
      // A race with no preserved predictions can't be replayed (hand-seeded card).
      if (preds.length === 0) return null;
      return buildDiff(race, preds);
    })
    .filter((d): d is FusionRaceDiff => d != null);

  const graded = card.races.filter((r) => r.result).length;
  const tierChanges = diffs.filter((d) => d.original.tier !== d.replayed.tier).length;
  const flagsAdded = diffs.reduce((a, d) => a + d.newFlags.length, 0);
  const missesCaught = diffs.filter((d) => d.wouldHaveCaught).length;
  const missesIntroduced = diffs.filter((d) => d.wouldHaveLost).length;

  return {
    cardId: card.id,
    track: card.track,
    date: card.date,
    generatedAt: new Date().toISOString(),
    raceCount: card.races.length,
    graded,
    diffs,
    summary: {
      tierChanges,
      flagsAdded,
      missesCaught,
      missesIntroduced,
      netImprovement: missesCaught - missesIntroduced,
    },
  };
}

// Replay every graded card dated today. Returns one FusionReplay per card.
export function runFusionReplayToday(): FusionReplay[] {
  const today = new Date().toISOString().slice(0, 10);
  const cards = storage
    .getCards()
    .filter((c) => c.date === today)
    .map((c) => storage.getCardWithRaces(c.id))
    .filter((c): c is CardWithRaces => !!c && c.races.some((r) => r.result));
  return cards.map((c) => runFusionReplay(c.id));
}

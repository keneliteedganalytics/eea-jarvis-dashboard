// Bloodstock fitness (PR #16 Phase 2).
//
// Turns sire / dam / dam-sire pedigree into a small, transparent handicapping
// signal: surface aptitude (turf vs dirt), distance aptitude (sprint vs route),
// and wet-track aptitude (only relevant on an off track). The score is a 0-100
// composite plus a confidence band; the fusion engine (eea-fusion.ts) converts
// it into a capped EEA-Rating bias and never applies it when confidence is
// "none".
//
// ── Why a curated sire reference, not the raw DR2 stat block ─────────────────
// The Brisnet DRM .DR2 row carries the sire/dam/dam-sire NAMES at reliably
// anchored offsets (verified against the FL 2026-06-08 fixture) AND a 24-integer
// "pedigree stat" block at fields 165..188. We persist that raw block, but its
// per-column semantics (which slot is mud vs turf vs sprint, count vs win%) are
// NOT documented for the multi-file layout — the published BRIS field guide
// covers the single-file format, whose offsets differ, and the block does not
// decode cleanly as [starts, win%] pairs in the fixture. Inventing a mapping
// would risk silently biasing ratings on misread numbers, which violates the
// hard rule "never bias on missing/uncertain data". So the scorer keys off the
// NAMES against a curated aptitude reference of well-known North American sires
// and broodmare sires. Unknown names → no signal → confidence falls toward
// "none". The raw block is preserved in the DB so a future PR can decode it and
// swap in real per-sire sample sizes without a re-download.
//
// ── Bayesian shrinkage ──────────────────────────────────────────────────────
// Every reference entry carries a notional sample size n (how many starters the
// aptitude figure is based on). A small-sample sire is shrunk toward the league
// mean so a "33% turf on 3 runners" sire is not treated like a proven one:
//
//     shrunk = (n * rate + k * PRIOR) / (n + k)
//
// with PRIOR = leaguePriorPct (~13%) and k = shrinkageK pseudo-starters. Rates
// here are on a 0-100 aptitude scale (50 = league-neutral), so we shrink toward
// 50 for the *aptitude* figures and toward the win-rate prior only where we
// reason in win-rate terms; see shrinkAptitude / shrinkWinRate below.

import { DEFAULT_WEIGHTS, type EeaWeights } from "./services/eea-config";
import type { RaceConditions } from "./services/parsers/types";

export type BloodstockConfidence = "high" | "medium" | "low" | "none";

export interface BloodstockFitness {
  surfaceFit: number; // 0-100, 50 = neutral
  distanceFit: number; // 0-100
  wetFit: number; // 0-100 (only meaningful on an off track)
  firstTimerBonus: number; // 0-15
  composite: number; // 0-100
  reasonCodes: string[];
  confidence: BloodstockConfidence;
}

// Per-horse bloodstock input. Names come from the DRM parser; lifetimeStarts and
// the wet surface flag come from the race/PP context. All optional so the scorer
// degrades to confidence "none" rather than throwing.
export interface BloodstockHorse {
  sireName?: string | null;
  damName?: string | null;
  damSireName?: string | null;
  lifetimeStarts?: number | null;
}

// Race context the fitness depends on. surfaceWet is true only when PR #18's
// surfaceImpact ∈ {wet, sloppy, muddy} (the engine passes that through).
export interface BloodstockRace {
  conditions: RaceConditions;
  surfaceWet?: boolean;
}

// ── Curated sire / broodmare-sire aptitude reference ────────────────────────
// Each figure is a 0-100 aptitude (50 = league-neutral). `n` is the notional
// sample size used by shrinkage. Kept deliberately small and high-confidence —
// recognizable North American influences with well-established surface/distance
// /wet tendencies. Unknown sires simply return no entry (→ neutral, low/none
// confidence). Names are matched case-insensitively after normalization.
export interface SireAptitude {
  turf: number; // turf surface aptitude
  dirt: number; // dirt surface aptitude
  wet: number; // off-track aptitude
  sprint: number; // sprint (≤ ~7f) aptitude
  route: number; // route (≥ ~1mi) aptitude
  n: number; // notional starters behind these figures
}

const NEUTRAL = 50;

// A compact, intentionally conservative table. Figures are directional, not
// precise win rates — high (≈70-85) = clear specialist, low (≈20-35) = clear
// weakness, ~50 = no strong lean. Sample sizes reflect how established each
// influence is (big classic sires get large n; niche/young sires get small n
// so shrinkage pulls them toward neutral).
export const SIRE_APTITUDE: Record<string, SireAptitude> = {
  // ── Turf-leaning influences ──
  "WAR FRONT": { turf: 82, dirt: 52, wet: 55, sprint: 60, route: 72, n: 300 },
  "KITTEN'S JOY": { turf: 85, dirt: 40, wet: 50, sprint: 45, route: 80, n: 260 },
  "ENGLISH CHANNEL": { turf: 84, dirt: 38, wet: 52, sprint: 40, route: 82, n: 200 },
  "MORE THAN READY": { turf: 70, dirt: 58, wet: 55, sprint: 68, route: 58, n: 320 },
  "POINT OF ENTRY": { turf: 78, dirt: 45, wet: 50, sprint: 42, route: 78, n: 90 },
  // ── Dirt / wet (mud) influences ──
  CURLIN: { turf: 50, dirt: 80, wet: 72, sprint: 55, route: 78, n: 340 },
  "INTO MISCHIEF": { turf: 52, dirt: 78, wet: 68, sprint: 72, route: 62, n: 360 },
  TAPIT: { turf: 55, dirt: 80, wet: 74, sprint: 52, route: 80, n: 330 },
  CONSTITUTION: { turf: 54, dirt: 74, wet: 66, sprint: 58, route: 74, n: 180 },
  SPEIGHTSTOWN: { turf: 56, dirt: 72, wet: 70, sprint: 82, route: 45, n: 240 },
  MALIBU_MOON: { turf: 50, dirt: 70, wet: 64, sprint: 66, route: 58, n: 220 },
  "PALACE MALICE": { turf: 52, dirt: 68, wet: 66, sprint: 55, route: 70, n: 110 },
  "QUALITY ROAD": { turf: 54, dirt: 74, wet: 70, sprint: 64, route: 66, n: 200 },
  // ── Sprint-leaning influences ──
  MUNNINGS: { turf: 55, dirt: 68, wet: 60, sprint: 80, route: 40, n: 200 },
  "RUN AWAY AND HIDE": { turf: 48, dirt: 62, wet: 55, sprint: 78, route: 35, n: 70 },
  "STORM CAT": { turf: 66, dirt: 66, wet: 68, sprint: 70, route: 58, n: 280 },
  "BOUNDARY": { turf: 58, dirt: 60, wet: 60, sprint: 74, route: 44, n: 80 },
};

// Broodmare-sire (dam-sire) influence on wet/turf/distance is real but lighter
// than the sire's; we reuse the same table for the dam-sire and down-weight it
// in the blend (see DAMSIRE_WEIGHT).
const DAMSIRE_WEIGHT = 0.4;

function lookupSire(name?: string | null): SireAptitude | null {
  if (!name) return null;
  const key = name.trim().toUpperCase();
  return SIRE_APTITUDE[key] ?? null;
}

// Shrink a 0-100 aptitude figure toward the neutral 50 using the entry's sample
// size. Small n → pulled to 50; large n → trusted. k is in pseudo-starters.
export function shrinkAptitude(value: number, n: number, k: number): number {
  if (n <= 0) return NEUTRAL;
  return (n * value + k * NEUTRAL) / (n + k);
}

// Distance bucket from the conditions. Falls back to "unknown" when we can't
// parse a distance — distance fit then stays neutral.
export type DistanceBucket = "sprint" | "route" | "unknown";

export function distanceBucket(conditions: RaceConditions): DistanceBucket {
  const d = (conditions.distance || "").toUpperCase().trim();
  if (!d) return "unknown";
  // Mile-or-more tokens → route. "F" furlong tokens < 8 → sprint.
  if (/\bM\b|MILE|1\s*\d?\/?\d?\s*M/.test(d)) return "route";
  const furlongs = d.match(/(\d+(?:\.\d+)?)\s*F/);
  if (furlongs) {
    const f = parseFloat(furlongs[1]);
    return f >= 8 ? "route" : "sprint";
  }
  // Yardage tokens (DRM uses yards, e.g. 660 = 3f): treat ≥ 1760y as route.
  const yards = d.match(/(\d{3,4})\s*Y?$/);
  if (yards) return parseInt(yards[1], 10) >= 1760 ? "route" : "sprint";
  return "unknown";
}

function isTurf(conditions: RaceConditions): boolean {
  return (conditions.surface || "").toUpperCase().includes("TURF");
}

// ── Main entry ──────────────────────────────────────────────────────────────
export function computeBloodstockFitness(
  horse: BloodstockHorse,
  race: BloodstockRace,
  weights: EeaWeights["bloodstock"] | undefined,
): BloodstockFitness {
  const w = weights ?? DEFAULT_WEIGHTS.bloodstock;
  const reasonCodes: string[] = [];
  const k = w.shrinkageK;

  const sire = lookupSire(horse.sireName);
  const damSire = lookupSire(horse.damSireName);

  // No recognizable pedigree at all → never bias.
  if (!sire && !damSire) {
    return {
      surfaceFit: NEUTRAL,
      distanceFit: NEUTRAL,
      wetFit: NEUTRAL,
      firstTimerBonus: 0,
      composite: NEUTRAL,
      reasonCodes: ["no-pedigree-data"],
      confidence: "none",
    };
  }

  const turf = isTurf(race.conditions);
  const bucket = distanceBucket(race.conditions);

  // Blend a sire figure with the down-weighted dam-sire figure, each shrunk by
  // its own sample size. When only one is known, that one carries the signal.
  const blend = (pick: (a: SireAptitude) => number): number => {
    let sum = 0;
    let w = 0;
    if (sire) {
      sum += shrinkAptitude(pick(sire), sire.n, k) * 1;
      w += 1;
    }
    if (damSire) {
      sum += shrinkAptitude(pick(damSire), damSire.n, k) * DAMSIRE_WEIGHT;
      w += DAMSIRE_WEIGHT;
    }
    return w > 0 ? sum / w : NEUTRAL;
  };

  // Surface fit: turf aptitude on turf, dirt aptitude on dirt.
  const surfaceFit = blend((a) => (turf ? a.turf : a.dirt));
  if (sire) {
    if (turf && sire.turf >= 70) reasonCodes.push(`sire-turf(${horse.sireName})`);
    if (!turf && sire.dirt >= 70) reasonCodes.push(`sire-dirt(${horse.sireName})`);
  }

  // Distance fit: sprint vs route aptitude matched to the race's bucket. Unknown
  // bucket → neutral (we don't guess).
  let distanceFit = NEUTRAL;
  if (bucket !== "unknown") {
    distanceFit = blend((a) => (bucket === "sprint" ? a.sprint : a.route));
    if (sire) {
      if (bucket === "sprint" && sire.sprint >= 70) reasonCodes.push("sire-sprint");
      if (bucket === "route" && sire.route >= 70) reasonCodes.push("sire-route");
    }
  }

  // Wet fit: sire AND dam-sire off-track aptitude combined. Only meaningful on a
  // wet/sloppy/muddy surface — otherwise reported but flagged not-relevant.
  const wetFit = blend((a) => a.wet);
  if (race.surfaceWet) {
    if (wetFit >= w.wetStrongComposite) reasonCodes.push("wet-pedigree-strong");
    else if (wetFit <= w.wetWeakComposite) reasonCodes.push("wet-pedigree-weak");
  }

  // First-timer bonus: pedigree matters more for lightly-raced horses. Scales
  // with how far the surface+distance signal sits above neutral, capped at max.
  const starts = horse.lifetimeStarts ?? null;
  let firstTimerBonus = 0;
  if (starts != null && starts < w.firstTimerStartsCutoff) {
    const lean = Math.max(0, (surfaceFit + distanceFit) / 2 - NEUTRAL); // 0..50
    firstTimerBonus = Math.min(
      w.firstTimerBonusMax,
      (lean / 50) * w.firstTimerBonusMax,
    );
    if (firstTimerBonus > 0) reasonCodes.push("first-timer-pedigree-lean");
  }

  // Composite: weighted blend of the four sub-fits. The wet term only enters on
  // a wet surface; off a dry track its weight is redistributed to surface so the
  // composite stays on the same 0-100 scale.
  const wWet = race.surfaceWet ? w.weights.wet : 0;
  const wSurface = w.weights.surface + (race.surfaceWet ? 0 : w.weights.wet);
  const composite =
    wSurface * surfaceFit +
    w.weights.distance * distanceFit +
    wWet * wetFit +
    w.weights.firstTimer * (NEUTRAL + firstTimerBonus * (50 / w.firstTimerBonusMax));

  // Confidence from how many of the two influences we actually recognized.
  const known = (sire ? 1 : 0) + (damSire ? 1 : 0);
  let confidence: BloodstockConfidence;
  if (known >= 2 && sire) confidence = "high";
  else if (sire) confidence = "medium";
  else if (known >= 1) confidence = "low";
  else confidence = "none";

  return {
    surfaceFit: round1(surfaceFit),
    distanceFit: round1(distanceFit),
    wetFit: round1(wetFit),
    firstTimerBonus: round1(firstTimerBonus),
    composite: round1(clamp(composite, 0, 100)),
    reasonCodes,
    confidence,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

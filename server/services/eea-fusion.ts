// EEA Hybrid Figure System — fuse Brisnet + Equibase figures into the EEA
// composites (EEAS speed, EEAP pace, EEAC class) and a single EEA Rating, then
// classify race type, evaluate layoff, and assign betting tiers.
//
// The composites operate on the raw figure scales the two sources publish
// (Brisnet/Equibase speed in the ~40-100 band, Prime Power / class ratings in
// the ~95-125 band). We blend the two sources per the configured weights and
// surface agreement/disagreement flags so the LLM can see where the books
// diverge. eeap_fit re-weights pace for the projected race shape + yesterday's
// bias so a lone speedster in a slow-pace, speed-favoring meet gets a boost.

import type { EeaWeights } from "./eea-config";
import type {
  BrisnetRace,
  BrisnetHorse,
  EquibaseRace,
  EquibaseHorse,
  RaceConditions,
} from "./parsers/types";
import {
  computeBloodstockFitness,
  type BloodstockConfidence,
} from "../bloodstock";

export type RaceType = "stakes_graded" | "allowance" | "claimer" | "msw";
export type Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

// Yesterday's track bias, as produced by the bias fetcher. All optional so
// fusion degrades gracefully when no bias card is available.
export interface BiasContext {
  runStyleBias?: "speed" | "closer" | "neutral" | null;
  railBias?: "good" | "bad" | "neutral" | null;
  note?: string | null;
}

// Per-horse bloodstock adjustment exposed on the analysis output, parallel to
// WeatherAdjustment. applied=false whenever confidence is "none" (or no data).
export interface BloodstockAdjustment {
  applied: boolean;
  composite: number;
  reasonCodes: string[];
  confidence: BloodstockConfidence;
  // Signed EEA-Rating points the bloodstock factor moved this horse by.
  ratingDelta: number;
}

export interface FusedHorse {
  pgm: string;
  name: string;
  isMaiden: boolean;
  eeas: number | null;
  eeap: number | null;
  eeapFit: number | null;
  eeac: number | null;
  eeaRating: number | null;
  // Morning-line odds as a decimal (e.g. "6-1" → 6, "9-2" → 4.5). Null when the
  // source carries no parseable ML. Used by the longshot co-top promotion check.
  mlOdds: number | null;
  rank: number;
  flags: string[];
  bloodstockAdjustment: BloodstockAdjustment;
}

// Parse a morning-line string ("6-1", "9-2", "7/2", "5", "EVN") into a decimal
// odds multiple. Returns null when nothing parseable is present.
export function parseMlOdds(ml: string | null | undefined): number | null {
  if (ml == null) return null;
  const s = ml.trim().toLowerCase();
  if (!s) return null;
  if (s === "evn" || s === "even" || s === "ev") return 1;
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*[-/]\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const num = parseFloat(frac[1]);
    const den = parseFloat(frac[2]);
    if (den > 0) return Math.round((num / den) * 100) / 100;
  }
  const whole = s.match(/^(\d+(?:\.\d+)?)$/);
  if (whole) return parseFloat(whole[1]);
  return null;
}

// Weather signal handed into fusion (PR #18). Only surfaceImpact is consumed by
// the engine; the rest rides along for the UI. surfaceImpact "unknown" (or a
// dry/damp surface) means NO pick is altered.
export type SurfaceImpact = "dry" | "damp" | "wet" | "sloppy" | "muddy" | "unknown";
export interface WeatherInput {
  surfaceImpact: SurfaceImpact;
}

// Exposed on FusedRace so downstream consumers (picks API, hero) can see why a
// rating moved. applied=false whenever weather is unknown/dry/damp.
export interface WeatherAdjustment {
  applied: boolean;
  surface: SurfaceImpact;
  reasonCodes: string[];
}

const OFF_TRACK = new Set<SurfaceImpact>(["wet", "sloppy", "muddy"]);

export interface FusedRace {
  raceNumber: number;
  raceType: RaceType;
  conditions: RaceConditions;
  shapeNote: string;
  horses: FusedHorse[];
  weatherAdjustment: WeatherAdjustment;
}

// ── Race classification ─────────────────────────────────────────────────────
export function classifyRaceType(conditions: RaceConditions): RaceType {
  const raw = (conditions.raw || "").toLowerCase();
  const type = (conditions.type || "").toUpperCase();
  if (type === "STK" || /stakes|\bstk\b|\(g[123]\)|graded|handicap/.test(raw)) {
    return "stakes_graded";
  }
  if (type === "MAIDEN" || /maiden|\bmsw\b|\bmcl\b|\bmdn\b|\bmd\b|\bmc\b/.test(raw)) {
    // Maiden claiming still behaves like a maiden for figure weighting.
    return "msw";
  }
  if (type === "CLM" || /claim|\bclm\b|\boptclm\b|\boc\b/.test(raw)) {
    return "claimer";
  }
  return "allowance";
}

// ── Layoff evaluation ───────────────────────────────────────────────────────
export function evaluateLayoff(
  daysSinceLast: number | null | undefined,
  raceType: RaceType,
  weights: EeaWeights,
): { status: "normal" | "needs_pattern" | "risky"; note: string } {
  if (daysSinceLast == null) {
    return { status: "normal", note: "no layoff data" };
  }
  // MSW has no layoff norm in the config; treat like allowance.
  const key = raceType === "msw" ? "allowance" : raceType;
  const band = weights.layoff[key as keyof EeaWeights["layoff"]];
  if (!band) return { status: "normal", note: "no layoff band" };
  if (daysSinceLast > band.needs_pattern_above) {
    return {
      status: "risky",
      note: `${daysSinceLast}d layoff exceeds ${band.needs_pattern_above}d — needs trainer-off-layoff evidence`,
    };
  }
  if (daysSinceLast > band.normal_max) {
    return {
      status: "needs_pattern",
      note: `${daysSinceLast}d layoff above ${band.normal_max}d normal — confirm trainer pattern`,
    };
  }
  return { status: "normal", note: `${daysSinceLast}d — within ${band.normal_min}-${band.normal_max}d norm` };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function avg(...vals: (number | null | undefined)[]): number | null {
  const xs = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Weighted blend that renormalizes over whichever inputs are present, so a
// missing source doesn't drag a composite toward zero.
function weightedBlend(parts: { value: number | null | undefined; weight: number }[]): number | null {
  let sum = 0;
  let wsum = 0;
  for (const p of parts) {
    if (p.value != null && Number.isFinite(p.value)) {
      sum += p.value * p.weight;
      wsum += p.weight;
    }
  }
  return wsum > 0 ? Math.round((sum / wsum) * 10) / 10 : null;
}

// ── Composites ──────────────────────────────────────────────────────────────
function computeEeas(
  b: BrisnetHorse | undefined,
  e: EquibaseHorse | undefined,
  w: EeaWeights["eeas"],
): { eeas: number | null; flags: string[] } {
  const brisSpeed = b?.speedLast ?? null;
  const equiSpeed = avg(e?.speedLast, e?.speedAvg3);
  const eeas = weightedBlend([
    { value: brisSpeed, weight: w.brisnet_speed },
    { value: equiSpeed, weight: w.equibase_speed },
  ]);
  const flags: string[] = [];
  if (brisSpeed != null && equiSpeed != null) {
    const gap = Math.abs(brisSpeed - equiSpeed);
    if (gap <= w.agreement_threshold) flags.push("speed-sources-agree");
    else if (gap >= w.disagreement_threshold) flags.push("speed-sources-disagree");
  }
  return { eeas, flags };
}

function computeEeap(b: BrisnetHorse | undefined, e: EquibaseHorse | undefined, w: EeaWeights["eeap"]): number | null {
  // Brisnet pace components live in BrisnetPace; fall back to Equibase pace
  // figures as a sanity anchor. Many v1 cards only carry the equibase pace.
  const e1 = b?.pace?.e1Last ?? b?.pace?.e1Avg3 ?? null;
  const e2 = b?.pace?.e2Last ?? b?.pace?.e2Avg3 ?? null;
  const lp = b?.pace?.lpLast ?? b?.pace?.lpAvg3 ?? null;
  const equiPace = avg(e?.paceLast, e?.paceAvg3, e?.paceHiLife);
  return weightedBlend([
    { value: e1, weight: w.brisnet_e1 },
    { value: e2, weight: w.brisnet_e2 },
    { value: lp, weight: w.brisnet_lp },
    { value: equiPace, weight: w.equibase_pace_sanity },
  ]);
}

function computeEeac(
  b: BrisnetHorse | undefined,
  e: EquibaseHorse | undefined,
  conditions: RaceConditions,
  w: EeaWeights["eeac"],
): number | null {
  const brisClass = b?.classRating ?? b?.primePower ?? null;
  const equiClass = e?.classRating ?? null;
  // Purse band overlay: map purse into the same ~100-band so it nudges class.
  const purseOverlay =
    conditions.purse != null ? 95 + Math.min(30, Math.log10(Math.max(1, conditions.purse)) * 6) : null;
  return weightedBlend([
    { value: brisClass, weight: w.brisnet_class },
    { value: equiClass, weight: w.equibase_class_avg3 },
    { value: purseOverlay, weight: w.purse_band_overlay },
  ]);
}

// eeap_fit: adjust EEAP for the projected pace shape + yesterday's bias.
function computeEeapFit(
  eeap: number | null,
  loneSpeed: boolean,
  contestedPace: boolean,
  bias: BiasContext | undefined,
): number | null {
  if (eeap == null) return null;
  let fit = eeap;
  if (loneSpeed) fit += 4; // uncontested early speed is a large edge
  if (contestedPace) fit -= 2; // pace duel hurts the speed types
  if (bias?.runStyleBias === "speed" && loneSpeed) fit += 2;
  if (bias?.runStyleBias === "closer" && loneSpeed) fit -= 2;
  return fit;
}

// ── Fusion ──────────────────────────────────────────────────────────────────
export function fuseRace(
  brisnetRace: BrisnetRace | undefined,
  equibaseRace: EquibaseRace | undefined,
  weights: EeaWeights,
  bias?: BiasContext,
  weather?: WeatherInput,
): FusedRace {
  const conditions =
    brisnetRace?.conditions ??
    ({ type: "UNKNOWN", raw: equibaseRace?.conditionsRaw ?? "" } as RaceConditions);
  const raceType = classifyRaceType(conditions);
  const isMaidenRace = raceType === "msw" || !!equibaseRace?.isMaiden;

  // Union the rosters by program number.
  const byPgm = new Map<string, { b?: BrisnetHorse; e?: EquibaseHorse; name: string }>();
  for (const b of brisnetRace?.horses ?? []) {
    byPgm.set(b.pgm, { b, name: b.name });
  }
  for (const e of equibaseRace?.horses ?? []) {
    const cur = byPgm.get(e.pgm);
    if (cur) {
      cur.e = e;
      if (e.name && e.name.length > cur.name.length) cur.name = e.name;
    } else {
      byPgm.set(e.pgm, { e, name: e.name });
    }
  }

  // First pass: compute composites.
  const interim = Array.from(byPgm.entries()).map(([pgm, slot]) => {
    const { eeas, flags } = computeEeas(slot.b, slot.e, weights.eeas);
    const eeap = computeEeap(slot.b, slot.e, weights.eeap);
    const eeac = computeEeac(slot.b, slot.e, conditions, weights.eeac);
    const mlOdds = parseMlOdds(slot.b?.ml);
    const wetWinPct = slot.b?.wetWinPct ?? slot.e?.wetWinPct ?? null;
    return { pgm, name: slot.name, b: slot.b, e: slot.e, eeas, eeap, eeac, mlOdds, wetWinPct, flags };
  });

  // Determine pace shape from EEAP distribution (who projects to be on the lead).
  const paceVals = interim.map((h) => h.eeap).filter((v): v is number => v != null);
  const maxPace = paceVals.length ? Math.max(...paceVals) : null;
  const earlyTypes = interim.filter(
    (h) => h.eeap != null && maxPace != null && h.eeap >= maxPace - 2,
  );
  const contestedPace = earlyTypes.length >= 2;
  const loneSpeedPgm = earlyTypes.length === 1 ? earlyTypes[0].pgm : null;

  // Weather factor (PR #18): only an off-track surface with REAL data adjusts
  // ratings. We collect reason codes once for the race-level summary.
  const surface = weather?.surfaceImpact ?? "unknown";
  const wetTrack = OFF_TRACK.has(surface);
  const isTurf = (conditions.surface || "").toUpperCase().includes("TURF");
  const sev = wetTrack ? weights.weather.severity[surface as "wet" | "sloppy" | "muddy"] : 0;
  const weatherReasons = new Set<string>();
  const bw = weights.bloodstock;

  const horses: FusedHorse[] = interim.map((h) => {
    const loneSpeed = h.pgm === loneSpeedPgm;
    const isEarly = earlyTypes.some((t) => t.pgm === h.pgm);
    const eeapFit = computeEeapFit(h.eeap, loneSpeed, contestedPace && !loneSpeed, bias);
    const cls = weights.classAware[raceType];
    // EEA Rating combines the composites under the rating weights, then the
    // class-aware adjuster tilts speed vs class emphasis per race type.
    const speedTerm = (h.eeas ?? 0) * weights.rating.eeas * (cls?.speed_weight ?? 1);
    const paceTerm = (eeapFit ?? h.eeap ?? 0) * weights.rating.eeap_fit * (cls?.form_weight ?? 1);
    const classTerm = (h.eeac ?? 0) * weights.rating.eeac * (cls?.class_weight ?? 1);
    const hasAny = h.eeas != null || h.eeap != null || h.eeac != null;
    let baseRating = hasAny ? speedTerm + paceTerm + classTerm : null;

    const flags = [...h.flags];
    if (loneSpeed) flags.push("projected-lone-speed");
    if (contestedPace && isEarly) flags.push("in-pace-duel");

    // ── Weather adjustment (only on off-track + real data) ────────────────
    if (wetTrack && baseRating != null) {
      // 1) Boost proven mudders, scaled by wet win % and surface severity.
      if (h.wetWinPct != null && h.wetWinPct > 0) {
        baseRating += weights.weather.mudderBoostMax * (h.wetWinPct / 100) * sev;
        flags.push("wet-track-boost");
        weatherReasons.add("mudder-boost");
      }
      // 2) Turf rained on: de-emphasize raw turf speed (turf plays differently).
      if (isTurf) {
        baseRating -= weights.weather.turfSpeedPenalty * (h.eeas ?? 0 ? 1 : 0) * sev;
        weatherReasons.add("turf-speed-deemphasized");
      }
      // 3) Sloppy/muddy dirt flattens pace: lightly favor closers over speed.
      if (!isTurf) {
        if (isEarly) {
          baseRating -= weights.weather.closerBias * sev;
          weatherReasons.add("speed-trimmed-off-track");
        } else {
          baseRating += weights.weather.closerBias * sev;
          weatherReasons.add("closer-favored-off-track");
        }
      }
    }

    // ── Bloodstock factor (PR #16 Phase 2) ────────────────────────────────
    // Compute fitness from the horse's pedigree names; apply ONLY when the
    // factor has real confidence. Stacks on top of (does not replace) the wet
    // adjustments above. Two modes:
    //   • Normal: a capped ±maxBiasPoints nudge centered on composite vs 50.
    //   • First-timer (<3 starts AND confidence ≥ medium): lean hard, treating
    //     the composite as firstTimerRatingWeight of the rating.
    const fitness = computeBloodstockFitness(
      {
        sireName: h.b?.sire?.name ?? null,
        damName: h.b?.dam?.name ?? null,
        damSireName: h.b?.damSire?.name ?? null,
        lifetimeStarts: h.b?.lifetimeStarts ?? null,
      },
      { conditions, surfaceWet: wetTrack },
      bw,
    );
    let bloodstockDelta = 0;
    const bloodstockApplied = fitness.confidence !== "none" && baseRating != null;
    if (bloodstockApplied && baseRating != null) {
      const centered = (fitness.composite - 50) / 50; // -1..+1
      const starts = h.b?.lifetimeStarts ?? null;
      const firstTimer =
        starts != null &&
        starts < bw.firstTimerStartsCutoff &&
        (fitness.confidence === "high" || fitness.confidence === "medium");

      if (firstTimer) {
        // Blend the rating toward the composite (mapped onto the rating's scale)
        // at firstTimerRatingWeight. Pedigree leads for unraced horses.
        const target = baseRating * (1 - bw.firstTimerRatingWeight) +
          (baseRating * (1 + centered * 0.5)) * bw.firstTimerRatingWeight;
        bloodstockDelta = target - baseRating;
        flags.push("first-timer-pedigree-lean");
      } else {
        bloodstockDelta = centered * bw.maxBiasPoints;
      }

      // Wet interaction: on an off track, amplify a strong wet pedigree and
      // penalize a weak one — stacking with the weather block, not replacing it.
      if (wetTrack) {
        if (fitness.wetFit >= bw.wetStrongComposite && bloodstockDelta > 0) {
          bloodstockDelta *= bw.wetBoostMultiplier;
          flags.push("wet-pedigree-boost");
        } else if (fitness.wetFit <= bw.wetWeakComposite) {
          bloodstockDelta -= bw.wetPenaltyMax * sev;
          flags.push("wet-pedigree-penalty");
        }
      }

      // Hard cap normal-mode bias at ±maxBiasPoints; first-timer mode is allowed
      // its larger swing but still bounded to keep the base rating dominant.
      const cap = firstTimer ? bw.maxBiasPoints * 4 : bw.maxBiasPoints * bw.wetBoostMultiplier;
      bloodstockDelta = Math.max(-cap, Math.min(cap, bloodstockDelta));
      baseRating += bloodstockDelta;
    }

    const bloodstockAdjustment: BloodstockAdjustment = {
      applied: bloodstockApplied,
      composite: fitness.composite,
      reasonCodes: fitness.reasonCodes,
      confidence: fitness.confidence,
      ratingDelta: Math.round(bloodstockDelta * 10) / 10,
    };

    const eeaRating = baseRating != null ? Math.round(baseRating * 10) / 10 : null;

    return {
      pgm: h.pgm,
      name: h.name,
      isMaiden: isMaidenRace,
      eeas: h.eeas,
      eeap: h.eeap,
      eeapFit,
      eeac: h.eeac,
      eeaRating,
      mlOdds: h.mlOdds,
      rank: 0,
      flags,
      bloodstockAdjustment,
    };
  });

  // Rank by EEA Rating (nulls last).
  horses.sort((a, b) => (b.eeaRating ?? -Infinity) - (a.eeaRating ?? -Infinity));
  horses.forEach((h, i) => (h.rank = i + 1));

  let shapeNote = "honest pace";
  if (loneSpeedPgm) shapeNote = `lone speed (#${loneSpeedPgm})`;
  else if (contestedPace) shapeNote = `contested pace (${earlyTypes.length} early types)`;

  const weatherAdjustment: WeatherAdjustment = {
    applied: wetTrack && weatherReasons.size > 0,
    surface,
    reasonCodes: Array.from(weatherReasons),
  };

  return {
    raceNumber: brisnetRace?.raceNumber ?? equibaseRace?.raceNumber ?? 0,
    raceType,
    conditions,
    shapeNote,
    horses,
    weatherAdjustment,
  };
}

// ── Fusion tier-tuning v2 (PR #27) ───────────────────────────────────────────
// Today's Finger Lakes deep postmortem isolated five tier-assignment failure
// modes — the soft/middle tiers were being used "as a hiding place when we
// don't have conviction". These rules tighten how RATINGS translate to TIERS;
// they never touch the underlying figure math (composites / eeaRating).
//
// They operate on a small, explicit per-horse `FusionFactors` record so each
// rule is independently unit-testable. `deriveFusionFactors` builds that record
// from what fusion already produces (flags, bloodstock fit, pace shape, class
// composites) so the live path (assignTier) can call the rules with real data.

// Pace running style. "unclear" when fusion can't separate the horse.
export type PaceRole = "E" | "EP" | "P" | "S" | "unclear";
// Letter fit grade for surface or distance aptitude (bloodstock-derived).
export type FitGrade = "A" | "B" | "C" | "D" | "F";
// Class trend over the recent form: improving (+), flat (=), declining (-).
export type ClassTrend = "+" | "=" | "-";

// The structured, per-horse handicapping factors the v2 tier rules read. Every
// field is optional/nullable so a thin card degrades gracefully — a horse with
// none of these is exactly the "lazy bucket" A5 is meant to catch.
export interface FusionFactors {
  // (A1a) Trip-context flags logged in the last 3 starts that SUPPORT the
  // rating (e.g. "needed lone speed", "wide trip last", "key trip recovery").
  tripContextFlags: string[];
  // (A1b) The pace role we logged for the horse, matched against race shape.
  paceRole: PaceRole;
  // (A1c) Has the horse EARNED class within its last 3 starts at or above the
  // current condition's class level?
  earnedClassAtLevel: boolean;
  // Letter grades for surface / distance fit (bloodstock-derived). Null = not
  // graded (no recognizable pedigree / unknown distance).
  surfaceFitGrade: FitGrade | null;
  distanceFitGrade: FitGrade | null;
  // Bloodstock "chips": did the pedigree give a positive surface / distance read?
  bloodstockSurfaceYes: boolean;
  bloodstockDistanceYes: boolean;
  // Class trend over recent form. Null = unknown.
  classTrend: ClassTrend | null;
  // Numeric pace-fit score (shape-adjusted pace), surfaced for the A3 cluster
  // re-sort. Falls back to raw eeap when eeapFit is absent.
  paceFit: number | null;
}

// Map a 0-100 bloodstock sub-fit to a letter grade (A best … F worst). Neutral
// 50 lands at C. Null in → null out (ungraded).
function fitGrade(value: number | null | undefined): FitGrade | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= 70) return "A";
  if (value >= 58) return "B";
  if (value >= 45) return "C";
  if (value >= 35) return "D";
  return "F";
}

// Does a fit grade count as "positive" (a real plus, not neutral/negative)?
function isPositiveGrade(g: FitGrade | null): boolean {
  return g === "A" || g === "B";
}

// Derive the per-horse FusionFactors map for a race from fusion output. The
// engine doesn't carry per-start past-performance lines, so trip-context and
// earned-class are inferred from the structured signals fusion DOES produce:
//   • lone-speed / pace-duel flags → trip context + pace role
//   • bloodstock surfaceFit/distanceFit → fit grades + chips
//   • eeac vs the field's class spread → a coarse class trend
// A future PR that lands true PP trip/class history can populate these directly
// without touching the rule functions.
export function deriveFusionFactors(fused: FusedRace): Map<string, FusionFactors> {
  const out = new Map<string, FusionFactors>();
  const paceVals = fused.horses
    .map((h) => h.eeapFit ?? h.eeap)
    .filter((v): v is number => v != null);
  const maxPace = paceVals.length ? Math.max(...paceVals) : null;
  const classVals = fused.horses
    .map((h) => h.eeac)
    .filter((v): v is number => v != null);
  const medianClass = median(classVals);

  for (const h of fused.horses) {
    const pace = h.eeapFit ?? h.eeap;
    const isEarly = h.flags.includes("projected-lone-speed") || h.flags.includes("in-pace-duel");
    let paceRole: PaceRole = "unclear";
    if (maxPace != null && pace != null) {
      if (pace >= maxPace - 1) paceRole = "E";
      else if (pace >= maxPace - 4) paceRole = "EP";
      else if (pace >= maxPace - 8) paceRole = "P";
      else paceRole = "S";
    }

    const tripContextFlags: string[] = [];
    if (h.flags.includes("projected-lone-speed")) tripContextFlags.push("needed lone speed");
    if (h.flags.includes("wet-track-boost")) tripContextFlags.push("proven off-track");

    // Bloodstock-derived fit grades + chips.
    const surf = h.bloodstockAdjustment;
    const surfaceFitGrade =
      surf.applied || surf.confidence !== "none"
        ? fitGrade(compositeSurface(surf))
        : null;
    const distanceFitGrade =
      surf.applied || surf.confidence !== "none"
        ? fitGrade(compositeDistance(surf))
        : null;
    const bloodstockSurfaceYes = surf.reasonCodes.some((c) => /sire-(turf|dirt)/.test(c));
    const bloodstockDistanceYes = surf.reasonCodes.some((c) => /sire-(sprint|route)/.test(c));

    // Coarse class trend: above the field median class = improving lean.
    let classTrend: ClassTrend | null = null;
    if (h.eeac != null && medianClass != null) {
      if (h.eeac >= medianClass + 3) classTrend = "+";
      else if (h.eeac <= medianClass - 3) classTrend = "-";
      else classTrend = "=";
    }

    // earned-class proxy: a top-half class figure AND not a declining trend.
    const earnedClassAtLevel =
      h.eeac != null && medianClass != null && h.eeac >= medianClass && classTrend !== "-";

    out.set(h.pgm, {
      tripContextFlags,
      paceRole,
      earnedClassAtLevel,
      surfaceFitGrade,
      distanceFitGrade,
      bloodstockSurfaceYes,
      bloodstockDistanceYes,
      classTrend,
      paceFit: pace ?? null,
    });
    void isEarly;
  }
  return out;
}

// The bloodstock composite doesn't expose surface/distance sub-fits on the
// FusedHorse adjustment (only the blended composite), so approximate the sub-
// grade from the composite + reason codes: a strong surface/distance reason
// lifts the grade above the composite floor.
function compositeSurface(adj: BloodstockAdjustment): number {
  let base = adj.composite;
  if (adj.reasonCodes.some((c) => /sire-(turf|dirt)/.test(c))) base = Math.max(base, 70);
  return base;
}
function compositeDistance(adj: BloodstockAdjustment): number {
  let base = adj.composite;
  if (adj.reasonCodes.some((c) => /sire-(sprint|route)/.test(c))) base = Math.max(base, 70);
  return base;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Default-empty factors so callers can ask a rule about a horse we have no
// structured read on (the A5 "lazy bucket" case).
export function emptyFactors(): FusionFactors {
  return {
    tripContextFlags: [],
    paceRole: "unclear",
    earnedClassAtLevel: false,
    surfaceFitGrade: null,
    distanceFitGrade: null,
    bloodstockSurfaceYes: false,
    bloodstockDistanceYes: false,
    classTrend: null,
    paceFit: null,
  };
}

// ── A1. Earned-class gate on DUAL ─────────────────────────────────────────────
// A horse may only hold DUAL TOP if at least one of:
//   (a) a logged trip-context flag in the last 3 starts supports the rating,
//   (b) the race's pace shape matches a logged pace role for the horse,
//   (c) earned class within the last 3 starts at/above the current class level.
// Otherwise the DUAL slot is not earned and the horse is downgraded.
export function canQualifyAsDual(
  _horse: FusedHorse,
  fused: FusedRace,
  factors: FusionFactors,
): boolean {
  const a = factors.tripContextFlags.length > 0;
  const b = paceRoleMatchesShape(factors.paceRole, fused.shapeNote);
  const c = factors.earnedClassAtLevel;
  return a || b || c;
}

// Does a logged pace role pay off in this race's projected shape? Lone-E in a
// paceless race, or a closer (S/P) when the pace is contested/hot, are the
// canonical "shape matches role" cases.
function paceRoleMatchesShape(role: PaceRole, shapeNote: string): boolean {
  const shape = shapeNote.toLowerCase();
  const loneSpeed = shape.includes("lone speed");
  const contested = shape.includes("contested");
  if ((role === "E" || role === "EP") && loneSpeed) return true;
  if ((role === "S" || role === "P") && contested) return true;
  return false;
}

// ── A2. Rating-gap penalty on thin top picks ──────────────────────────────────
// When #1 leads #2 by more than RATING_GAP_THRESHOLD rating points AND #1 has
// NOT earned class for that figure (no recent start at the rating's class
// level), the gap is a WARNING, not conviction → drop the tier one notch.
export const RATING_GAP_THRESHOLD = 15;

export function ratingGapPenalty(
  tier: Tier,
  leader: FusedHorse | undefined,
  second: FusedHorse | undefined,
  leaderFactors: FusionFactors,
): { tier: Tier; applied: boolean } {
  if (
    leader?.eeaRating == null ||
    second?.eeaRating == null ||
    leader.eeaRating - second.eeaRating <= RATING_GAP_THRESHOLD ||
    leaderFactors.earnedClassAtLevel
  ) {
    return { tier, applied: false };
  }
  return { tier: demoteOne(tier), applied: true };
}

// One-notch demotion ladder for the v2 rules (matches postmortem-adjustments):
// SNIPER→EDGE→DUAL→RECON→PASS. (A2 spec lists SNIPER→EDGE, EDGE→DUAL, DUAL→RECON.)
const V2_DEMOTE: Record<Tier, Tier> = {
  SNIPER: "EDGE",
  EDGE: "DUAL",
  DUAL: "RECON",
  RECON: "PASS",
  PASS: "PASS",
};
export function demoteOne(tier: Tier): Tier {
  return V2_DEMOTE[tier];
}

// ── A3. PASS-tier compression ─────────────────────────────────────────────────
// When 3+ horses sit within RATING_CLUSTER_BAND points of each other inside the
// PASS bucket, re-sort that cluster by a non-rating composite (pace fit +
// bloodstock surface fit + bloodstock distance fit). The top of the cluster, if
// it owns at least one positive non-rating factor, is promoted to RECON.
export const RATING_CLUSTER_BAND = 4;

export interface CompressionPromotion {
  pgm: string;
  compositeScore: number;
}

// Non-rating composite for the A3 re-sort. Pace fit is normalized to a small
// band so it doesn't dwarf the binary bloodstock chips.
function nonRatingComposite(f: FusionFactors): number {
  let score = 0;
  if (f.paceFit != null) score += (f.paceFit - 50) / 10; // ~ -5..+5 contribution
  if (f.bloodstockSurfaceYes) score += 1;
  if (f.bloodstockDistanceYes) score += 1;
  if (isPositiveGrade(f.surfaceFitGrade)) score += 0.5;
  if (isPositiveGrade(f.distanceFitGrade)) score += 0.5;
  return Math.round(score * 100) / 100;
}

// A horse has at least one positive non-rating factor (the promotion gate).
function hasPositiveNonRatingFactor(f: FusionFactors): boolean {
  return (
    f.bloodstockSurfaceYes ||
    f.bloodstockDistanceYes ||
    isPositiveGrade(f.surfaceFitGrade) ||
    isPositiveGrade(f.distanceFitGrade) ||
    f.tripContextFlags.length > 0 ||
    f.classTrend === "+"
  );
}

// Scan the PASS bucket for a tight rating cluster (≥3 horses within the band)
// and return the single best promotion (highest non-rating composite > 0 with a
// positive factor), or null when nothing qualifies.
export function passCompressionPromotion(
  passHorses: FusedHorse[],
  factorsByPgm: Map<string, FusionFactors>,
): CompressionPromotion | null {
  const rated = passHorses
    .filter((h) => h.eeaRating != null)
    .sort((a, b) => (b.eeaRating ?? 0) - (a.eeaRating ?? 0));
  if (rated.length < 3) return null;

  // Find the largest cluster where max-min rating <= band and size >= 3.
  let best: { members: FusedHorse[]; } | null = null;
  for (let i = 0; i < rated.length; i++) {
    const members: FusedHorse[] = [rated[i]];
    for (let j = i + 1; j < rated.length; j++) {
      if ((rated[i].eeaRating ?? 0) - (rated[j].eeaRating ?? 0) <= RATING_CLUSTER_BAND) {
        members.push(rated[j]);
      } else break;
    }
    if (members.length >= 3 && (!best || members.length > best.members.length)) {
      best = { members };
    }
  }
  if (!best) return null;

  // Re-sort the cluster by non-rating composite; promote the top if it has a
  // positive factor and a positive composite.
  const scored = best.members
    .map((h) => ({
      pgm: h.pgm,
      factors: factorsByPgm.get(h.pgm) ?? emptyFactors(),
    }))
    .map((x) => ({ pgm: x.pgm, factors: x.factors, score: nonRatingComposite(x.factors) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top && top.score > 0 && hasPositiveNonRatingFactor(top.factors)) {
    return { pgm: top.pgm, compositeScore: top.score };
  }
  return null;
}

// ── A4. Top-pick honesty check ────────────────────────────────────────────────
// "If the 2nd-best rated horse won, what visible pre-race factor would explain
// it?" Compare #2 vs #1 across six dimensions; if TWO OR MORE are clearly
// stronger for #2, fire HONESTY_CHECK and demote conviction one tier.
export interface HonestyCheckResult {
  flag: boolean;
  demotedTier: Tier | null;
  reasons: string[];
}

export function runHonestyCheck(
  _fused: FusedRace,
  tier: Tier,
  topFactors: FusionFactors,
  secondFactors: FusionFactors,
): HonestyCheckResult {
  const reasons: string[] = [];
  // pace fit
  if (
    secondFactors.paceFit != null &&
    topFactors.paceFit != null &&
    secondFactors.paceFit > topFactors.paceFit + 2
  ) {
    reasons.push("pace fit");
  }
  // surface fit
  if (gradeRank(secondFactors.surfaceFitGrade) > gradeRank(topFactors.surfaceFitGrade)) {
    reasons.push("surface fit");
  }
  // distance fit
  if (gradeRank(secondFactors.distanceFitGrade) > gradeRank(topFactors.distanceFitGrade)) {
    reasons.push("distance fit");
  }
  // bloodstock
  const secBlood = (secondFactors.bloodstockSurfaceYes ? 1 : 0) + (secondFactors.bloodstockDistanceYes ? 1 : 0);
  const topBlood = (topFactors.bloodstockSurfaceYes ? 1 : 0) + (topFactors.bloodstockDistanceYes ? 1 : 0);
  if (secBlood > topBlood) reasons.push("bloodstock");
  // trip context
  if (secondFactors.tripContextFlags.length > topFactors.tripContextFlags.length) {
    reasons.push("trip context");
  }
  // class trend
  if (trendRank(secondFactors.classTrend) > trendRank(topFactors.classTrend)) {
    reasons.push("class trend");
  }

  if (reasons.length >= 2) {
    return { flag: true, demotedTier: demoteOne(tier), reasons };
  }
  return { flag: false, demotedTier: null, reasons };
}

function gradeRank(g: FitGrade | null): number {
  switch (g) {
    case "A": return 5;
    case "B": return 4;
    case "C": return 3;
    case "D": return 2;
    case "F": return 1;
    default: return 0;
  }
}
function trendRank(t: ClassTrend | null): number {
  switch (t) {
    case "+": return 2;
    case "=": return 1;
    case "-": return 0;
    default: return -1;
  }
}

// ── A5. Soft-tier minimum content ─────────────────────────────────────────────
// Every RECON/PASS horse must carry at least one structured factor (pace role,
// surface/distance fit grade, bloodstock chip, or class trend). A horse hitting
// a soft tier with none gets a SOFT_TIER_LAZY_BUCKET flag (transparency only —
// no tier change).
export function hasAnyStructuredFactor(f: FusionFactors): boolean {
  return (
    f.paceRole !== "unclear" ||
    f.surfaceFitGrade != null ||
    f.distanceFitGrade != null ||
    f.bloodstockSurfaceYes ||
    f.bloodstockDistanceYes ||
    f.classTrend != null ||
    f.tripContextFlags.length > 0
  );
}

export function softTierLazyBucket(
  pgm: string,
  tier: Tier,
  factors: FusionFactors,
): string | null {
  if ((tier === "RECON" || tier === "PASS") && !hasAnyStructuredFactor(factors)) {
    return `SOFT_TIER_LAZY_BUCKET on #${pgm}`;
  }
  return null;
}

// ── Tier assignment ─────────────────────────────────────────────────────────
export interface TierResult {
  pgm: string;
  tier: Tier;
  sizingDollars: number;
  // Per-horse v2 transparency flags (e.g. SOFT_TIER_LAZY_BUCKET on #N). Empty
  // for horses with nothing to surface.
  flags?: string[];
}

// Race-level flags the v2 tuning rules emit (HONESTY_CHECK, the A3 promotion
// note, etc.). Surfaced so analyze-card can fold them into the race's flags[]
// for the deep postmortem to grade itself against.
export interface TierAssignment {
  tiers: TierResult[];
  raceFlags: string[];
}

const TIER_SHARE_KEY: Record<Exclude<Tier, "PASS">, keyof EeaWeights["tierSize"]> = {
  SNIPER: "SNIPER",
  EDGE: "EDGE",
  DUAL: "DUAL",
  RECON: "RECON",
};

// Assign one tier per horse for a race. SNIPER is capped at 1 per call and
// requires the leader to clear 2nd-best by >= sniperGap. Maiden races default
// their leaders to RECON. Sizing = bankroll * dailyRiskCap * tierShare.
//
// PR #27 tier-tuning v2 (A1-A5) is wired in here — this IS the live tier path
// (analyze-card calls it before the LLM handoff). Order:
//   1. base tier per the rank rules
//   2. A1 earned-class gate on the DUAL slot (downgrade if not earned)
//   3. A2 rating-gap penalty on the leader's conviction tier
//   4. A4 honesty check on the top pick (#1 vs #2 across six dimensions)
//   5. A3 PASS-cluster compression promotion (one horse PASS→RECON)
//   6. A5 lazy-bucket transparency flag on every soft-tier horse
export function assignTier(
  fused: FusedRace,
  bankroll: number,
  weights: EeaWeights,
): TierResult[] {
  return assignTierV2(fused, bankroll, weights).tiers;
}

// Full v2 assignment that also returns race-level flags. assignTier() is the
// thin back-compat wrapper that returns just the tiers.
export function assignTierV2(
  fused: FusedRace,
  bankroll: number,
  weights: EeaWeights,
): TierAssignment {
  const ranked = fused.horses.filter((h) => h.eeaRating != null);
  const dailyCap = bankroll * weights.dailyRiskCapPct;
  const size = (tier: Exclude<Tier, "PASS">) =>
    Math.round(dailyCap * weights.tierSize[TIER_SHARE_KEY[tier]]);

  const raceFlags: string[] = [];
  const flagsByPgm = new Map<string, string[]>();
  const addFlag = (pgm: string, flag: string) => {
    const arr = flagsByPgm.get(pgm) ?? [];
    arr.push(flag);
    flagsByPgm.set(pgm, arr);
  };

  if (ranked.length === 0) {
    return {
      tiers: fused.horses.map((h) => ({ pgm: h.pgm, tier: "PASS" as Tier, sizingDollars: 0 })),
      raceFlags,
    };
  }

  const factors = deriveFusionFactors(fused);
  const factorsFor = (pgm: string) => factors.get(pgm) ?? emptyFactors();

  const leader = ranked[0];
  const second = ranked[1];
  const gap = second?.eeaRating != null ? (leader.eeaRating ?? 0) - second.eeaRating : Infinity;
  const isMaiden = fused.raceType === "msw";

  const tierByPgm = new Map<string, Tier>();
  for (const h of fused.horses) {
    let tier: Tier = "PASS";
    if (h.eeaRating == null) {
      tier = "PASS";
    } else if (h.pgm === leader.pgm) {
      if (isMaiden) tier = "RECON";
      else if (gap >= weights.sniperGap) tier = "SNIPER";
      else tier = "EDGE";
    } else if (second && h.pgm === second.pgm) {
      // A1: a DUAL slot must be EARNED. If the candidate clears none of the
      // trip / pace-shape / earned-class gates, it falls out of DUAL to the
      // next-best soft tier the rank supports.
      if (isMaiden) {
        tier = "RECON";
      } else if (canQualifyAsDual(h, fused, factorsFor(h.pgm))) {
        tier = "DUAL";
      } else {
        tier = "RECON";
        const f = `A1_DUAL_DOWNGRADE on #${h.pgm} (no trip/pace/earned-class)`;
        addFlag(h.pgm, f);
        raceFlags.push(f);
      }
    } else if (h.rank === 3) {
      tier = isMaiden ? "PASS" : "RECON";
    } else {
      tier = "PASS";
    }
    tierByPgm.set(h.pgm, tier);
  }

  // A2: rating-gap penalty on the leader's conviction tier.
  const leaderTier = tierByPgm.get(leader.pgm);
  if (leaderTier && leaderTier !== "PASS") {
    const pen = ratingGapPenalty(leaderTier, leader, second, factorsFor(leader.pgm));
    if (pen.applied) {
      tierByPgm.set(leader.pgm, pen.tier);
      raceFlags.push(
        `RATING_GAP_PENALTY on #${leader.pgm} (${leaderTier}→${pen.tier}: ` +
          `${RATING_GAP_THRESHOLD}+ gap, no earned class)`,
      );
    }
  }

  // A4: top-pick honesty check (#1 vs #2). Demote conviction one tier on a
  // 2+ dimension miss and log the flag for the postmortem.
  const curLeaderTier = tierByPgm.get(leader.pgm);
  if (second && curLeaderTier && curLeaderTier !== "PASS") {
    const hc = runHonestyCheck(fused, curLeaderTier, factorsFor(leader.pgm), factorsFor(second.pgm));
    if (hc.flag && hc.demotedTier) {
      tierByPgm.set(leader.pgm, hc.demotedTier);
      raceFlags.push(
        `HONESTY_CHECK on #${leader.pgm} (${curLeaderTier}→${hc.demotedTier}: ` +
          `#${second.pgm} stronger on ${hc.reasons.join(", ")})`,
      );
    }
  }

  // A3: PASS-cluster compression — promote one buried-but-live horse to RECON.
  const passHorses = fused.horses.filter((h) => tierByPgm.get(h.pgm) === "PASS");
  const promo = passCompressionPromotion(passHorses, factors);
  if (promo) {
    tierByPgm.set(promo.pgm, "RECON");
    raceFlags.push(
      `PASS_COMPRESSION_PROMOTION on #${promo.pgm} (PASS→RECON: ` +
        `best non-rating fit in cluster, score ${promo.compositeScore})`,
    );
  }

  // A5: soft-tier minimum content — transparency flag, no tier change.
  for (const h of fused.horses) {
    const tier = tierByPgm.get(h.pgm) ?? "PASS";
    const lazy = softTierLazyBucket(h.pgm, tier, factorsFor(h.pgm));
    if (lazy) {
      addFlag(h.pgm, lazy);
      raceFlags.push(lazy);
    }
  }

  const tiers: TierResult[] = fused.horses.map((h) => {
    const tier = tierByPgm.get(h.pgm) ?? "PASS";
    const hf = flagsByPgm.get(h.pgm);
    return {
      pgm: h.pgm,
      tier,
      sizingDollars: tier === "PASS" ? 0 : size(tier),
      ...(hf && hf.length ? { flags: hf } : {}),
    };
  });

  return { tiers, raceFlags };
}

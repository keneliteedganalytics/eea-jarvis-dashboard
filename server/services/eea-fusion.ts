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

export type RaceType = "stakes_graded" | "allowance" | "claimer" | "msw";
export type Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

// Yesterday's track bias, as produced by the bias fetcher. All optional so
// fusion degrades gracefully when no bias card is available.
export interface BiasContext {
  runStyleBias?: "speed" | "closer" | "neutral" | null;
  railBias?: "good" | "bad" | "neutral" | null;
  note?: string | null;
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

// ── Tier assignment ─────────────────────────────────────────────────────────
export interface TierResult {
  pgm: string;
  tier: Tier;
  sizingDollars: number;
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
export function assignTier(
  fused: FusedRace,
  bankroll: number,
  weights: EeaWeights,
): TierResult[] {
  const ranked = fused.horses.filter((h) => h.eeaRating != null);
  const dailyCap = bankroll * weights.dailyRiskCapPct;
  const size = (tier: Exclude<Tier, "PASS">) =>
    Math.round(dailyCap * weights.tierSize[TIER_SHARE_KEY[tier]]);

  const results: TierResult[] = [];
  if (ranked.length === 0) {
    return fused.horses.map((h) => ({ pgm: h.pgm, tier: "PASS" as Tier, sizingDollars: 0 }));
  }

  const leader = ranked[0];
  const second = ranked[1];
  const gap = second?.eeaRating != null ? (leader.eeaRating ?? 0) - second.eeaRating : Infinity;
  const isMaiden = fused.raceType === "msw";

  for (const h of fused.horses) {
    let tier: Tier = "PASS";
    if (h.eeaRating == null) {
      tier = "PASS";
    } else if (h.pgm === leader.pgm) {
      if (isMaiden) tier = "RECON";
      else if (gap >= weights.sniperGap) tier = "SNIPER";
      else tier = "EDGE";
    } else if (second && h.pgm === second.pgm) {
      tier = isMaiden ? "RECON" : "DUAL";
    } else if (h.rank === 3) {
      tier = isMaiden ? "PASS" : "RECON";
    } else {
      tier = "PASS";
    }
    results.push({
      pgm: h.pgm,
      tier,
      sizingDollars: tier === "PASS" ? 0 : size(tier),
    });
  }
  return results;
}

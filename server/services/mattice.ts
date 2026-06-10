// Mattice 5-factor overlay scorer (PR #51).
//
// Dave Mattice has been Finger Lakes' (FLGR) primary track handicapper since
// 2001. There is no published win-rate or audited scorecard for him; the design
// intent here is NOT to reproduce his picks but to encode his FRAMEWORK as an
// independent overlay signal and then "let data earn the weight" — log every
// prediction, auto-grade it, and only blend it into the primary score once its
// measured edge clears a threshold (see mattice-weight.ts).
//
// Mattice's 5 factors (verbatim from the user — preserve):
//   1. Pace & Running Styles — dueling speed vs lone pacesetter that can steal the lead
//   2. Speed Figures — lifetime top speeds + most recent figures to measure current form
//   3. Class Levels — dropping down (easier claiming/allowance) vs stepping up where outmatched
//   4. Connections — recent success, win %, stats of jockeys and trainers
//   5. Form & Habits — recent results, workouts, excuse lines (bumped, off track)
//
// Each factor returns { score 0-20, signal positive|neutral|negative, evidence }.
// matticeScore = sum of the five (0-100). vetoFlag = 2+ factors "negative".
//
// SCORING PHILOSOPHY: the scorer is DETERMINISTIC by default. It derives each
// factor from the per-horse data already fused into the card (the same preserved
// FusedHorse fields the fusion-replay path reconstructs from) measured RELATIVE
// to the field. This keeps the overlay testable, reproducible, and free of any
// live web dependency. An optional LLM enrichment pass (Anthropic, the client
// already wired into the dashboard) can refine the evidence strings, but it
// never changes whether a horse vetoes — the numeric verdict is the engine's.

import type {
  MatticeFactor,
  MatticeFactorKey,
  MatticeHorseScore,
  MatticeSignal,
} from "@shared/schema";
import { MATTICE_FACTOR_KEYS } from "@shared/schema";
import type { FusedHorse } from "./eea-fusion";

// Each factor is capped at 20; five factors → 0-100.
export const FACTOR_MAX = 20;
export const FACTOR_COUNT = 5;
export const MATTICE_MAX = FACTOR_MAX * FACTOR_COUNT;
// 2+ negative factors veto the horse.
export const VETO_NEGATIVE_THRESHOLD = 2;
// "Mattice Confirmed" badge gate (see overlay): score ≥ 75 and no veto.
export const CONFIRMED_SCORE = 75;

// A single horse's inputs, distilled from the fused card. Everything is relative
// to the field, which is passed alongside so each factor can rank the horse.
export interface MatticeHorseInput {
  pgm: string;
  name: string;
  eeas: number | null; // speed composite
  eeap: number | null; // pace composite (shape-adjusted)
  eeac: number | null; // class composite
  eeaRating: number | null; // overall fused rating
  mlOdds: number | null; // decimal morning-line
  flags: string[]; // fusion pace-shape flags (projected-lone-speed, in-pace-duel, ...)
  bloodstockApplied: boolean;
  bloodstockReasons: string[];
}

// Field-level context so each factor can be scored relative to the other runners.
interface FieldContext {
  speed: number[];
  pace: number[];
  klass: number[];
  rating: number[];
}

// Map a fused horse to the scorer's input shape. eeapFit is the shape-adjusted
// pace; we prefer it (matching analyze-card's persistence of `eeapFit ?? eeap`).
export function inputFromFusedHorse(h: FusedHorse): MatticeHorseInput {
  return {
    pgm: h.pgm,
    name: h.name,
    eeas: h.eeas,
    eeap: h.eeapFit ?? h.eeap,
    eeac: h.eeac,
    eeaRating: h.eeaRating,
    mlOdds: h.mlOdds,
    flags: h.flags ?? [],
    bloodstockApplied: h.bloodstockAdjustment?.applied ?? false,
    bloodstockReasons: h.bloodstockAdjustment?.reasonCodes ?? [],
  };
}

function nums(vals: (number | null)[]): number[] {
  return vals.filter((v): v is number => v != null && Number.isFinite(v));
}

// Percentile rank of `v` within `arr` (0..1). 1 = best (highest) in field.
function percentile(v: number | null, arr: number[]): number | null {
  if (v == null || arr.length === 0) return null;
  const below = arr.filter((x) => x < v).length;
  const equal = arr.filter((x) => x === v).length;
  return (below + equal / 2) / arr.length;
}

// Convert a 0..1 percentile to a 0-20 factor score. null percentile (no field
// data) → a neutral 10. Three signal bands: bottom third negative, top third
// positive, middle neutral.
function bandFromPercentile(p: number | null): { score: number; signal: MatticeSignal } {
  if (p == null) return { score: 10, signal: "neutral" };
  const score = Math.round(p * FACTOR_MAX);
  let signal: MatticeSignal = "neutral";
  if (p >= 0.66) signal = "positive";
  else if (p <= 0.33) signal = "negative";
  return { score: Math.max(0, Math.min(FACTOR_MAX, score)), signal };
}

// ── Factor 1: Pace & Running Styles ────────────────────────────────────────
// Mattice's headline edge: a lone pacesetter that can steal the lead vs a horse
// caught in a speed duel. We read the fusion pace-shape flags (projected-lone-
// speed / in-pace-duel) on top of the relative pace figure.
function scorePace(h: MatticeHorseInput, field: FieldContext): MatticeFactor {
  const p = percentile(h.eeap, field.pace);
  let { score, signal } = bandFromPercentile(p);
  let evidence: string;
  if (h.flags.includes("projected-lone-speed")) {
    score = Math.min(FACTOR_MAX, score + 6);
    signal = "positive";
    evidence = `Projected lone speed — can steal the lead uncontested (fusion pace shape, #${h.pgm}).`;
  } else if (h.flags.includes("in-pace-duel")) {
    score = Math.max(0, score - 6);
    signal = "negative";
    evidence = `Caught in a speed duel — pace pressure compromises the run (fusion pace shape, #${h.pgm}).`;
  } else if (p != null) {
    evidence = `Pace figure in the ${Math.round(p * 100)}th percentile of the field (EEA pace).`;
  } else {
    evidence = "No usable pace figure; treated as neutral running style.";
  }
  return { score, signal, evidence };
}

// ── Factor 2: Speed Figures ────────────────────────────────────────────────
// Lifetime tops + most-recent form, distilled into the EEA speed composite,
// scored relative to the field.
function scoreSpeed(h: MatticeHorseInput, field: FieldContext): MatticeFactor {
  const p = percentile(h.eeas, field.speed);
  const { score, signal } = bandFromPercentile(p);
  const evidence =
    p != null
      ? `Speed figure ranks ${Math.round(p * 100)}th percentile of the field (EEA speed composite).`
      : "No speed figure on file; treated as neutral.";
  return { score, signal, evidence };
}

// ── Factor 3: Class Levels ─────────────────────────────────────────────────
// Dropping into an easier spot vs stepping up where outmatched. The EEA class
// composite captures earned class relative to today's company.
function scoreClass(h: MatticeHorseInput, field: FieldContext): MatticeFactor {
  const p = percentile(h.eeac, field.klass);
  const { score, signal } = bandFromPercentile(p);
  let evidence: string;
  if (p != null && p >= 0.66) {
    evidence = `Class edge — ranks ${Math.round(p * 100)}th percentile, looks to be dropping into a soft spot (EEA class).`;
  } else if (p != null && p <= 0.33) {
    evidence = `Class deficit — ${Math.round(p * 100)}th percentile, may be stepping up where outmatched (EEA class).`;
  } else {
    evidence =
      p != null
        ? `Class roughly par for the field (${Math.round(p * 100)}th percentile, EEA class).`
        : "No class read available; treated as neutral.";
  }
  return { score, signal, evidence };
}

// ── Factor 4: Connections ──────────────────────────────────────────────────
// Recent jockey/trainer success. We don't have a standalone connections feed in
// the preserved snapshot, so we proxy it with the market's read (morning-line
// odds): sharp connections + live horse compress the price. A short price is a
// positive connection signal; a longshot is a negative one. This is an explicit
// proxy and the evidence says so.
function scoreConnections(h: MatticeHorseInput): MatticeFactor {
  const ml = h.mlOdds;
  if (ml == null) {
    return {
      score: 10,
      signal: "neutral",
      evidence: "No morning line to read the connections/market signal; treated as neutral.",
    };
  }
  // 8/5 or shorter → strong; 3-1..6-1 → live; 8-1..15-1 → weak; 20-1+ → cold.
  let score: number;
  let signal: MatticeSignal;
  if (ml <= 1.6) {
    score = 18;
    signal = "positive";
  } else if (ml <= 4) {
    score = 14;
    signal = "positive";
  } else if (ml <= 6) {
    score = 11;
    signal = "neutral";
  } else if (ml <= 9) {
    score = 8;
    signal = "neutral";
  } else if (ml <= 15) {
    score = 5;
    signal = "negative";
  } else {
    score = 3;
    signal = "negative";
  }
  return {
    score,
    signal,
    evidence: `Morning line ${ml}-1 — market proxy for jockey/trainer support (no standalone connections feed in snapshot).`,
  };
}

// ── Factor 5: Form & Habits ────────────────────────────────────────────────
// Recent results, workouts, excuse lines. We approximate current form from the
// overall fused rating's standing in the field, nudged by any bloodstock/wet
// signal that fusion surfaced (a recognized positive habit/pattern).
function scoreForm(h: MatticeHorseInput, field: FieldContext): MatticeFactor {
  const p = percentile(h.eeaRating, field.rating);
  let { score, signal } = bandFromPercentile(p);
  let evidence =
    p != null
      ? `Overall form ranks ${Math.round(p * 100)}th percentile of the field (fused EEA rating).`
      : "No fused rating; form treated as neutral.";
  if (h.bloodstockApplied && h.bloodstockReasons.length > 0) {
    score = Math.min(FACTOR_MAX, score + 2);
    if (signal === "negative") signal = "neutral";
    evidence += ` Bloodstock/pattern note: ${h.bloodstockReasons.slice(0, 2).join(", ")}.`;
  }
  return { score, signal, evidence };
}

function buildField(inputs: MatticeHorseInput[]): FieldContext {
  return {
    speed: nums(inputs.map((h) => h.eeas)),
    pace: nums(inputs.map((h) => h.eeap)),
    klass: nums(inputs.map((h) => h.eeac)),
    rating: nums(inputs.map((h) => h.eeaRating)),
  };
}

// Score one horse against the field. Pure + deterministic.
export function scoreHorse(h: MatticeHorseInput, field: FieldContext): MatticeHorseScore {
  const factors: Record<MatticeFactorKey, MatticeFactor> = {
    pace: scorePace(h, field),
    speed: scoreSpeed(h, field),
    class: scoreClass(h, field),
    connections: scoreConnections(h),
    form: scoreForm(h, field),
  };
  const matticeScore = MATTICE_FACTOR_KEYS.reduce((sum, k) => sum + factors[k].score, 0);
  const negatives = MATTICE_FACTOR_KEYS.filter((k) => factors[k].signal === "negative").length;
  return {
    programNumber: h.pgm,
    horseName: h.name,
    matticeScore,
    vetoFlag: negatives >= VETO_NEGATIVE_THRESHOLD,
    factors,
    source: "deterministic",
  };
}

// Score every horse in a race (deterministic engine). This is the entry point
// the overlay + backfill call. The LLM enrichment (enrichEvidence) is optional
// and layered on top by callers that want it; it never alters the numeric verdict.
export function scoreRace(inputs: MatticeHorseInput[]): MatticeHorseScore[] {
  const field = buildField(inputs);
  return inputs.map((h) => scoreHorse(h, field));
}

// Convenience: score directly from fused horses.
export function scoreFusedHorses(horses: FusedHorse[]): MatticeHorseScore[] {
  return scoreRace(horses.map(inputFromFusedHorse));
}

// The horse with the highest mattice score (Mattice's OWN top pick). Ties broken
// by fewer vetoes then program number for determinism. Null on an empty field.
export function matticeTopPick(scores: MatticeHorseScore[]): MatticeHorseScore | null {
  if (scores.length === 0) return null;
  return [...scores].sort((a, b) => {
    if (b.matticeScore !== a.matticeScore) return b.matticeScore - a.matticeScore;
    if (a.vetoFlag !== b.vetoFlag) return a.vetoFlag ? 1 : -1;
    return Number(a.programNumber) - Number(b.programNumber);
  })[0];
}

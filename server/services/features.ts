// Brisnet deep-field computed features (PR #28b, spec §3).
//
// Twelve per-runner-per-race signals derived from the parsed Ultimate PP deep
// model (parsers/brisnet-deep.ts). Each score is 0-100 except honesty_check
// (bool). Every feature PRESENCE-GATES: if the deep fields it needs are absent
// it returns null rather than a faked midpoint, so a thin/DRM-only card yields
// fewer signals instead of biased ones. Fusion v3 (fusion-v3.ts) blends the
// non-null scores; nulls drop out of the weighted sum.
//
// Pure module: no I/O, no DB. Inputs are the typed deep model + per-race
// context (pars, bias, the field of other runners). This is what lets the
// feature tests snapshot exact values on reference horses.

import type {
  DeepRunner,
  DeepRace,
  TrackBiasSnapshot,
  DeepRacePars,
  RunStyle,
  SampleFlag,
} from "./parsers/brisnet-deep";

export interface RunnerFeatures {
  pace_fit_score: number | null;
  class_earned_score: number | null;
  trip_compromised_score: number | null;
  bias_match_score: number | null;
  jt_hot_score: number | null;
  trainer_angle_score: number | null;
  work_sharp_score: number | null;
  form_curve_score: number | null;
  dist_surf_form_score: number | null;
  conditions_pedigree_score: number | null;
  layoff_score: number | null;
  honesty_check: boolean;
}

// The six non-Prime-Power dimensions the honesty check compares #1 vs #2 on.
export const HONESTY_DIMENSIONS: (keyof RunnerFeatures)[] = [
  "pace_fit_score",
  "class_earned_score",
  "jt_hot_score",
  "trainer_angle_score",
  "dist_surf_form_score",
  "bias_match_score",
];

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

// MEET-scope bias is the default lens; fall back to WEEK if MEET absent.
function pickBias(bias: TrackBiasSnapshot[]): TrackBiasSnapshot | null {
  return bias.find((b) => b.scope === "MEET") ?? bias.find((b) => b.scope === "WEEK") ?? null;
}

// ── pace_fit_score ───────────────────────────────────────────────────────────
// Blend of (a) horse early/late pace vs par and (b) the race's projected pace
// shape. A lone-E runner on a field with no other early speed gets a big lift;
// a horse buried in a speed duel gets docked.
export function paceFitScore(runner: DeepRunner, race: DeepRace): number | null {
  const s = runner.summary;
  const pars = race.pars;
  const e1 = s.bestPaceE1 ?? s.avgDsE1 ?? s.earlyPaceLastRace;
  const e2 = s.bestPaceE2 ?? s.avgDsE2;
  const lp = s.bestPaceLp ?? s.avgDsLate ?? s.latePaceLastRace;
  if (e1 == null && lp == null) return null;

  // Component 1: figure vs par (50 = at par, scaled ±2.5 pts per fig point).
  const vsPar = (fig: number | null, par: number | null): number | null => {
    if (fig == null || par == null) return null;
    return clamp(50 + (fig - par) * 2.5);
  };
  const parComponents = [
    vsPar(e1, pars.parE1),
    vsPar(e2, pars.parE2Late),
    vsPar(lp, pars.parE2Late),
  ].filter((x): x is number => x != null);
  const parScore = parComponents.length
    ? parComponents.reduce((a, b) => a + b, 0) / parComponents.length
    : 50;

  // Component 2: pace-shape advantage from run style + field early-speed count.
  const shapeScore = paceShapeAdvantage(runner, race);

  return clamp(Math.round(parScore * 0.6 + shapeScore * 0.4));
}

// How favorable the projected pace shape is for THIS runner's style. Counts the
// field's early-pressure horses (E + high early-speed-points). A lone speed gets
// ~90; a closer into a lone-speed setup gets docked; a presser into a hot duel
// gets a small lift.
function paceShapeAdvantage(runner: DeepRunner, race: DeepRace): number {
  const style = runner.header.runStyle;
  const earlyHorses = race.runners.filter((h) => {
    const st = h.header.runStyle;
    const pts = h.header.earlySpeedPoints ?? 0;
    return st === "E" || st === "E/P" || pts >= 6;
  });
  const myEarlyPts = runner.header.earlySpeedPoints ?? 0;
  const isEarly = style === "E" || style === "E/P" || myEarlyPts >= 6;
  const otherEarly = earlyHorses.filter((h) => h.programNumber !== runner.programNumber).length;

  if (isEarly) {
    if (otherEarly === 0) return 92; // lone speed
    if (otherEarly === 1) return 68; // one rival, controllable
    return 38; // speed duel — gets compromised
  }
  // closer / presser
  if (otherEarly >= 2) return 72; // pace meltdown to run at
  if (otherEarly === 1) return 56;
  return 40; // lone-speed setup is bad for a closer
}

// ── class_earned_score ───────────────────────────────────────────────────────
// CR (performance vs field faced) weighted with prev Race Ratings and ACL, with
// a bonus when the ACL was earned at today's distance/surface.
export function classEarnedScore(runner: DeepRunner): number | null {
  const s = runner.summary;
  const cr = s.currentClass ?? s.avgClassLast3;
  const rr = [s.prevRr1, s.prevRr2, s.prevRr3].filter((x): x is number => x != null);
  const acl = s.acl;
  if (cr == null && rr.length === 0 && acl == null) return null;

  const parts: { v: number; w: number }[] = [];
  if (cr != null) parts.push({ v: clamp(cr), w: 0.4 });
  if (rr.length) {
    const rrAvg = rr.reduce((a, b) => a + b, 0) / rr.length;
    parts.push({ v: clamp(rrAvg), w: 0.35 });
  }
  if (acl != null) parts.push({ v: clamp(acl), w: 0.25 });
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  let score = parts.reduce((a, p) => a + p.v * p.w, 0) / (wsum || 1);

  if (acl != null && s.aclDistSurfMatch) score += 5; // earned at today's d/s
  return clamp(Math.round(score));
}

// ── trip_compromised_score ─────────────────────────────────────────────────--
// Scans trip-comment keywords on the last 1-2 past lines. A compromised trip
// (traffic, steadied, wide, blocked) on a recent line means the raw finish
// understates true ability — a HIGH score = "give this one a pass / upgrade".
const TROUBLE_WORDS = [
  "steadied", "blocked", "checked", "traffic", "shut off", "taken up",
  "boxed", "wide", "swung wide", "no room", "bumped", "clipped", "altered",
];
export function tripCompromisedScore(runner: DeepRunner): number | null {
  const lines = runner.pastLines.slice(0, 2);
  if (lines.length === 0) return null;
  let score = 0;
  lines.forEach((pl, idx) => {
    const c = (pl.comment ?? "").toLowerCase();
    if (!c) return;
    const hits = TROUBLE_WORDS.filter((w) => c.includes(w)).length;
    if (hits === 0) return;
    // recency weight: last race counts double the one before
    const recencyW = idx === 0 ? 1.0 : 0.5;
    // a beaten-but-troubled finish is the strongest upgrade signal
    const beaten = (pl.finLengths ?? 0) > 0.5 ? 1.2 : 0.8;
    score += Math.min(hits * 25, 50) * recencyW * beaten;
  });
  if (score === 0) return 0;
  return clamp(Math.round(score));
}

// ── bias_match_score ─────────────────────────────────────────────────────────
// Run-style IV vs today's Track Bias, blended with the post-position bias for
// the horse's likely draw. ++ dominant style → 100, + favorable → 75,
// neutral → 50, negative → 25.
export function biasMatchScore(runner: DeepRunner, race: DeepRace): number | null {
  const bias = pickBias(race.bias);
  if (!bias) return null;
  const style = runner.header.runStyle;
  if (style == null || style === "NA") return null;

  let styleScore: number;
  if (bias.dominantStyle && bias.dominantStyle === style) {
    styleScore = 100;
  } else if (bias.favorableStyles.includes(style)) {
    styleScore = 75;
  } else {
    // use IV for the style if present: >1.2 favorable, <0.8 negative
    const iv = styleIv(bias, style);
    if (iv == null) styleScore = 50;
    else if (iv >= 1.2) styleScore = 75;
    else if (iv <= 0.8) styleScore = 25;
    else styleScore = 50;
  }

  // post bias: use the most recent past-line post as a proxy for likely draw.
  const post = runner.pastLines[0]?.post ?? null;
  const postScore = postBiasScore(bias, post);
  if (postScore == null) return styleScore;
  return clamp(Math.round(styleScore * 0.7 + postScore * 0.3));
}

function styleIv(b: TrackBiasSnapshot, style: RunStyle): number | null {
  switch (style) {
    case "E": return b.ivE;
    case "E/P": return b.ivEp;
    case "P": return b.ivP;
    case "S": return b.ivS;
    default: return null;
  }
}

function postBiasScore(b: TrackBiasSnapshot, post: number | null): number | null {
  if (post == null) return null;
  let iv: number | null;
  if (post === 1) iv = b.ivRail ?? b.iv1_3;
  else if (post <= 3) iv = b.iv1_3;
  else if (post <= 7) iv = b.iv4_7;
  else iv = b.iv8plus;
  if (iv == null) return null;
  if (iv >= 1.2) return 80;
  if (iv >= 1.0) return 60;
  if (iv >= 0.8) return 45;
  return 25;
}

// ── jt_hot_score ───────────────────────────────────────────────────────────--
// Jockey/Trainer L60-combo ITM% + ROI, with a minimum-sample gate. Falls back to
// the jockey's year ITM%/ROI when the combo sample is too thin.
export function jtHotScore(runner: DeepRunner): number | null {
  const j = runner.jockey;
  const combo = j.trnL60Mounts != null && j.trnL60Mounts >= 10;
  let itm: number | null;
  let roi: number | null;
  if (combo) {
    itm = j.trnL60ItmPct;
    roi = j.trnL60Roi;
  } else {
    itm = j.yearItmPct;
    roi = j.yearRoi;
  }
  if (itm == null && roi == null) return null;

  // ITM% mapped 0-100 (40% ITM ≈ 70). ROI re-centred (0 ROI = neutral 50).
  const itmScore = itm != null ? clamp(itm * 1.6) : 50;
  const roiScore = roi != null ? clamp(50 + roi * 80) : 50;
  return clamp(Math.round(itmScore * 0.6 + roiScore * 0.4));
}

// ── trainer_angle_score ──────────────────────────────────────────────────────
// Sum of fired trainer-angle ROI weights for today's pattern. Only angles that
// fire today are present in angles3yr (the parser only emits pertinent ones).
export function trainerAngleScore(runner: DeepRunner): number | null {
  const angles = runner.trainer.angles3yr;
  const keys = Object.keys(angles);
  if (keys.length === 0) return null;

  let best = 0;
  let any = false;
  for (const k of keys) {
    const a = angles[k];
    if (a.starts == null || a.starts < 15) continue; // min sample
    if (a.roi == null && a.winPct == null) continue;
    any = true;
    const roiScore = a.roi != null ? clamp(50 + a.roi * 80) : 50;
    const winScore = a.winPct != null ? clamp(a.winPct * 3) : 50;
    const angleScore = roiScore * 0.6 + winScore * 0.4;
    best = Math.max(best, angleScore);
  }
  if (!any) return null;
  return clamp(Math.round(best));
}

// ── work_sharp_score ───────────────────────────────────────────────────────--
// Bullets + sharp breeze ranks + gate-work signal. Recent (≤14d) bullet from
// the gate is the strongest sharpness tell.
export function workSharpScore(runner: DeepRunner): number | null {
  const works = runner.workouts;
  if (works.length === 0) return null;
  let score = 40; // baseline: has works
  for (const w of works) {
    if (w.bullet) score += 22;
    if (w.rankPosition != null && w.rankTotal != null && w.rankTotal > 0) {
      const pctile = 1 - (w.rankPosition - 1) / w.rankTotal;
      score += pctile * 12; // top of the tab adds up to 12
    }
    if (w.fromGate) score += 6;
  }
  return clamp(Math.round(score));
}

// ── form_curve_score ───────────────────────────────────────────────────────--
// Slope of the last-4 final-speed figures (most recent first). An improving
// curve scores high; a declining curve low. Dist/surf-matched figures count
// for more.
export function formCurveScore(runner: DeepRunner): number | null {
  const s = runner.summary;
  const seq = [s.finalSpd1, s.finalSpd2, s.finalSpd3, s.finalSpd4].filter(
    (x): x is number => x != null,
  );
  if (seq.length < 2) {
    // single figure: anchor off speedLastRace vs backSpeed if present
    if (s.speedLastRace != null && s.backSpeed != null) {
      return clamp(Math.round(55 + (s.speedLastRace - s.backSpeed) * 3));
    }
    return null;
  }
  // seq[0] is most recent. positive (recent − oldest) = improving.
  const recent = seq[0];
  const oldest = seq[seq.length - 1];
  const slope = recent - oldest;
  let score = 55 + slope * 4;
  // a high absolute most-recent figure lifts the floor
  score += (recent - 80) * 0.4;
  return clamp(Math.round(score));
}

// ── dist_surf_form_score ───────────────────────────────────────────────────--
// Avg Dist/Surf SPD scaled by the sample-flag multiplier
// (asterisk=1.0, none=0.8, parens=0.5). The flagship feature: it rewards proven
// form at today's exact distance & surface and discounts thin samples.
export function distSurfFormScore(runner: DeepRunner): number | null {
  const s = runner.summary;
  if (s.avgDsSpd == null) return null;
  const mult = sampleMultiplier(s.avgDsSampleFlag);
  // map SPD to 0-100: a 90 SPD ≈ 90 here, scaled by sample confidence
  const base = clamp(s.avgDsSpd);
  return clamp(Math.round(base * mult));
}

export function sampleMultiplier(flag: SampleFlag | null): number {
  switch (flag) {
    case "ASTERISK": return 1.0;
    case "NONE": return 0.8;
    case "PARENS": return 0.5;
    default: return 0.8; // unflagged → treat as the medium (single-race) case
  }
}

// ── conditions_pedigree_score ──────────────────────────────────────────────--
// Fired by today's surface/condition. Wet dirt → sire-mud% + ped_off. Turf →
// ped_turf + sire-turf%. Distance stretch/cutback vs sire AWD. Returns null on
// a dry-dirt sprint with no firing condition (nothing pedigree-specific to say).
export function conditionsPedigreeScore(
  runner: DeepRunner,
  race: DeepRace,
  trackCondition?: string | null,
): number | null {
  const h = runner.header;
  const surface = (race.surface ?? "").toUpperCase();
  const cond = (trackCondition ?? "").toLowerCase();
  const isWet = ["my", "sy", "gd", "wf", "sl", "hy"].includes(cond);
  const isTurf = surface.includes("TURF");

  const parts: number[] = [];
  if (isWet) {
    if (h.sireMudPct != null) parts.push(clamp(h.sireMudPct * 3)); // 18% mud ≈ 54
    if (h.pedOff != null) parts.push(clamp(50 + (h.pedOff - 1) * 100));
  }
  if (isTurf) {
    if (h.pedTurf != null) parts.push(clamp(50 + (h.pedTurf - 1) * 100));
    if (h.sireTurfPct != null) parts.push(clamp(h.sireTurfPct * 3));
  }
  // distance aptitude vs sire AWD always fires when both present
  if (h.pedDistance != null && race.distanceFurlongs != null) {
    parts.push(clamp(50 + (h.pedDistance - 1) * 120));
  }
  if (parts.length === 0) return null;
  return clamp(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length));
}

// ── layoff_score ───────────────────────────────────────────────────────────--
// Days-since-last-race bucketed, multiplied by the trainer's layoff angle ROI
// and the layoff-dot count. A fresh horse off a short layoff with a hot layoff-
// angle trainer scores high; a horse coming off a long, unsupported layoff low.
export function layoffScore(runner: DeepRunner): number | null {
  const s = runner.summary;
  const days = s.daysSinceLr;
  if (days == null) return null;

  let base: number;
  if (days <= 14) base = 70; // sharp, recent
  else if (days <= 35) base = 62; // normal
  else if (days <= 75) base = 50; // short freshening
  else if (days <= 180) base = 40; // layoff
  else base = 30; // long layoff

  const layoffAngle = runner.trainer.angles3yr["layoff"];
  if (layoffAngle && layoffAngle.starts != null && layoffAngle.starts >= 15 && layoffAngle.roi != null) {
    base += clamp(layoffAngle.roi * 60, -20, 25);
  }
  // layoff dots: brisnet flags 1-2 prior layoffs the horse has already handled
  if (s.layoffCount != null && days > 75) {
    base += s.layoffCount * 6; // has shown it can run off a layoff
  }
  return clamp(Math.round(base));
}

// ── compute all ──────────────────────────────────────────────────────────────
// Honesty check is computed at the race level (needs #1 vs #2), so the
// per-runner pass leaves it false; computeRaceFeatures fills it in.
export function computeRunnerFeatures(
  runner: DeepRunner,
  race: DeepRace,
  trackCondition?: string | null,
): RunnerFeatures {
  return {
    pace_fit_score: paceFitScore(runner, race),
    class_earned_score: classEarnedScore(runner),
    trip_compromised_score: tripCompromisedScore(runner),
    bias_match_score: biasMatchScore(runner, race),
    jt_hot_score: jtHotScore(runner),
    trainer_angle_score: trainerAngleScore(runner),
    work_sharp_score: workSharpScore(runner),
    form_curve_score: formCurveScore(runner),
    dist_surf_form_score: distSurfFormScore(runner),
    conditions_pedigree_score: conditionsPedigreeScore(runner, race, trackCondition),
    layoff_score: layoffScore(runner),
    honesty_check: false,
  };
}

// honesty_check is "does #2 beat the top pick on ≥2 of the six non-Prime-Power
// dimensions". top/second are the program numbers of the field's ranked 1 & 2
// (by the caller's ranking — fusion v3 ranks by composite). Returns the set of
// dimensions #2 won, so the postmortem can name them.
export function honestyCheck(
  topFeatures: RunnerFeatures,
  secondFeatures: RunnerFeatures,
): { flagged: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const dim of HONESTY_DIMENSIONS) {
    const a = topFeatures[dim];
    const b = secondFeatures[dim];
    if (typeof a === "number" && typeof b === "number" && b > a + 3) {
      reasons.push(dim.replace(/_score$/, ""));
    }
  }
  return { flagged: reasons.length >= 2, reasons };
}
